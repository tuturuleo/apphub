import { Hono, type ErrorHandler } from "hono";
import { requireAccess } from "./auth";
import { Store } from "./db";
import { projectStatus } from "./engine";
import type { AppEnv } from "./env";
import { handleMcp } from "./mcp";
import { ProviderError } from "./providers/errors";
import { PROVIDERS, isProviderId, verifyConnection } from "./providers";
import { RECIPES, recipeInfo } from "./recipes";
import {
  UserError,
  createProject,
  deployProject,
  listProjectSummaries,
  provisionProject,
  requireProject,
  runAction,
} from "./service";

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

// Создание ресурсов может занять минуты (Supabase поднимает базу), поэтому идёт отдельным долгим запросом,
// а интерфейс тем временем опрашивает журнал проекта.
api.post("/projects/:id/provision", async (c) => {
  await provisionProject(c.var.store, c.req.param("id"));
  return c.body(null, 204);
});

api.get("/projects/:id", async (c) => {
  const store = c.var.store;
  const project = await requireProject(store, c.req.param("id"));
  const [resources, events] = await Promise.all([store.listResources(project.id), store.listEvents(project.id)]);
  return c.json({ project, resources, events });
});

api.get("/projects/:id/status", async (c) => {
  const store = c.var.store;
  const project = await requireProject(store, c.req.param("id"));
  return c.json(await projectStatus(store, await store.listResources(project.id)));
});

api.post("/projects/:id/deploy", async (c) => {
  await deployProject(c.var.store, c.req.param("id"));
  return c.body(null, 202);
});

api.post("/projects/:id/resources/:resourceId/actions/:action", async (c) => {
  await runAction(c.var.store, c.req.param("id"), c.req.param("resourceId"), c.req.param("action"));
  return c.body(null, 202);
});

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

export default app;
