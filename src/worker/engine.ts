// Выполнение рецептов и сбор статусов ресурсов.
import type {
  Project,
  ProjectStatusReport,
  ProviderId,
  Resource,
  ResourceHealth,
  ResourceType,
  WorkflowRun,
} from "../shared/types";
import type { Store } from "./db";
import { ProviderError } from "./providers/errors";
import { Cloudflare } from "./providers/cloudflare";
import { GitHub } from "./providers/github";
import { GoogleDrive } from "./providers/google";
import { isLlmProvider, listModels, llmCredentials } from "./llm";
import { Render, type RenderDeploy, type RenderDeployStatus } from "./providers/render";
import { Supabase, type SupabaseProjectStatus } from "./providers/supabase";
import { Telegram } from "./providers/telegram";
import type {
  CloudflareAccess,
  GitHubAccess,
  GoogleAccess,
  ProvisionContext,
  Recipe,
  RenderAccess,
  SupabaseAccess,
} from "./recipes/types";

type Access = {
  github: GitHubAccess;
  cloudflare: CloudflareAccess;
  supabase: SupabaseAccess;
  render: RenderAccess;
  google: GoogleAccess;
};
type ManagedProvider = keyof Access;

/**
 * Клиенты провайдеров по аккаунтам: для конкретного аккаунта (id подключения) или аккаунта по умолчанию.
 * Создаются лениво и переиспользуются в пределах запроса.
 */
export class Clients {
  private cache = new Map<string, Promise<unknown>>();

  constructor(private store: Store) {}

  private get<P extends ManagedProvider>(provider: P, connectionId?: string | null): Promise<Access[P] | null> {
    const key = `${provider}:${connectionId ?? "default"}`;
    if (!this.cache.has(key)) this.cache.set(key, this.build(provider, connectionId));
    return this.cache.get(key) as Promise<Access[P] | null>;
  }

  private async build<P extends ManagedProvider>(provider: P, connectionId?: string | null): Promise<Access[P] | null> {
    const c = connectionId
      ? await this.store.getConnectionById(connectionId)
      : await this.store.defaultConnection(provider);
    if (!c || c.provider !== provider) return null;
    const access = {
      github: () => ({ connectionId: c.id, client: new GitHub(c.token), login: c.accountId }),
      cloudflare: () => ({
        connectionId: c.id,
        client: new Cloudflare(c.token, c.accountId),
        accountId: c.accountId,
        subdomain: c.meta.subdomain ?? "",
        token: c.token,
      }),
      supabase: () => ({ connectionId: c.id, client: new Supabase(c.token), organizationSlug: c.accountId }),
      render: () => ({ connectionId: c.id, client: new Render(c.token), ownerId: c.accountId }),
      google: () => ({ connectionId: c.id, client: new GoogleDrive(c.token) }),
    }[provider];
    return access() as Access[P];
  }

  github = (id?: string | null) => this.get("github", id);
  cloudflare = (id?: string | null) => this.get("cloudflare", id);
  supabase = (id?: string | null) => this.get("supabase", id);
  render = (id?: string | null) => this.get("render", id);
  google = (id?: string | null) => this.get("google", id);
}

/** Провайдер ресурса по его типу: github.repo → github. У внешних ресурсов провайдера нет. */
export function resourceProvider(type: ResourceType): ManagedProvider | null {
  const provider = type.split(".")[0];
  return provider in { github: 1, cloudflare: 1, supabase: 1, render: 1, google: 1 }
    ? (provider as ManagedProvider)
    : null;
}

/** Подключения, нужные рецепту при этих параметрах. */
export function requiredProviders(recipe: Recipe, params: Record<string, string>): ProviderId[] {
  return [...recipe.requires, ...(recipe.requiresFor?.(params) ?? [])];
}

export async function missingConnections(
  store: Store,
  recipe: Recipe,
  params: Record<string, string> = {},
): Promise<ProviderId[]> {
  const connected = new Set((await store.listConnections()).map((c) => c.provider));
  return requiredProviders(recipe, params).filter((p) => !connected.has(p));
}

/** Ключ параметра проекта с выбранным аккаунтом провайдера. */
export const accountParam = (provider: ProviderId) => `account.${provider}`;

/**
 * Контекст создания ресурсов для проекта: клиенты выбранных аккаунтов, журнал, регистрация ресурсов в каталоге.
 * Общий для рецептов и для создания отдельных ресурсов в проекте.
 */
export async function buildContext(
  store: Store,
  project: Project,
  providers: ProviderId[],
  params: Record<string, string>,
): Promise<ProvisionContext> {
  // Аккаунты выбираются при создании; не выбран — аккаунт провайдера по умолчанию
  const clients = new Clients(store);
  const chosen = new Map<ProviderId, Access[ManagedProvider]>();
  for (const provider of providers) {
    if (!(provider in { github: 1, cloudflare: 1, supabase: 1, render: 1, google: 1 })) continue;
    const access = await clients[provider as ManagedProvider](params[accountParam(provider)]);
    if (!access) throw new Error(`Не подключён аккаунт ${provider}`);
    chosen.set(provider, access);
  }
  const use = <P extends ManagedProvider>(provider: P): Access[P] => {
    const access = chosen.get(provider);
    if (!access) throw new Error(`Не подключён ${provider}`);
    return access as Access[P];
  };

  return {
    project,
    params,
    github: () => use("github"),
    cloudflare: () => use("cloudflare"),
    supabase: () => use("supabase"),
    render: () => use("render"),
    google: () => use("google").client,
    log: (message) => store.addEvent(project.id, "info", message),
    setResourceSecret: (id, secret) => store.setResourceSecret(id, secret),
    // Ресурс заводится в каталоге с аккаунтом, через который создан, и сразу привязывается к проекту
    addResource: async (r) => {
      const provider = resourceProvider(r.type);
      const resource = await store.addResource({
        ...r,
        connectionId: provider ? use(provider).connectionId : null,
        origin: "created",
      });
      await store.bindResource(project.id, resource.id, r.kind);
      return resource;
    },
  };
}

export async function provision(store: Store, recipe: Recipe, project: Project): Promise<void> {
  try {
    const ctx = await buildContext(store, project, requiredProviders(recipe, project.params), project.params);
    await recipe.provision(ctx);
    await store.setProjectStatus(project.id, "ready");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await store.addEvent(project.id, "error", message);
    await store.setProjectStatus(project.id, "failed", message);
  }
}

function runHealth(run: WorkflowRun | undefined): Omit<ResourceHealth, "resourceId"> {
  if (!run) return { state: "unknown", summary: "Запусков Actions ещё не было" };
  if (run.status !== "completed") return { state: "pending", summary: `${run.name}: выполняется` };
  if (run.conclusion === "success") return { state: "ok", summary: `${run.name}: успешно` };
  return { state: "error", summary: `${run.name}: ${run.conclusion ?? "ошибка"}` };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

const SUPABASE_PENDING: SupabaseProjectStatus[] = [
  "COMING_UP",
  "RESTORING",
  "RESTARTING",
  "UPGRADING",
  "RESIZING",
  "PAUSING",
  "GOING_DOWN",
];

const RENDER_PENDING: RenderDeployStatus[] = [
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
];
const RENDER_FAILED: RenderDeployStatus[] = ["build_failed", "update_failed", "pre_deploy_failed"];

function renderRun(deploy: RenderDeploy, dashboardUrl: string | null): WorkflowRun {
  const finished = !RENDER_PENDING.includes(deploy.status);
  return {
    source: "render",
    id: deploy.id,
    name: "Render",
    status: finished ? "completed" : "in_progress",
    conclusion: !finished
      ? null
      : RENDER_FAILED.includes(deploy.status)
        ? "failure"
        : deploy.status === "canceled"
          ? "cancelled"
          : "success",
    event: deploy.trigger ?? "deploy",
    url: dashboardUrl ? `${dashboardUrl}/deploys/${deploy.id}` : "https://dashboard.render.com",
    commitMessage: deploy.commit?.message.split("\n")[0] ?? null,
    createdAt: deploy.createdAt,
  };
}

interface CheckContext {
  store: Store;
  clients: Clients;
  latestGithubRun: WorkflowRun | undefined;
  renderDeploys: Map<string, RenderDeploy[]>;
}

const DISCONNECTED = { state: "unknown" as const, summary: "Аккаунт ресурса не подключён" };

async function checkResource(r: Resource, ctx: CheckContext): Promise<Omit<ResourceHealth, "resourceId">> {
  const { clients } = ctx;
  switch (r.type) {
    case "llm.model": {
      const c = r.connectionId ? await ctx.store.getConnectionById(r.connectionId) : null;
      if (!c || !isLlmProvider(c.provider)) return DISCONNECTED;
      const { baseUrl, key } = llmCredentials(c);
      try {
        const models = await listModels(c.provider, baseUrl, key);
        return models.some((m) => m.id === r.externalId)
          ? { state: "ok", summary: "Модель доступна" }
          : { state: "warn", summary: "Модели больше нет в списке провайдера — выберите другую" };
      } catch (e) {
        if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
          return { state: "error", summary: "Ключ отклонён — замените его в «Подключениях»" };
        }
        throw e;
      }
    }

    case "telegram.bot": {
      const token = await ctx.store.getResourceSecret(r.id);
      if (!token) return { state: "unknown", summary: "Нет токена бота" };
      try {
        const me = await new Telegram(token).me();
        return { state: "ok", summary: `Бот @${me.username} отвечает` };
      } catch (e) {
        if (e instanceof ProviderError && e.status === 401) {
          return { state: "error", summary: "Токен бота недействителен — его отозвали в @BotFather?" };
        }
        throw e;
      }
    }

    case "postgres.external": {
      const url = await ctx.store.getResourceSecret(r.id);
      if (!url) return { state: "unknown", summary: "Нет строки подключения" };
      // Только в рантайме Workers: проверка TCP-доступности через cloudflare:sockets
      const { checkTcp } = await import("./tcp-check");
      const { hostname, port } = new URL(url);
      const result = await checkTcp(hostname, Number(port || 5432));
      return result.ok
        ? { state: "ok", summary: `Сервер ${hostname}:${port || 5432} принимает подключения` }
        : { state: "error", summary: `Сервер ${hostname}:${port || 5432} не отвечает: ${result.error}` };
    }

    case "google.sheet": {
      const google = await clients.google(r.connectionId);
      if (!google) return DISCONNECTED;
      try {
        const file = await google.client.getFile(r.externalId);
        return { state: "ok", summary: `Доступ есть, изменена ${new Date(file.modifiedTime).toLocaleString("ru-RU")}` };
      } catch (e) {
        // 404 от Drive значит, что сервисному аккаунту больше не дали доступ — сборка сломается
        if (e instanceof ProviderError && e.status === 404) {
          return { state: "error", summary: `Нет доступа к таблице: поделитесь ею с ${google.client.email}` };
        }
        throw e;
      }
    }

    case "render.service": {
      const render = await clients.render(r.connectionId);
      if (!render) return DISCONNECTED;
      const service = await render.client.getService(r.externalId);
      if (service.suspended === "suspended") return { state: "warn", summary: "Сервис приостановлен в Render" };
      const deploy = ctx.renderDeploys.get(r.id)?.[0];
      if (!deploy) return { state: "pending", summary: "Деплоев ещё не было" };
      if (RENDER_PENDING.includes(deploy.status)) return { state: "pending", summary: "Render собирает и деплоит" };
      if (RENDER_FAILED.includes(deploy.status)) return { state: "error", summary: `Деплой упал: ${deploy.status}` };
      if (deploy.status === "live") {
        return { state: "ok", summary: "Работает; бесплатный инстанс засыпает без запросов, просыпается ~минуту" };
      }
      return { state: "ok", summary: `Последний деплой: ${deploy.status}` };
    }

    case "github.repo": {
      // Репозиторий без GitHub Actions (например, сборку делает Render) — запусков нет, проверяем доступ
      if (!r.meta.workflow) {
        const gh = await clients.github(r.connectionId);
        if (!gh) return DISCONNECTED;
        await gh.client.getRepo(r.externalId);
        return { state: "ok", summary: "Репозиторий доступен; сборки в GitHub Actions нет" };
      }
      const github = await clients.github(r.connectionId);
      if (!github) return DISCONNECTED;
      const run = runHealth(ctx.latestGithubRun);
      if (run.state === "error") return run;
      // GitHub отключает workflow с расписанием в репо без активности дольше 60 дней
      const disabled = (await github.client.listWorkflows(r.externalId)).filter(
        (w) => w.state === "disabled_inactivity",
      );
      if (disabled.length > 0) {
        return {
          state: "warn",
          summary: `GitHub отключил ${disabled.map((w) => `«${w.name}»`).join(", ")} из-за неактивности репозитория`,
          action: { id: "enable_workflows", label: "Включить" },
        };
      }
      return run;
    }

    case "github.pages": {
      const github = await clients.github(r.connectionId);
      if (!github) return DISCONNECTED;
      const pages = await github.client.getPages(r.externalId);
      if (pages.status === "errored") return { state: "error", summary: "Ошибка публикации Pages" };
      if (pages.status === "building" || pages.status === "queued") return { state: "pending", summary: "Публикуется" };
      const res = await fetch(pages.html_url, { method: "HEAD", redirect: "follow" });
      return res.ok
        ? { state: "ok", summary: "Сайт отвечает" }
        : { state: res.status === 404 ? "pending" : "error", summary: `Сайт отвечает ${res.status}` };
    }

    case "cloudflare.worker": {
      const cf = await clients.cloudflare(r.connectionId);
      if (!cf) return DISCONNECTED;
      const deployment = await cf.client.latestDeployment(r.externalId);
      if (!deployment) return { state: "pending", summary: "Ещё не задеплоен" };
      return { state: "ok", summary: `Задеплоен ${new Date(deployment.created_on).toLocaleString("ru-RU")}` };
    }

    case "cloudflare.d1": {
      const cf = await clients.cloudflare(r.connectionId);
      if (!cf) return DISCONNECTED;
      const db = await cf.client.getD1(r.externalId);
      return {
        state: "ok",
        summary: `Таблиц: ${db.num_tables ?? 0}, размер ${formatBytes(db.file_size ?? 0)}`,
      };
    }

    case "supabase.project": {
      const sb = await clients.supabase(r.connectionId);
      if (!sb) return DISCONNECTED;
      const project = await sb.client.getProject(r.externalId);
      if (project.status === "ACTIVE_HEALTHY") return { state: "ok", summary: `Работает, регион ${project.region}` };
      if (project.status === "INACTIVE") {
        return {
          state: "warn",
          summary: "На паузе: бесплатные проекты засыпают после недели без активности",
          action: { id: "wake", label: "Разбудить" },
        };
      }
      if (SUPABASE_PENDING.includes(project.status)) return { state: "pending", summary: project.status };
      return { state: "error", summary: project.status };
    }
  }
}

export async function projectStatus(store: Store, resources: Resource[]): Promise<ProjectStatusReport> {
  const clients = new Clients(store);
  const repo = resources.find((r) => r.type === "github.repo");

  let githubRuns: WorkflowRun[] = [];
  const github = repo?.meta.workflow ? await clients.github(repo.connectionId) : null;
  if (repo && github) {
    try {
      githubRuns = await github.client.listRuns(repo.externalId);
    } catch {
      // статус репо ниже покажет, что что-то не так
    }
  }

  const renderDeploys = new Map<string, RenderDeploy[]>();
  let renderRuns: WorkflowRun[] = [];
  for (const r of resources.filter((x) => x.type === "render.service")) {
    const render = await clients.render(r.connectionId);
    if (!render) continue;
    try {
      const deploys = await render.client.listDeploys(r.externalId);
      renderDeploys.set(r.id, deploys);
      renderRuns = renderRuns.concat(deploys.map((d) => renderRun(d, r.consoleUrl)));
    } catch {
      // статус сервиса ниже покажет, что что-то не так
    }
  }

  const ctx: CheckContext = { store, clients, latestGithubRun: githubRuns[0], renderDeploys };
  const health = await Promise.all(resources.map((r) => resourceHealth(r, ctx)));
  const runs = [...githubRuns, ...renderRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  return { health, runs };
}

async function resourceHealth(r: Resource, ctx: CheckContext): Promise<ResourceHealth> {
  try {
    return { resourceId: r.id, ...(await checkResource(r, ctx)) };
  } catch (e) {
    // Не смогли проверить (сеть, лимиты API) — это не проблема ресурса, алерт не нужен
    return {
      resourceId: r.id,
      state: "unknown",
      summary: `Не удалось проверить: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Статусы произвольного набора ресурсов — для каталога, без запусков сборок. */
export async function resourcesHealth(store: Store, resources: Resource[]): Promise<ResourceHealth[]> {
  const ctx: CheckContext = {
    store,
    clients: new Clients(store),
    latestGithubRun: undefined,
    renderDeploys: new Map(),
  };
  // Без истории запусков репозиторий и Render честно не оценить — для них короткая проверка доступа
  return Promise.all(
    resources.map((r) =>
      r.type === "github.repo" || r.type === "render.service" ? accessHealth(r, ctx) : resourceHealth(r, ctx),
    ),
  );
}

async function accessHealth(r: Resource, ctx: CheckContext): Promise<ResourceHealth> {
  try {
    if (r.type === "github.repo") {
      const github = await ctx.clients.github(r.connectionId);
      if (!github) return { resourceId: r.id, ...DISCONNECTED };
      await github.client.getRepo(r.externalId);
      return { resourceId: r.id, state: "ok", summary: "Репозиторий доступен" };
    }
    const render = await ctx.clients.render(r.connectionId);
    if (!render) return { resourceId: r.id, ...DISCONNECTED };
    const deploys = await render.client.listDeploys(r.externalId, 1);
    ctx.renderDeploys.set(r.id, deploys);
    return resourceHealth(r, ctx);
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) {
      return { resourceId: r.id, state: "error", summary: "Не найден у провайдера — удалён вне AppHub?" };
    }
    return {
      resourceId: r.id,
      state: "unknown",
      summary: `Не удалось проверить: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function runResourceAction(store: Store, resource: Resource, action: string): Promise<string> {
  const clients = new Clients(store);
  if (resource.type === "supabase.project" && action === "wake") {
    const sb = await clients.supabase(resource.connectionId);
    if (!sb) throw new Error("Аккаунт Supabase не подключён");
    await sb.client.restoreProject(resource.externalId);
    return `Supabase: ${resource.name} просыпается`;
  }
  if (resource.type === "github.repo" && action === "enable_workflows") {
    const gh = await clients.github(resource.connectionId);
    if (!gh) throw new Error("Аккаунт GitHub не подключён");
    const disabled = (await gh.client.listWorkflows(resource.externalId)).filter(
      (w) => w.state === "disabled_inactivity",
    );
    await Promise.all(disabled.map((w) => gh.client.enableWorkflow(resource.externalId, w.id)));
    return disabled.length > 0
      ? `Включены workflow: ${disabled.map((w) => w.name).join(", ")}`
      : "Отключённых workflow нет";
  }
  throw new Error("Действие недоступно для этого ресурса");
}

export async function triggerDeploy(store: Store, resources: Resource[]): Promise<void> {
  const clients = new Clients(store);
  // Сервис Render собирается сам из репозитория — просим Render задеплоить последний коммит
  const service = resources.find((r) => r.type === "render.service");
  if (service) {
    const render = await clients.render(service.connectionId);
    if (!render) throw new Error("Аккаунт Render не подключён");
    await render.client.triggerDeploy(service.externalId);
    return;
  }
  const repo = resources.find((r) => r.type === "github.repo");
  if (!repo) throw new Error("У проекта нет репозитория");
  const gh = await clients.github(repo.connectionId);
  if (!gh) throw new Error("Аккаунт GitHub не подключён");
  await gh.client.dispatchWorkflow(repo.externalId, repo.meta.workflow ?? "deploy.yml", repo.meta.branch ?? "main");
}

// --- удаление ---

/** Порядок удаления: сначала то, что зависит от остального (сервисы), репозиторий — последним. */
const DELETE_ORDER: ResourceType[] = [
  "telegram.bot",
  "google.sheet",
  "postgres.external",
  "render.service",
  "cloudflare.worker",
  "github.pages",
  "cloudflare.d1",
  "supabase.project",
  "github.repo",
];

export function deletionOrder<R extends Resource>(resources: R[]): R[] {
  return [...resources].sort((a, b) => DELETE_ORDER.indexOf(a.type) - DELETE_ORDER.indexOf(b.type));
}

/** Удаляет ресурс у провайдера. Уже удалённый (404) — не ошибка. Внешние ресурсы и данные пользователя не трогаем. */
export async function deleteAtProvider(store: Store, r: Resource): Promise<void> {
  const clients = new Clients(store);
  const need = <T>(value: T | null, provider: string): T => {
    if (!value) throw new Error(`Аккаунт ${provider} не подключён`);
    return value;
  };
  try {
    switch (r.type) {
      case "github.pages":
        return; // уходит вместе с репозиторием
      case "google.sheet":
      case "postgres.external":
      case "telegram.bot":
      case "llm.model":
        return; // данные, серверы и боты пользователя не удаляем никогда
      case "github.repo":
        return await need(await clients.github(r.connectionId), "GitHub").client.deleteRepo(r.externalId);
      case "cloudflare.worker":
        return await need(await clients.cloudflare(r.connectionId), "Cloudflare").client.deleteWorker(r.externalId);
      case "cloudflare.d1":
        return await need(await clients.cloudflare(r.connectionId), "Cloudflare").client.deleteD1(r.externalId);
      case "supabase.project":
        return await need(await clients.supabase(r.connectionId), "Supabase").client.deleteProject(r.externalId);
      case "render.service":
        return await need(await clients.render(r.connectionId), "Render").client.deleteService(r.externalId);
    }
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) return;
    throw e;
  }
}
