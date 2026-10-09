// Создание отдельных ресурсов в проекте («собрать самому»): репозиторий, базы, сервис Render, Telegram-бот.
// Долгое (база Supabase, сервис Render) идёт в фоне тем же Workflow, что и создание проекта по рецепту.
import type { LimitKey, NewResourceKind, Project, ProviderId } from "../shared/types";
import type { Store } from "./db";
import { accountParam, buildContext } from "./engine";
import { blockingLimits, describeLimit } from "./limits";
import { cloudflareConsole } from "./providers/cloudflare";
import { Telegram } from "./providers/telegram";
import type { RenderRegion } from "./providers/render";
import { createServiceWhenRepoVisible } from "./recipes/render-service";
import { createSupabaseDatabase } from "./recipes/supabase-db";
import type { ProvisionContext } from "./recipes/types";
import { UserError, requireProject } from "./service";

export interface ResourceTask {
  kind: NewResourceKind;
  params: Record<string, string>;
}

interface Builder {
  title: string;
  providers: ProviderId[];
  needs: LimitKey[];
  /** Быстрые задачи выполняются сразу, долгие — в фоне. */
  background: boolean;
  validate?(params: Record<string, string>): string | null;
  run(ctx: ProvisionContext, params: Record<string, string>): Promise<void>;
}

const NAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const SUPABASE_REGIONS = ["emea", "americas", "apac"];
const RENDER_REGIONS: RenderRegion[] = ["frankfurt", "virginia", "oregon", "ohio", "singapore"];

const BUILDERS: Record<Exclude<NewResourceKind, "telegram-bot">, Builder> = {
  "github-repo": {
    title: "репозиторий GitHub",
    providers: ["github"],
    needs: [],
    background: false,
    validate: (p) => (NAME.test(p.name ?? "") ? null : "Имя репозитория: латиница в нижнем регистре, цифры, дефис"),
    async run(ctx, p) {
      const gh = ctx.github();
      await ctx.log(`Создаю репозиторий ${p.name}…`);
      const repo = await gh.client.createRepo({
        name: p.name,
        description: `Создано в apphub для проекта ${ctx.project.name}`,
        private: p.visibility !== "public",
      });
      await ctx.addResource({
        type: "github.repo",
        kind: "repo",
        name: repo.full_name,
        externalId: repo.full_name,
        url: repo.html_url,
        consoleUrl: repo.html_url,
        meta: { branch: repo.default_branch },
      });
    },
  },

  "supabase-db": {
    title: "база Supabase",
    providers: ["supabase"],
    needs: ["supabase.projects"],
    background: true,
    validate: (p) => (SUPABASE_REGIONS.includes(p.region) ? null : "Некорректный регион"),
    async run(ctx, p) {
      await createSupabaseDatabase(ctx, p.region);
    },
  },

  "d1-db": {
    title: "база Cloudflare D1",
    providers: ["cloudflare"],
    needs: ["cloudflare.d1.count", "cloudflare.d1.storage"],
    background: false,
    validate: (p) => (NAME.test(p.name ?? "") ? null : "Имя базы: латиница в нижнем регистре, цифры, дефис"),
    async run(ctx, p) {
      const cf = ctx.cloudflare();
      await ctx.log(`Создаю базу D1 ${p.name}…`);
      const db = await cf.client.createD1(p.name);
      await ctx.addResource({
        type: "cloudflare.d1",
        kind: "database",
        name: db.name,
        externalId: db.uuid,
        url: null,
        consoleUrl: cloudflareConsole.d1(cf.accountId, db.uuid),
        meta: {},
      });
    },
  },

  "render-service": {
    title: "сервис Render",
    providers: ["github", "render"],
    needs: ["render.hours"],
    background: true,
    validate: (p) =>
      !p.repo
        ? "Выберите репозиторий проекта"
        : RENDER_REGIONS.includes(p.region as RenderRegion)
          ? null
          : "Некорректный регион",
    async run(ctx, p) {
      const render = ctx.render();
      const repo = ctx.params.repoUrl;
      await ctx.log(`Создаю сервис Render из ${p.repo}…`);
      const service = await createServiceWhenRepoVisible(ctx, () =>
        render.client.createDockerService({
          ownerId: render.ownerId,
          name: ctx.project.name,
          repoUrl: repo,
          branch: ctx.params.repoBranch,
          region: p.region as RenderRegion,
          healthCheckPath: p.healthCheckPath || "/",
        }),
      );
      await ctx.addResource({
        type: "render.service",
        kind: "service",
        name: service.name,
        externalId: service.id,
        url: service.serviceDetails.url ?? null,
        consoleUrl: service.dashboardUrl,
        meta: { region: p.region },
      });
      await ctx.log("Render собирает первый деплой (3–5 минут). Нужен Dockerfile в корне репозитория.");
    },
  },
};

/** Подготовка задачи: проверка параметров, аккаунтов и лимитов — до запуска, чтобы ошибки были сразу. */
async function prepare(store: Store, project: Project, task: ResourceTask) {
  const builder = BUILDERS[task.kind as keyof typeof BUILDERS];
  if (!builder) throw new UserError("Неизвестный вид ресурса");
  const params = { ...task.params };
  const invalid = builder.validate?.(params);
  if (invalid) throw new UserError(invalid);

  const connections = await store.listConnections();
  for (const provider of builder.providers) {
    const wanted = params[accountParam(provider)];
    const account = wanted
      ? connections.find((c) => c.id === wanted && c.provider === provider)
      : connections.find((c) => c.provider === provider);
    if (!account) throw new UserError(`Сначала подключите ${provider}`);
    params[accountParam(provider)] = account.id;
  }

  if (task.kind === "render-service") {
    // Сервис собирается из репозитория, который уже привязан к проекту
    const repo = (await store.listResources(project.id)).find((r) => r.id === params.repo && r.type === "github.repo");
    if (!repo?.url) throw new UserError("Репозиторий не найден в проекте");
    params.repoUrl = repo.url;
    params.repoBranch = repo.meta.branch ?? "main";
  }

  const accounts = builder.providers.map((p) => params[accountParam(p)]);
  const blocked = await blockingLimits(store, builder.needs, accounts);
  if (blocked.length > 0) {
    throw new UserError(`Не хватает бесплатного лимита — ${blocked.map(describeLimit).join("; ")}`, 409);
  }
  return { builder, params };
}

/** Выполняет задачу (в фоне — из Workflow). Ошибки пишет в журнал проекта. */
export async function runResourceTask(store: Store, projectId: string, task: ResourceTask): Promise<void> {
  const project = await requireProject(store, projectId);
  const builder = BUILDERS[task.kind as keyof typeof BUILDERS];
  try {
    const ctx = await buildContext(store, project, builder.providers, task.params);
    await builder.run(ctx, task.params);
    await store.addEvent(projectId, "info", `Готово: ${builder.title}`);
  } catch (e) {
    await store.addEvent(
      projectId,
      "error",
      `Не удалось создать ${builder.title}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Telegram-бот: apphub его не создаёт (это делает @BotFather) — проверяет токен и хранит его зашифрованным. */
async function addTelegramBot(store: Store, projectId: string, token: string): Promise<void> {
  if (!token?.trim()) throw new UserError("Вставьте токен бота от @BotFather");
  const me = await new Telegram(token.trim()).me().catch(() => {
    throw new UserError("Telegram не принял токен — проверьте его в @BotFather");
  });
  const existing = await store.findResource("telegram.bot", null, me.username);
  const resource =
    existing ??
    (await store.addResource(
      {
        connectionId: null,
        type: "telegram.bot",
        kind: "bot",
        name: `@${me.username}`,
        externalId: me.username,
        url: `https://t.me/${me.username}`,
        consoleUrl: "https://t.me/BotFather",
        meta: {},
        origin: "external",
      },
      token.trim(),
    ));
  await store.bindResource(projectId, resource.id, "bot");
  await store.addEvent(projectId, "info", `Добавлен бот @${me.username}`);
}

/** Создать ресурс в проекте. Возвращает true, если создание ушло в фон. */
export async function startResourceTask(store: Store, projectId: string, task: ResourceTask): Promise<boolean> {
  const project = await requireProject(store, projectId);
  if (project.status !== "ready") throw new UserError("Ресурсы добавляются в готовый проект");
  if (task.kind === "telegram-bot") {
    await addTelegramBot(store, projectId, task.params.token);
    return false;
  }
  const { builder, params } = await prepare(store, project, task);
  const prepared = { kind: task.kind, params };
  if (!builder.background) {
    await runResourceTask(store, projectId, prepared);
    return false;
  }
  await store.addEvent(projectId, "info", `Создаю ${builder.title} в фоне…`);
  await store.env.PROVISION.create({ id: `${projectId}-${Date.now()}`, params: { projectId, task: prepared } });
  return true;
}
