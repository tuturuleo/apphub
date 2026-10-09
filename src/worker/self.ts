// apphub следит сам за собой: развёрнутый экземпляр появляется в списке проектов со своим Worker, базой D1
// и прокси на Render. Ресурсы помечены как импортированные — удаление проекта их у провайдера не тронет,
// а сам проект удалить нельзя.
import type { Project, ResourceType } from "../shared/types";
import type { NewResource, Store } from "./db";
import { Clients } from "./engine";
import { cloudflareConsole } from "./providers/cloudflare";
import { UserError } from "./service";

const SELF_KEY = "self.project";
const CHECKED_KEY = "self.checkedAt";
const RETRY_MS = 10 * 60_000;

export async function selfProjectId(store: Store): Promise<string | null> {
  return store.getMeta(SELF_KEY);
}

export async function assertNotSelf(store: Store, projectId: string): Promise<void> {
  if ((await selfProjectId(store)) === projectId) {
    throw new UserError("Это сам apphub — удалить его изнутри нельзя. Удаляется он в консоли Cloudflare.");
  }
}

async function ensureResource(
  store: Store,
  projectId: string,
  r: Omit<NewResource, "origin">,
  role: string,
): Promise<void> {
  const resource =
    (await store.findResource(r.type as ResourceType, r.connectionId, r.externalId)) ??
    (await store.addResource({ ...r, origin: "imported" }));
  const bound = (await store.listResources(projectId)).some((b) => b.id === resource.id);
  if (!bound) await store.bindResource(projectId, resource.id, role);
}

/**
 * Проект «apphub» для развёрнутого экземпляра. origin — адрес Worker (запрос пришёл на него, а не через прокси).
 * Нужен аккаунт Cloudflare, в котором живёт Worker; без него попытка повторяется не чаще раза в 10 минут.
 */
export async function ensureSelfProject(store: Store, origin: string): Promise<void> {
  const host = new URL(origin).hostname;
  const match = host.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev$/);
  let projectId = await selfProjectId(store);

  if (projectId && !(await store.getProject(projectId))) projectId = null;
  if (!projectId) {
    if (!match) return;
    const checked = Number((await store.getMeta(CHECKED_KEY)) ?? 0);
    if (Date.now() - checked < RETRY_MS) return;

    const [, workerName, subdomain] = match;
    const clients = new Clients(store);
    const accounts = (await store.listConnections()).filter((c) => c.provider === "cloudflare");
    let cf = null;
    for (const a of accounts) {
      const access = await clients.cloudflare(a.id);
      if (access?.subdomain === subdomain) {
        cf = access;
        break;
      }
    }
    if (!cf) {
      // Аккаунт Cloudflare с этим Worker ещё не подключён — проверим позже
      await store.setMeta(CHECKED_KEY, String(Date.now()));
      return;
    }

    const name = (await store.getProjectByName("apphub")) ? `apphub-${workerName}` : "apphub";
    const project: Project = await store.createProject({ name, recipeId: "custom", params: {} });
    await store.setProjectStatus(project.id, "ready");
    await store.setMeta(SELF_KEY, project.id);
    projectId = project.id;

    await ensureResource(
      store,
      projectId,
      {
        connectionId: cf.connectionId,
        type: "cloudflare.worker",
        kind: "service",
        name: workerName,
        externalId: workerName,
        url: origin,
        consoleUrl: cloudflareConsole.worker(cf.accountId, workerName),
        meta: {},
      },
      "service",
    );
    const db = (await cf.client.listD1()).find((d) => d.name === "apphub" || d.name === workerName);
    if (db) {
      await ensureResource(
        store,
        projectId,
        {
          connectionId: cf.connectionId,
          type: "cloudflare.d1",
          kind: "database",
          name: db.name,
          externalId: db.uuid,
          url: null,
          consoleUrl: cloudflareConsole.d1(cf.accountId, db.uuid),
          meta: {},
        },
        "database",
      );
    }
    await store.addEvent(projectId, "info", "apphub добавлен в свои проекты: Worker и база под наблюдением");
  }

  await syncProxy(store, projectId);
}

/** Прокси на Render — тоже часть apphub: появляется в проекте при создании и уходит при удалении. */
export async function syncProxy(store: Store, projectId?: string | null): Promise<void> {
  projectId ??= await selfProjectId(store);
  if (!projectId) return;
  const raw = await store.getMeta("proxy");
  const proxy = raw
    ? (JSON.parse(raw) as { connectionId: string; serviceId: string; url: string | null; dashboardUrl: string })
    : null;
  const bound = await store.listResources(projectId);
  for (const r of bound) {
    if (r.type === "render.service" && r.externalId !== proxy?.serviceId) {
      await store.unbindResource(projectId, r.id);
      if (r.origin === "imported" && (await store.bindingCount(r.id)) === 0) await store.deleteResource(r.id);
    }
  }
  if (proxy) {
    await ensureResource(
      store,
      projectId,
      {
        connectionId: proxy.connectionId,
        type: "render.service",
        kind: "service",
        name: "Прокси без VPN",
        externalId: proxy.serviceId,
        url: proxy.url,
        consoleUrl: proxy.dashboardUrl,
        meta: {},
      },
      "proxy",
    );
  }
}
