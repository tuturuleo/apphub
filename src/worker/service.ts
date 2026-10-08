// Операции с проектами, общие для REST API интерфейса и MCP-сервера.
import type { Project, ProjectSummary, Resource } from "../shared/types";
import type { Store } from "./db";
import { missingConnections, provision, runResourceAction, triggerDeploy } from "./engine";
import { GitHub, type RepoFile } from "./providers/github";
import { findRecipe } from "./recipes";

/** Ошибка во входных данных или состоянии — показывается пользователю как есть. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

// Имя идёт в название репо, Worker и базы D1 — берём общий безопасный формат.
const PROJECT_NAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export interface NewProjectInput {
  recipeId?: string;
  name?: string;
  params?: Record<string, string>;
}

/** Проверяет параметры и записывает проект в статусе pending. Ресурсы создаёт provisionProject. */
export async function createProject(store: Store, input: NewProjectInput): Promise<Project> {
  const recipe = findRecipe(input.recipeId ?? "");
  if (!recipe) throw new UserError("Неизвестный рецепт");

  const name = (input.name ?? "").trim().toLowerCase();
  if (!PROJECT_NAME.test(name)) {
    throw new UserError("Имя: 3–32 символа, латиница в нижнем регистре, цифры и дефис");
  }
  const existing = await store.getProjectByName(name);
  if (existing) {
    // Неудачная попытка, которая ничего не успела создать у провайдеров, не должна занимать имя
    const abandoned = existing.status === "failed" && (await store.listResources(existing.id)).length === 0;
    if (!abandoned) throw new UserError("Проект с таким именем уже есть", 409);
    await store.deleteProject(existing.id);
  }

  const params: Record<string, string> = {};
  for (const field of recipe.fields) {
    const value = (input.params?.[field.key] ?? field.default ?? "").trim();
    if (field.required && !value) throw new UserError(`Не заполнено поле «${field.label}»`);
    params[field.key] = value;
  }
  const invalid = recipe.validate?.(params);
  if (invalid) throw new UserError(invalid);

  const missing = await missingConnections(store, recipe);
  if (missing.length > 0) throw new UserError(`Сначала подключите: ${missing.join(", ")}`);

  return store.createProject({ name, recipeId: recipe.id, params });
}

/** Создаёт ресурсы проекта. Может занять минуты (Supabase поднимает базу). */
export async function provisionProject(store: Store, id: string): Promise<Project> {
  const project = await requireProject(store, id);
  const recipe = findRecipe(project.recipeId);
  if (!recipe) throw new UserError("Рецепт больше не существует");
  if (!(await store.claimProject(project.id))) throw new UserError("Создание уже запущено", 409);

  await provision(store, recipe, { ...project, status: "provisioning" });
  return requireProject(store, id);
}

export async function requireProject(store: Store, id: string): Promise<Project> {
  const project = await store.getProject(id);
  if (!project) throw new UserError("Проект не найден", 404);
  return project;
}

export async function listProjectSummaries(store: Store): Promise<ProjectSummary[]> {
  const [projects, resources] = await Promise.all([store.listProjects(), store.listResources()]);
  return projects.map((p) => ({
    ...p,
    links: resources
      .filter((r) => r.projectId === p.id && r.url && r.kind !== "repo")
      .map((r) => ({ label: r.kind === "site" ? "Сайт" : "Приложение", url: r.url! })),
  }));
}

export async function deployProject(store: Store, id: string): Promise<void> {
  const project = await requireProject(store, id);
  await triggerDeploy(store, await store.listResources(project.id));
  await store.addEvent(project.id, "info", "Деплой запущен вручную");
}

export async function runAction(store: Store, projectId: string, resourceId: string, action: string): Promise<void> {
  const resource = await store.getResource(projectId, resourceId);
  if (!resource) throw new UserError("Ресурс не найден", 404);
  const message = await runResourceAction(store, resource, action);
  await store.addEvent(resource.projectId, "info", message);
}

// --- код проекта в репозитории ---

const MAX_FILES_PER_COMMIT = 100;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COMMIT_BYTES = 2 * 1024 * 1024;
const MAX_READ_FILES = 30;
const MAX_READ_BYTES = 200 * 1024;

interface RepoAccess {
  project: Project;
  repo: Resource;
  branch: string;
  github: GitHub;
}

async function repoAccess(store: Store, id: string): Promise<RepoAccess> {
  const project = await requireProject(store, id);
  const repo = (await store.listResources(project.id)).find((r) => r.type === "github.repo");
  if (!repo) throw new UserError("У проекта нет репозитория");
  const gh = await store.getConnection("github");
  if (!gh) throw new UserError("GitHub не подключён");
  return { project, repo, branch: repo.meta.branch ?? "main", github: new GitHub(gh.token) };
}

function checkPath(path: string): string {
  const p = path.trim();
  const bad =
    !p ||
    p.length > 300 ||
    p.startsWith("/") ||
    p.endsWith("/") ||
    p.split("/").some((seg) => seg === "" || seg === "." || seg === "..") ||
    p === ".git" ||
    p.startsWith(".git/");
  if (bad) throw new UserError(`Недопустимый путь: «${path}»`);
  return p;
}

export async function listProjectFiles(store: Store, id: string) {
  const { repo, branch, github } = await repoAccess(store, id);
  const files = await github.listFiles(repo.externalId, branch);
  return files.map((f) => ({ path: f.path, size: f.size }));
}

export async function readProjectFiles(store: Store, id: string, paths: string[]) {
  if (paths.length > MAX_READ_FILES) throw new UserError(`За раз можно прочитать до ${MAX_READ_FILES} файлов`);
  const { repo, branch, github } = await repoAccess(store, id);
  const files = new Map((await github.listFiles(repo.externalId, branch)).map((f) => [f.path, f]));
  return Promise.all(
    paths.map(async (raw) => {
      const path = checkPath(raw);
      const file = files.get(path);
      if (!file) return { path, error: "файл не найден" };
      if (file.size > MAX_READ_BYTES) return { path, error: `файл больше ${MAX_READ_BYTES / 1024} КБ` };
      return { path, content: await github.readBlob(repo.externalId, file.sha) };
    }),
  );
}

/** Коммитит изменения в ветку проекта; push запускает деплой в GitHub Actions. */
export async function updateProjectFiles(
  store: Store,
  id: string,
  changes: { files?: RepoFile[]; remove?: string[]; message?: string },
): Promise<{ commit: string; changed: number; removed: number }> {
  const upsert = (changes.files ?? []).map((f) => ({ path: checkPath(f.path), content: f.content }));
  const remove = (changes.remove ?? []).map(checkPath);
  if (upsert.length + remove.length === 0) throw new UserError("Нет изменений");
  if (upsert.length + remove.length > MAX_FILES_PER_COMMIT) {
    throw new UserError(`За один коммит — до ${MAX_FILES_PER_COMMIT} файлов`);
  }
  const encoder = new TextEncoder();
  let total = 0;
  for (const f of upsert) {
    const size = encoder.encode(f.content).length;
    if (size > MAX_FILE_BYTES) throw new UserError(`${f.path}: больше ${MAX_FILE_BYTES / 1024} КБ`);
    total += size;
  }
  if (total > MAX_COMMIT_BYTES) throw new UserError(`Коммит больше ${MAX_COMMIT_BYTES / 1024 / 1024} МБ`);
  const all = [...upsert.map((f) => f.path), ...remove];
  if (new Set(all).size !== all.length) throw new UserError("Один и тот же путь указан дважды");

  const { project, repo, branch, github } = await repoAccess(store, id);
  const message = changes.message?.trim() || "Update from apphub";
  const commit = await github.commitChanges(repo.externalId, branch, { upsert, remove }, message);
  await store.addEvent(
    project.id,
    "info",
    `Коммит ${commit.slice(0, 7)}: ${message.split("\n")[0]} (изменено ${upsert.length}, удалено ${remove.length})`,
  );
  return { commit, changed: upsert.length, removed: remove.length };
}
