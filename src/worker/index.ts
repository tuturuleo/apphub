import { Hono, type ErrorHandler } from "hono";
import { requireAccess } from "./auth";
import { Store } from "./db";
import { projectStatus, resourcesHealth } from "./engine";
import type { AppEnv } from "./env";
import { addExternalPostgres, discoverResources, importResources, removeFromCatalog } from "./catalog";
import { runChat, type ChatMessage } from "./chat";
import { handleMcp } from "./mcp";
import { collectLimits } from "./limits";
import { getLastRunAt, notify, reconcileAlerts, runMonitor } from "./monitor";
import { ProviderError } from "./providers/errors";
import { PROVIDERS, isProviderId, verifyConnection } from "./providers";
import type { ProviderId } from "../shared/types";
import { RECIPES, recipeInfo } from "./recipes";
import {
  UserError,
  createProject,
  deployProject,
  destroyProject,
  getSettings,
  listGoogleSheets,
  listProjectSummaries,
  requireProject,
  runAction,
  saveSettings,
  settleProvisioning,
  startProvisioning,
} from "./service";

export { ProvisionWorkflow } from "./workflow";

type Ctx = { Bindings: AppEnv; Variables: { store: Store } };

const onError: ErrorHandler<Ctx> = (err, c) => {
  if (err instanceof UserError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err.message }, err instanceof ProviderError ? 502 : 500);
};

const api = new Hono<Ctx>().basePath("/api");

api.use("*", requireAccess);
api.use("*", async (c, next) => {
  c.set("store", new Store(c.env));
  await next();
});
api.onError(onError);

// --- провайдеры и подключения ---

api.get("/providers", (c) => c.json(PROVIDERS));

api.get("/connections", async (c) => c.json(await c.var.store.listConnections()));

async function verifyOrFail(provider: ProviderId, token: string) {
  try {
    return await verifyConnection(provider, token);
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : String(e));
  }
}

// Добавляет аккаунт. Тот же аккаунт провайдера (повторное подключение) обновляется, а не дублируется.
api.post("/connections", async (c) => {
  const { provider, token } = await c.req.json<{ provider?: string; token?: string }>();
  if (!provider || !isProviderId(provider)) throw new UserError("Неизвестный провайдер");
  if (!token?.trim()) throw new UserError("Пустой токен");
  const verified = await verifyOrFail(provider, token.trim());
  const store = c.var.store;
  // Служебные подключения (уведомления, ассистент) — в одном экземпляре: новое заменяет прежнее
  const single = !PROVIDERS.find((p) => p.id === provider)!.multiAccount;
  const previous = single ? (await store.listConnections()).find((x) => x.provider === provider) : undefined;
  let id: string;
  if (previous) {
    await store.replaceConnectionToken(previous.id, verified, token.trim());
    id = previous.id;
  } else {
    id = await store.saveConnection(verified, token.trim());
  }
  return c.json((await store.listConnections()).find((x) => x.id === id), 201);
});

// Заменяет токен существующего аккаунта
api.put("/connections/:id", async (c) => {
  const store = c.var.store;
  const existing = (await store.listConnections()).find((x) => x.id === c.req.param("id"));
  if (!existing) throw new UserError("Аккаунт не найден", 404);
  const { token } = await c.req.json<{ token?: string }>();
  if (!token?.trim()) throw new UserError("Пустой токен");
  const verified = await verifyOrFail(existing.provider, token.trim());
  const duplicate = (await store.listConnections()).find(
    (x) => x.id !== existing.id && x.provider === verified.provider && x.accountId === verified.accountId,
  );
  if (duplicate) throw new UserError(`Этот токен от другого уже подключённого аккаунта — «${duplicate.label}»`, 409);
  await store.replaceConnectionToken(existing.id, verified, token.trim());
  return c.json((await store.listConnections()).find((x) => x.id === existing.id));
});

// Отключает аккаунт. Ресурсы каталога остаются — у них будет пометка «аккаунт не подключён»
api.delete("/connections/:id", async (c) => {
  await c.var.store.deleteConnection(c.req.param("id"));
  return c.body(null, 204);
});

// --- каталог ресурсов ---

api.get("/resources", async (c) => c.json(await c.var.store.listCatalog()));

// Живые статусы всех ресурсов каталога — отдельно, потому что это запросы к провайдерам
api.get("/resources/status", async (c) => c.json(await resourcesHealth(c.var.store, await c.var.store.listCatalog())));

api.get("/connections/:id/discover", async (c) => c.json(await discoverResources(c.var.store, c.req.param("id"))));

api.post("/connections/:id/import", async (c) => {
  const { items } = await c.req.json<{ items?: { type: string; externalId: string }[] }>();
  if (!Array.isArray(items) || items.length === 0) throw new UserError("Ничего не выбрано");
  return c.json(await importResources(c.var.store, c.req.param("id"), items), 201);
});

api.post("/resources/external", async (c) => c.json(await addExternalPostgres(c.var.store, await c.req.json()), 201));

api.delete("/resources/:id", async (c) => {
  await removeFromCatalog(c.var.store, c.req.param("id"), c.req.query("atProvider") === "1");
  return c.body(null, 204);
});

// Привязка ресурса каталога к проекту (и отвязка) — общий ресурс может быть в нескольких проектах
api.post("/projects/:id/resources", async (c) => {
  const store = c.var.store;
  const project = await requireProject(store, c.req.param("id"));
  const { resourceId, role } = await c.req.json<{ resourceId?: string; role?: string }>();
  const resource = resourceId ? await store.getResource(resourceId) : null;
  if (!resource) throw new UserError("Ресурс не найден", 404);
  await store.bindResource(project.id, resource.id, role?.trim() || resource.kind);
  await store.addEvent(project.id, "info", `Привязан ресурс: ${resource.name}`);
  return c.body(null, 204);
});

api.delete("/projects/:id/resources/:resourceId", async (c) => {
  const store = c.var.store;
  const project = await requireProject(store, c.req.param("id"));
  const resource = await store.getResource(c.req.param("resourceId"));
  await store.unbindResource(project.id, c.req.param("resourceId"));
  if (resource) await store.addEvent(project.id, "info", `Отвязан ресурс: ${resource.name}`);
  return c.body(null, 204);
});

// --- рецепты ---

api.get("/recipes", (c) => c.json(RECIPES.map(recipeInfo)));

// --- проекты ---

api.get("/projects", async (c) => c.json(await listProjectSummaries(c.var.store)));

api.post("/projects", async (c) => {
  const project = await createProject(c.var.store, await c.req.json());
  return c.json({ id: project.id }, 201);
});

// Создание ресурсов идёт в фоне (Workflow) — отвечаем сразу, интерфейс опрашивает журнал проекта
api.post("/projects/:id/provision", async (c) => {
  await startProvisioning(c.var.store, c.req.param("id"));
  return c.body(null, 202);
});

api.get("/projects/:id", async (c) => {
  const store = c.var.store;
  const project = await settleProvisioning(store, await requireProject(store, c.req.param("id")));
  const [resources, events, alerts] = await Promise.all([
    store.listResources(project.id),
    store.listEvents(project.id),
    store.listAlerts(project.id),
  ]);
  return c.json({ project, resources, events, alerts });
});

api.get("/projects/:id/status", async (c) => {
  const store = c.var.store;
  const project = await requireProject(store, c.req.param("id"));
  const resources = await store.listResources(project.id);
  const report = await projectStatus(store, resources);
  // Свежий статус сразу сверяем с алертами: увиденное в интерфейсе не должно ждать следующей проверки по cron
  const { messages } = await reconcileAlerts(store, project, resources, report);
  if (messages.length > 0) c.executionCtx.waitUntil(notify(store, messages));
  return c.json({ ...report, alerts: await store.listAlerts(project.id) });
});

api.post("/projects/:id/deploy", async (c) => {
  await deployProject(c.var.store, c.req.param("id"));
  return c.body(null, 202);
});

api.post("/projects/:id/resources/:resourceId/actions/:action", async (c) => {
  await runAction(c.var.store, c.req.param("id"), c.req.param("resourceId"), c.req.param("action"));
  return c.body(null, 202);
});

// --- ассистент ---

api.post("/chat", async (c) => {
  const { messages } = await c.req.json<{ messages?: ChatMessage[] }>();
  if (!Array.isArray(messages) || messages.length === 0) return c.json({ error: "Пустая переписка" }, 400);
  return c.json(await runChat(c.var.store, messages));
});

// --- настройки ---

api.get("/settings", async (c) => c.json(await getSettings(c.var.store)));
api.put("/settings", async (c) => c.json(await saveSettings(c.var.store, await c.req.json())));

// --- Google Drive ---

api.get("/google/sheets", async (c) => c.json(await listGoogleSheets(c.var.store, c.req.query("connection"))));

// --- лимиты бесплатных тарифов ---

api.get("/limits", async (c) => c.json(await collectLimits(c.var.store)));

// --- мониторинг ---

api.get("/monitor", async (c) => {
  const store = c.var.store;
  const [lastRunAt, telegram] = await Promise.all([getLastRunAt(store), store.listConnections()]);
  return c.json({ lastRunAt, notifications: telegram.some((t) => t.provider === "telegram") });
});

// Ручная проверка: локально cron не срабатывает, а иногда хочется проверить сразу
api.post("/monitor/run", async (c) => c.json(await runMonitor(c.var.store)));

// Удаляет проект целиком: ресурсы у провайдеров и запись в apphub
api.post("/projects/:id/destroy", async (c) => c.json(await destroyProject(c.var.store, c.req.param("id"))));

// Удаляет проект только из apphub: репозиторий, Worker и база у провайдеров остаются.
api.delete("/projects/:id", async (c) => {
  await c.var.store.deleteProject(c.req.param("id"));
  return c.body(null, 204);
});

api.all("*", (c) => c.json({ error: "Not found" }, 404));

// --- корень: API интерфейса и MCP для LLM-клиентов ---

const app = new Hono<Ctx>();
app.onError(onError);
app.use("/mcp", requireAccess);
app.all("/mcp", (c) => handleMcp(c.req.raw, new Store(c.env)));
app.route("/", api);

export default {
  fetch: app.fetch,
  // Cron Trigger из wrangler.jsonc: проверка проектов и уведомления о проблемах
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runMonitor(new Store(env)).then((r) => console.log("Мониторинг", r)),
    );
  },
} satisfies ExportedHandler<AppEnv>;
