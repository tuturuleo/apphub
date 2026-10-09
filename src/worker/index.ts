import { Hono, type ErrorHandler } from "hono";
import { requireAccess } from "./auth";
import { Store } from "./db";
import { projectStatus } from "./engine";
import type { AppEnv } from "./env";
import { runChat, type ChatMessage } from "./chat";
import { handleMcp } from "./mcp";
import { getLastRunAt, notify, reconcileAlerts, runMonitor } from "./monitor";
import { ProviderError } from "./providers/errors";
import { PROVIDERS, isProviderId, verifyConnection } from "./providers";
import { RECIPES, recipeInfo } from "./recipes";
import {
  UserError,
  createProject,
  deployProject,
  destroyProject,
  listProjectSummaries,
  requireProject,
  runAction,
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

api.put("/connections/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderId(provider)) return c.json({ error: "Неизвестный провайдер" }, 404);
  const { token } = await c.req.json<{ token?: string }>();
  if (!token?.trim()) return c.json({ error: "Пустой токен" }, 400);

  let connection;
  try {
    connection = await verifyConnection(provider, token.trim());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  await c.var.store.saveConnection(connection, token.trim());
  return c.json({ ...connection, createdAt: Date.now() });
});

api.delete("/connections/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderId(provider)) return c.json({ error: "Неизвестный провайдер" }, 404);
  await c.var.store.deleteConnection(provider);
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
