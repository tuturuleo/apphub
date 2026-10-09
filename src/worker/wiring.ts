// Связи внутри проекта: значения (выходы) одних ресурсов записываются в переменные других.
// Выходы: строка подключения базы, адрес сервиса, токен бота. Потребители: переменные окружения Render,
// секреты Worker, секреты GitHub Actions.
import type { BoundResource, Resource, ResourceOutput, ResourceType, Wire } from "../shared/types";
import type { Store } from "./db";
import { Clients } from "./engine";
import { isLlmProvider, llmCredentials } from "./llm";
import { UserError } from "./service";

interface OutputSpec {
  key: string;
  label: string;
  secret: boolean;
}

const OUTPUTS: Partial<Record<ResourceType, OutputSpec[]>> = {
  "supabase.project": [
    { key: "DATABASE_URL", label: "Строка подключения к базе", secret: true },
    { key: "SUPABASE_URL", label: "Адрес API Supabase", secret: false },
    { key: "SUPABASE_PUBLISHABLE_KEY", label: "Публичный ключ Supabase", secret: false },
  ],
  "postgres.external": [{ key: "DATABASE_URL", label: "Строка подключения к базе", secret: true }],
  "telegram.bot": [{ key: "TELEGRAM_BOT_TOKEN", label: "Токен бота", secret: true }],
  "render.service": [{ key: "SERVICE_URL", label: "Адрес сервиса", secret: false }],
  "cloudflare.worker": [{ key: "SERVICE_URL", label: "Адрес сервиса", secret: false }],
  "github.pages": [{ key: "SITE_URL", label: "Адрес сайта", secret: false }],
  "llm.model": [
    { key: "LLM_BASE_URL", label: "Адрес OpenAI-совместимого API", secret: false },
    { key: "LLM_API_KEY", label: "Ключ API провайдера", secret: true },
    { key: "LLM_MODEL", label: "Имя модели", secret: false },
  ],
};

/** Ресурсы, в которые можно записывать переменные. */
const CONSUMERS: ResourceType[] = ["render.service", "cloudflare.worker", "github.repo"];

export const isConsumer = (r: Resource) => CONSUMERS.includes(r.type);

/** Выходы ресурса с пометкой, есть ли сейчас значение. */
export async function outputsOf(store: Store, r: Resource | BoundResource): Promise<ResourceOutput[]> {
  // Изолированная привязка базы: у проекта своя строка подключения
  const isolated = "binding" in r && r.binding.mode === "isolated";
  const specs = OUTPUTS[r.type] ?? [];
  const hasSecret = specs.some((s) => s.key === "DATABASE_URL" || s.key === "TELEGRAM_BOT_TOKEN")
    ? await store.hasResourceSecret(r.id)
    : false;
  return specs.map((s) => ({
    ...s,
    available:
      s.key === "DATABASE_URL" && isolated
        ? true
        : s.key === "DATABASE_URL" || s.key === "TELEGRAM_BOT_TOKEN"
          ? hasSecret
          : s.key === "SERVICE_URL" || s.key === "SITE_URL"
            ? !!r.url
            : true,
  }));
}

/** Значение выхода. Секретные значения расшифровываются только здесь и сразу уходят потребителю. */
async function resolveOutput(store: Store, r: BoundResource, key: string, projectId: string): Promise<string> {
  if (key === "DATABASE_URL" && r.binding.mode === "isolated") {
    const url = await store.getBindingSecret(projectId, r.id);
    if (!url) throw new UserError(`Нет строки подключения проекта к «${r.name}» — привяжите базу заново`);
    return url;
  }
  switch (key) {
    case "DATABASE_URL":
    case "TELEGRAM_BOT_TOKEN": {
      const secret = await store.getResourceSecret(r.id);
      if (!secret) {
        throw new UserError(
          r.type === "supabase.project"
            ? `У «${r.name}» не задана строка подключения — задайте её в каталоге ресурсов (из панели Supabase)`
            : `У «${r.name}» нет сохранённого значения`,
        );
      }
      return secret;
    }
    case "SUPABASE_URL":
      return r.meta.apiUrl ?? `https://${r.externalId}.supabase.co`;
    case "SUPABASE_PUBLISHABLE_KEY": {
      const sb = await new Clients(store).supabase(r.connectionId);
      if (!sb) throw new UserError("Аккаунт Supabase этого ресурса не подключён");
      const key = await sb.client.publishableKey(r.externalId);
      if (!key) throw new UserError("Supabase не отдал публичный ключ");
      return key;
    }
    case "SERVICE_URL":
    case "SITE_URL":
      if (!r.url) throw new UserError(`У «${r.name}» нет адреса`);
      return r.url;
    case "LLM_BASE_URL":
    case "LLM_API_KEY": {
      // Ключ — ключ аккаунта провайдера: проект получает тот же доступ, что и AppHub
      const c = r.connectionId ? await store.getConnectionById(r.connectionId) : null;
      if (!c || !isLlmProvider(c.provider)) throw new UserError(`Аккаунт провайдера модели «${r.name}» не подключён`);
      const creds = llmCredentials(c);
      return key === "LLM_API_KEY" ? creds.key : creds.baseUrl;
    }
    case "LLM_MODEL":
      return r.externalId;
    default:
      throw new UserError(`У «${r.name}» нет выхода ${key}`);
  }
}

/** Записывает переменную потребителю. Для Render — с передеплоем, иначе новое значение не подхватится. */
async function writeVariable(store: Store, target: Resource, name: string, value: string): Promise<void> {
  const clients = new Clients(store);
  switch (target.type) {
    case "render.service": {
      const render = await clients.render(target.connectionId);
      if (!render) throw new UserError("Аккаунт Render этого сервиса не подключён");
      await render.client.setEnvVar(target.externalId, name, value);
      await render.client.triggerDeploy(target.externalId);
      return;
    }
    case "cloudflare.worker": {
      const cf = await clients.cloudflare(target.connectionId);
      if (!cf) throw new UserError("Аккаунт Cloudflare этого Worker не подключён");
      await cf.client.putWorkerSecret(target.externalId, name, value);
      return;
    }
    case "github.repo": {
      const gh = await clients.github(target.connectionId);
      if (!gh) throw new UserError("Аккаунт GitHub этого репозитория не подключён");
      await gh.client.setActionsSecret(target.externalId, name, value);
      return;
    }
    default:
      throw new UserError(`В «${target.name}» нельзя записывать переменные`);
  }
}

async function removeVariable(store: Store, target: Resource, name: string): Promise<void> {
  const clients = new Clients(store);
  switch (target.type) {
    case "render.service":
      await (await clients.render(target.connectionId))?.client.deleteEnvVar(target.externalId, name);
      return;
    case "cloudflare.worker":
      await (await clients.cloudflare(target.connectionId))?.client.deleteWorkerSecret(target.externalId, name);
      return;
    case "github.repo":
      await (await clients.github(target.connectionId))?.client.deleteActionsSecret(target.externalId, name);
      return;
  }
}

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

async function projectResource(store: Store, projectId: string, id: string): Promise<BoundResource> {
  const r = (await store.listResources(projectId)).find((x) => x.id === id);
  if (!r) throw new UserError("Ресурс не привязан к проекту", 404);
  return r;
}

/** Применяет связь: вычисляет значение и пишет его потребителю. Ошибка сохраняется в связи, а не теряется. */
async function apply(
  store: Store,
  projectId: string,
  wire: Wire,
  source: BoundResource,
  target: Resource,
): Promise<Wire> {
  try {
    await writeVariable(store, target, wire.name, await resolveOutput(store, source, wire.output, projectId));
    const done = { ...wire, appliedAt: Date.now(), error: null };
    await store.saveWire(projectId, done);
    return done;
  } catch (e) {
    const failed = { ...wire, appliedAt: null, error: e instanceof Error ? e.message : String(e) };
    await store.saveWire(projectId, failed);
    return failed;
  }
}

export async function connect(
  store: Store,
  projectId: string,
  input: { sourceId?: string; output?: string; targetId?: string; name?: string },
): Promise<Wire> {
  const source = await projectResource(store, projectId, input.sourceId ?? "");
  const target = await projectResource(store, projectId, input.targetId ?? "");
  if (!isConsumer(target)) throw new UserError(`В «${target.name}» нельзя записывать переменные`);
  const output = (await outputsOf(store, source)).find((o) => o.key === input.output);
  if (!output) throw new UserError(`У «${source.name}» нет выхода ${input.output}`);
  const name = (input.name?.trim() || output.key).toUpperCase();
  if (!VARIABLE_NAME.test(name)) throw new UserError("Имя переменной: латиница в верхнем регистре, цифры и _");

  const wire = await apply(
    store,
    projectId,
    { sourceId: source.id, output: output.key, targetId: target.id, name, appliedAt: null, error: null },
    source,
    target,
  );
  await store.addEvent(
    projectId,
    wire.error ? "error" : "info",
    wire.error
      ? `Не удалось передать ${output.key} из «${source.name}» в «${target.name}»: ${wire.error}`
      : `${source.name} → ${target.name}: переменная ${name}`,
  );
  return wire;
}

/** Переписывает все связи проекта — например, после смены пароля базы. */
export async function reapplyWires(store: Store, projectId: string): Promise<Wire[]> {
  const resources = await store.listResources(projectId);
  const byId = new Map(resources.map((r) => [r.id, r]));
  const results: Wire[] = [];
  for (const wire of await store.listWires(projectId)) {
    const source = byId.get(wire.sourceId);
    const target = byId.get(wire.targetId);
    if (source && target) results.push(await apply(store, projectId, wire, source, target));
  }
  const failed = results.filter((w) => w.error).length;
  await store.addEvent(
    projectId,
    failed ? "error" : "info",
    `Переменные переданы заново: ${results.length - failed} из ${results.length}`,
  );
  return results;
}

/** Убирает связь и переменную у потребителя (если она там была). */
export async function disconnect(store: Store, projectId: string, targetId: string, name: string): Promise<void> {
  const target = (await store.listResources(projectId)).find((r) => r.id === targetId);
  if (target) await removeVariable(store, target, name).catch(() => {});
  await store.deleteWire(projectId, targetId, name);
}

/** Перед отвязкой ресурса снимаем его связи: и где он источник, и где потребитель. */
export async function dropWiresOf(store: Store, projectId: string, resourceId: string): Promise<void> {
  for (const wire of await store.listWires(projectId)) {
    if (wire.sourceId === resourceId || wire.targetId === resourceId) {
      await disconnect(store, projectId, wire.targetId, wire.name);
    }
  }
}
