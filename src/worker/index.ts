import { Hono } from "hono";
import type { ProjectSummary } from "../shared/types";
import { requireAccess } from "./auth";
import { Store } from "./db";
import { missingConnections, projectStatus, provision, triggerDeploy } from "./engine";
import type { AppEnv } from "./env";
import { ProviderError } from "./providers/errors";
import { PROVIDERS, isProviderId, verifyConnection } from "./providers";
import { RECIPES, findRecipe, recipeInfo } from "./recipes";

// Имя идёт в название репо, Worker и базы D1 — берём общий безопасный формат.
const PROJECT_NAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

type Ctx = { Bindings: AppEnv; Variables: { store: Store } };

const app = new Hono<Ctx>().basePath("/api");

app.use("*", requireAccess);
app.use("*", async (c, next) => {
  c.set("store", new Store(c.env));
  await next();
});

app.onError((err, c) => {
  console.error(err);
  const status = err instanceof ProviderError ? 502 : 500;
  return c.json({ error: err.message }, status);
});

// --- провайдеры и подключения ---

app.get("/providers", (c) => c.json(PROVIDERS));

app.get("/connections", async (c) => c.json(await c.var.store.listConnections()));

app.put("/connections/:provider", async (c) => {
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

app.delete("/connections/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderId(provider)) return c.json({ error: "Неизвестный провайдер" }, 404);
  await c.var.store.deleteConnection(provider);
  return c.body(null, 204);
});

// --- рецепты ---

app.get("/recipes", (c) => c.json(RECIPES.map(recipeInfo)));

// --- проекты ---

app.get("/projects", async (c) => {
  const [projects, resources] = await Promise.all([c.var.store.listProjects(), c.var.store.listResources()]);
  const summaries: ProjectSummary[] = projects.map((p) => ({
    ...p,
    links: resources
      .filter((r) => r.projectId === p.id && r.url && r.kind !== "repo")
      .map((r) => ({ label: r.kind === "site" ? "Сайт" : "Приложение", url: r.url! })),
  }));
  return c.json(summaries);
});

app.post("/projects", async (c) => {
  const store = c.var.store;
  const body = await c.req.json<{ recipeId?: string; name?: string; params?: Record<string, string> }>();

  const recipe = findRecipe(body.recipeId ?? "");
  if (!recipe) return c.json({ error: "Неизвестный рецепт" }, 400);

  const name = (body.name ?? "").trim().toLowerCase();
  if (!PROJECT_NAME.test(name)) {
    return c.json({ error: "Имя: 3–32 символа, латиница в нижнем регистре, цифры и дефис" }, 400);
  }
  if (await store.projectNameTaken(name)) return c.json({ error: "Проект с таким именем уже есть" }, 409);

  const params: Record<string, string> = {};
  for (const field of recipe.fields) {
    const value = (body.params?.[field.key] ?? field.default ?? "").trim();
    if (field.required && !value) return c.json({ error: `Не заполнено поле «${field.label}»` }, 400);
    params[field.key] = value;
  }
  const invalid = recipe.validate?.(params);
  if (invalid) return c.json({ error: invalid }, 400);

  const missing = await missingConnections(store, recipe);
  if (missing.length > 0) return c.json({ error: `Сначала подключите: ${missing.join(", ")}` }, 400);

  const project = await store.createProject({ name, recipeId: recipe.id, params });
  await provision(store, recipe, project);
  return c.json({ id: project.id }, 201);
});

app.get("/projects/:id", async (c) => {
  const store = c.var.store;
  const project = await store.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Проект не найден" }, 404);
  const [resources, events] = await Promise.all([store.listResources(project.id), store.listEvents(project.id)]);
  return c.json({ project, resources, events });
});

app.get("/projects/:id/status", async (c) => {
  const store = c.var.store;
  const project = await store.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Проект не найден" }, 404);
  return c.json(await projectStatus(store, await store.listResources(project.id)));
});

app.post("/projects/:id/deploy", async (c) => {
  const store = c.var.store;
  const project = await store.getProject(c.req.param("id"));
  if (!project) return c.json({ error: "Проект не найден" }, 404);
  await triggerDeploy(store, await store.listResources(project.id));
  await store.addEvent(project.id, "info", "Деплой запущен вручную");
  return c.body(null, 202);
});

// Удаляет проект только из apphub: репозиторий, Worker и база у провайдеров остаются.
app.delete("/projects/:id", async (c) => {
  await c.var.store.deleteProject(c.req.param("id"));
  return c.body(null, 204);
});

app.all("*", (c) => c.json({ error: "Not found" }, 404));

export default app;
