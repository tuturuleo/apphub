// Операции с проектами, общие для REST API интерфейса и MCP-сервера.
import type { AppSettings, DestroyResult, Project, ProjectSummary, Resource } from "../shared/types";
import type { Store } from "./db";
import { deleteResource, deletionOrder, missingConnections, runResourceAction, triggerDeploy } from "./engine";
import { blockingLimits, describeLimit } from "./limits";
import { GitHub, type RepoFile } from "./providers/github";
import { GoogleDrive } from "./providers/google";
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

  const missing = await missingConnections(store, recipe, params);
  if (missing.length > 0) throw new UserError(`Сначала подключите: ${missing.join(", ")}`);

  // Упрёмся в лимит бесплатного тарифа — лучше сказать сейчас, чем упасть посреди создания
  const blocked = await blockingLimits(store, recipe.needs);
  if (blocked.length > 0) {
    throw new UserError(
      `Не хватает бесплатного лимита — ${blocked.map(describeLimit).join("; ")}. ${blocked[0].note ?? ""}`.trim(),
      409,
    );
  }

  return store.createProject({ name, recipeId: recipe.id, params });
}

/**
 * Запускает создание ресурсов в фоне (Cloudflare Workflow) и сразу возвращается.
 * Прогресс виден в журнале проекта; создание не зависит от того, ждёт ли клиент ответа.
 */
export async function startProvisioning(store: Store, id: string): Promise<Project> {
  const project = await requireProject(store, id);
  if (!findRecipe(project.recipeId)) throw new UserError("Рецепт больше не существует");
  if (!(await store.claimProject(project.id))) throw new UserError("Создание уже запущено", 409);

  try {
    const instance = await store.env.PROVISION.create({
      id: `${project.id}-${Date.now()}`,
      params: { projectId: project.id },
    });
    await store.setWorkflowId(project.id, instance.id);
  } catch (e) {
    const message = `Не удалось запустить создание: ${e instanceof Error ? e.message : String(e)}`;
    await store.addEvent(project.id, "error", message);
    await store.setProjectStatus(project.id, "failed", message);
  }
  return requireProject(store, id);
}

// Проект без workflow (созданный до перехода на Workflows), не шевелившийся дольше этого, считаем прерванным
const STALE_PROVISIONING_MS = 10 * 60_000;
const FINISHED_WORKFLOW = new Set(["errored", "terminated", "complete", "unknown"]);

/**
 * Проект, застрявший в «Создаётся», переводит в «Ошибка»: фоновый процесс завершился, а статус не обновил
 * (например, рантайм оборвал его). Иначе такой проект нельзя ни пересоздать, ни удалить.
 */
export async function settleProvisioning(store: Store, project: Project): Promise<Project> {
  if (project.status !== "provisioning") return project;

  let reason: string | null = null;
  const workflowId = await store.getWorkflowId(project.id);
  if (workflowId) {
    try {
      const { status } = await (await store.env.PROVISION.get(workflowId)).status();
      if (FINISHED_WORKFLOW.has(status)) reason = `фоновый процесс завершился со статусом ${status}`;
    } catch {
      reason = "фоновый процесс не найден";
    }
  } else {
    const last = (await store.lastEventAt(project.id)) ?? project.createdAt;
    if (Date.now() - last > STALE_PROVISIONING_MS) reason = "нет движения больше 10 минут";
  }
  if (!reason) return project;

  // Повторно читаем: процесс мог успеть записать итог, пока мы проверяли
  const fresh = await requireProject(store, project.id);
  if (fresh.status !== "provisioning") return fresh;
  const message = `Создание прервалось: ${reason}. Созданные ресурсы можно удалить вместе с проектом.`;
  await store.addEvent(project.id, "error", message);
  await store.setProjectStatus(project.id, "failed", message);
  return requireProject(store, project.id);
}

export async function requireProject(store: Store, id: string): Promise<Project> {
  const project = await store.getProject(id);
  if (!project) throw new UserError("Проект не найден", 404);
  return project;
}

/**
 * Удаляет проект целиком: ресурсы у провайдеров (сервисы, базы, репозиторий) и запись в apphub.
 * Если какой-то ресурс удалить не вышло, проект остаётся с оставшимися ресурсами — можно повторить.
 */
export async function destroyProject(store: Store, id: string): Promise<DestroyResult> {
  let project = await settleProvisioning(store, await requireProject(store, id));
  if (project.status === "provisioning" || project.status === "pending") {
    // Останавливаем фоновое создание, чтобы оно не продолжило создавать ресурсы, пока мы удаляем
    const workflowId = await store.getWorkflowId(project.id);
    if (workflowId) {
      await (await store.env.PROVISION.get(workflowId)).terminate().catch(() => {});
    }
    await store.setProjectStatus(project.id, "failed", "Создание остановлено: проект удаляется");
    project = await requireProject(store, id);
  }

  const result: DestroyResult = { deleted: [], failed: [], projectRemoved: false };
  for (const resource of deletionOrder(await store.listResources(project.id))) {
    try {
      await deleteResource(store, resource);
      await store.deleteResource(resource.id);
      await store.addEvent(project.id, "info", `Удалено: ${resource.name}`);
      result.deleted.push(resource.name);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await store.addEvent(project.id, "error", `Не удалось удалить ${resource.name}: ${error}`);
      result.failed.push({ resource: resource.name, error });
    }
  }

  if (result.failed.length === 0) {
    await store.deleteProject(project.id);
    result.projectRemoved = true;
  } else {
    await store.setProjectStatus(
      project.id,
      "failed",
      `Удалены не все ресурсы: ${result.failed.map((f) => f.resource).join(", ")}. Можно повторить удаление.`,
    );
  }
  return result;
}

export async function listProjectSummaries(store: Store): Promise<ProjectSummary[]> {
  const listed = await store.listProjects();
  const projects = await Promise.all(listed.map((p) => settleProvisioning(store, p)));
  const [resources, alerts] = await Promise.all([
    store.listResources(),
    store.listAlerts(),
  ]);
  return projects.map((p) => ({
    ...p,
    alerts: alerts.filter((a) => a.projectId === p.id).length,
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

// --- Google Drive ---

/** Таблицы, доступные сервисному аккаунту Google, — для выбора источника данных. */
export async function listGoogleSheets(store: Store) {
  const google = await store.getConnection("google");
  if (!google) throw new UserError("Google Drive не подключён");
  const drive = new GoogleDrive(google.token);
  const files = await drive.listSpreadsheets();
  return {
    serviceAccount: drive.email,
    sheets: files.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, url: f.webViewLink })),
  };
}

// --- настройки ---

const AUDIENCE_RUSSIA_KEY = "settings.audienceRussia";

export async function getSettings(store: Store): Promise<AppSettings> {
  return { audienceRussia: (await store.getMeta(AUDIENCE_RUSSIA_KEY)) === "true" };
}

export async function saveSettings(store: Store, patch: Partial<AppSettings>): Promise<AppSettings> {
  if (typeof patch.audienceRussia === "boolean") {
    await store.setMeta(AUDIENCE_RUSSIA_KEY, String(patch.audienceRussia));
  }
  return getSettings(store);
}
