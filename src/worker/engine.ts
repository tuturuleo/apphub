// Выполнение рецептов и сбор статусов ресурсов.
import type {
  Project,
  ProjectStatusReport,
  ProviderId,
  Resource,
  ResourceHealth,
  WorkflowRun,
} from "../shared/types";
import type { Store } from "./db";
import { Cloudflare } from "./providers/cloudflare";
import { GitHub } from "./providers/github";
import { Supabase, type SupabaseProjectStatus } from "./providers/supabase";
import type { CloudflareAccess, GitHubAccess, Recipe, SupabaseAccess } from "./recipes/types";

interface Clients {
  github: GitHubAccess | null;
  cloudflare: CloudflareAccess | null;
  supabase: SupabaseAccess | null;
}

async function loadClients(store: Store): Promise<Clients> {
  const [gh, cf, sb] = await Promise.all([
    store.getConnection("github"),
    store.getConnection("cloudflare"),
    store.getConnection("supabase"),
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

async function checkResource(
  r: Resource,
  clients: Clients,
  latestRun: WorkflowRun | undefined,
): Promise<Omit<ResourceHealth, "resourceId">> {
  switch (r.type) {
    case "github.repo":
      return runHealth(latestRun);

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

  let runs: WorkflowRun[] = [];
  if (repo && clients.github) {
    try {
      runs = await clients.github.client.listRuns(repo.externalId);
    } catch {
      // статус репо ниже покажет, что что-то не так
    }
  }

  const health = await Promise.all(
    resources.map(async (r): Promise<ResourceHealth> => {
      try {
        return { resourceId: r.id, ...(await checkResource(r, clients, runs[0])) };
      } catch (e) {
        return { resourceId: r.id, state: "error", summary: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return { health, runs };
}

export async function runResourceAction(store: Store, resource: Resource, action: string): Promise<string> {
  if (resource.type === "supabase.project" && action === "wake") {
    const sb = await store.getConnection("supabase");
    if (!sb) throw new Error("Supabase не подключён");
    await new Supabase(sb.token).restoreProject(resource.externalId);
    return `Supabase: ${resource.name} просыпается`;
  }
  throw new Error("Действие недоступно для этого ресурса");
}

export async function triggerDeploy(store: Store, resources: Resource[]): Promise<void> {
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
