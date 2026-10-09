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
import { Render, type RenderDeploy, type RenderDeployStatus } from "./providers/render";
import { Supabase, type SupabaseProjectStatus } from "./providers/supabase";
import type { CloudflareAccess, GitHubAccess, Recipe, RenderAccess, SupabaseAccess } from "./recipes/types";

interface Clients {
  github: GitHubAccess | null;
  cloudflare: CloudflareAccess | null;
  supabase: SupabaseAccess | null;
  render: RenderAccess | null;
}

async function loadClients(store: Store): Promise<Clients> {
  const [gh, cf, sb, rn] = await Promise.all([
    store.getConnection("github"),
    store.getConnection("cloudflare"),
    store.getConnection("supabase"),
    store.getConnection("render"),
  ]);
  return {
    github: gh ? { client: new GitHub(gh.token), login: gh.accountId } : null,
    cloudflare: cf
      ? {
          client: new Cloudflare(cf.token, cf.accountId),
          accountId: cf.accountId,
          subdomain: cf.meta.subdomain ?? "",
          token: cf.token,
        }
      : null,
    supabase: sb ? { client: new Supabase(sb.token), organizationSlug: sb.accountId } : null,
    render: rn ? { client: new Render(rn.token), ownerId: rn.accountId } : null,
  };
}

export async function missingConnections(store: Store, recipe: Recipe): Promise<ProviderId[]> {
  const connected = new Set((await store.listConnections()).map((c) => c.provider));
  return recipe.requires.filter((p) => !connected.has(p));
}

export async function provision(store: Store, recipe: Recipe, project: Project): Promise<void> {
  const require = <T>(value: T | null, provider: ProviderId): T => {
    if (!value) throw new Error(`Не подключён ${provider}`);
    return value;
  };

  try {
    const clients = await loadClients(store);
    await recipe.provision({
      project,
      params: project.params,
      github: () => require(clients.github, "github"),
      cloudflare: () => require(clients.cloudflare, "cloudflare"),
      supabase: () => require(clients.supabase, "supabase"),
      render: () => require(clients.render, "render"),
      log: (message) => store.addEvent(project.id, "info", message),
      addResource: (r) => store.addResource({ ...r, projectId: project.id }),
    });
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
  latestGithubRun: WorkflowRun | undefined;
  renderDeploys: Map<string, RenderDeploy[]>;
}

async function checkResource(
  r: Resource,
  clients: Clients,
  ctx: CheckContext,
): Promise<Omit<ResourceHealth, "resourceId">> {
  switch (r.type) {
    case "render.service": {
      if (!clients.render) return { state: "unknown", summary: "Render не подключён" };
      const service = await clients.render.client.getService(r.externalId);
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
      // Репозиторий без GitHub Actions (сборку делает Render) — нечего проверять в запусках
      if (!r.meta.workflow) return { state: "ok", summary: "Сборка и деплой — в Render" };
      const run = runHealth(ctx.latestGithubRun);
      if (run.state === "error" || !clients.github) return run;
      // GitHub отключает workflow с расписанием в репо без активности дольше 60 дней
      const disabled = (await clients.github.client.listWorkflows(r.externalId)).filter(
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
      if (!clients.github) return { state: "unknown", summary: "GitHub не подключён" };
      const pages = await clients.github.client.getPages(r.externalId);
      if (pages.status === "errored") return { state: "error", summary: "Ошибка публикации Pages" };
      if (pages.status === "building" || pages.status === "queued") return { state: "pending", summary: "Публикуется" };
      const res = await fetch(pages.html_url, { method: "HEAD", redirect: "follow" });
      return res.ok
        ? { state: "ok", summary: "Сайт отвечает" }
        : { state: res.status === 404 ? "pending" : "error", summary: `Сайт отвечает ${res.status}` };
    }

    case "cloudflare.worker": {
      if (!clients.cloudflare) return { state: "unknown", summary: "Cloudflare не подключён" };
      const deployment = await clients.cloudflare.client.latestDeployment(r.externalId);
      if (!deployment) return { state: "pending", summary: "Ещё не задеплоен" };
      return { state: "ok", summary: `Задеплоен ${new Date(deployment.created_on).toLocaleString("ru-RU")}` };
    }

    case "cloudflare.d1": {
      if (!clients.cloudflare) return { state: "unknown", summary: "Cloudflare не подключён" };
      const db = await clients.cloudflare.client.getD1(r.externalId);
      return {
        state: "ok",
        summary: `Таблиц: ${db.num_tables ?? 0}, размер ${formatBytes(db.file_size ?? 0)}`,
      };
    }

    case "supabase.project": {
      if (!clients.supabase) return { state: "unknown", summary: "Supabase не подключён" };
      const project = await clients.supabase.client.getProject(r.externalId);
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
  const clients = await loadClients(store);
  const repo = resources.find((r) => r.type === "github.repo");

  let githubRuns: WorkflowRun[] = [];
  if (repo && clients.github && repo.meta.workflow) {
    try {
      githubRuns = await clients.github.client.listRuns(repo.externalId);
    } catch {
      // статус репо ниже покажет, что что-то не так
    }
  }

  const renderDeploys = new Map<string, RenderDeploy[]>();
  let renderRuns: WorkflowRun[] = [];
  for (const r of resources.filter((x) => x.type === "render.service")) {
    if (!clients.render) break;
    try {
      const deploys = await clients.render.client.listDeploys(r.externalId);
      renderDeploys.set(r.id, deploys);
      renderRuns = renderRuns.concat(deploys.map((d) => renderRun(d, r.consoleUrl)));
    } catch {
      // статус сервиса ниже покажет, что что-то не так
    }
  }

  const ctx: CheckContext = { latestGithubRun: githubRuns[0], renderDeploys };
  const health = await Promise.all(
    resources.map(async (r): Promise<ResourceHealth> => {
      try {
        return { resourceId: r.id, ...(await checkResource(r, clients, ctx)) };
      } catch (e) {
        // Не смогли проверить (сеть, лимиты API) — это не проблема ресурса, алерт не нужен
        return {
          resourceId: r.id,
          state: "unknown",
          summary: `Не удалось проверить: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }),
  );
  const runs = [...githubRuns, ...renderRuns]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);
  return { health, runs };
}

export async function runResourceAction(store: Store, resource: Resource, action: string): Promise<string> {
  if (resource.type === "supabase.project" && action === "wake") {
    const sb = await store.getConnection("supabase");
    if (!sb) throw new Error("Supabase не подключён");
    await new Supabase(sb.token).restoreProject(resource.externalId);
    return `Supabase: ${resource.name} просыпается`;
  }
  if (resource.type === "github.repo" && action === "enable_workflows") {
    const gh = await store.getConnection("github");
    if (!gh) throw new Error("GitHub не подключён");
    const github = new GitHub(gh.token);
    const disabled = (await github.listWorkflows(resource.externalId)).filter((w) => w.state === "disabled_inactivity");
    await Promise.all(disabled.map((w) => github.enableWorkflow(resource.externalId, w.id)));
    return disabled.length > 0
      ? `Включены workflow: ${disabled.map((w) => w.name).join(", ")}`
      : "Отключённых workflow нет";
  }
  throw new Error("Действие недоступно для этого ресурса");
}

export async function triggerDeploy(store: Store, resources: Resource[]): Promise<void> {
  // Сервис Render собирается сам из репозитория — просим Render задеплоить последний коммит
  const render = resources.find((r) => r.type === "render.service");
  if (render) {
    const rn = await store.getConnection("render");
    if (!rn) throw new Error("Render не подключён");
    await new Render(rn.token).triggerDeploy(render.externalId);
    return;
  }
  const repo = resources.find((r) => r.type === "github.repo");
  if (!repo) throw new Error("У проекта нет репозитория");
  const gh = await store.getConnection("github");
  if (!gh) throw new Error("GitHub не подключён");
  await new GitHub(gh.token).dispatchWorkflow(
    repo.externalId,
    repo.meta.workflow ?? "deploy.yml",
    repo.meta.branch ?? "main",
  );
}

// --- удаление ---

/** Порядок удаления: сначала то, что зависит от остального (сервисы), репозиторий — последним. */
const DELETE_ORDER: ResourceType[] = [
  "render.service",
  "cloudflare.worker",
  "github.pages",
  "cloudflare.d1",
  "supabase.project",
  "github.repo",
];

export function deletionOrder(resources: Resource[]): Resource[] {
  return [...resources].sort((a, b) => DELETE_ORDER.indexOf(a.type) - DELETE_ORDER.indexOf(b.type));
}

/** Удаляет ресурс у провайдера. Уже удалённый (404) — не ошибка. */
export async function deleteResource(store: Store, r: Resource): Promise<void> {
  const clients = await loadClients(store);
  const need = <T>(value: T | null, provider: string): T => {
    if (!value) throw new Error(`${provider} не подключён`);
    return value;
  };
  try {
    switch (r.type) {
      case "github.pages":
        return; // уходит вместе с репозиторием
      case "github.repo":
        return await need(clients.github, "GitHub").client.deleteRepo(r.externalId);
      case "cloudflare.worker":
        return await need(clients.cloudflare, "Cloudflare").client.deleteWorker(r.externalId);
      case "cloudflare.d1":
        return await need(clients.cloudflare, "Cloudflare").client.deleteD1(r.externalId);
      case "supabase.project":
        return await need(clients.supabase, "Supabase").client.deleteProject(r.externalId);
      case "render.service":
        return await need(clients.render, "Render").client.deleteService(r.externalId);
    }
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) return;
    throw e;
  }
}
