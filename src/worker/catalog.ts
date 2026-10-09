// Каталог ресурсов: поиск существующих ресурсов в аккаунтах, импорт, внешние ресурсы, удаление из каталога.
import type { DiscoveredResource, Resource } from "../shared/types";
import type { Store } from "./db";
import { Clients, deleteAtProvider } from "./engine";
import { cloudflareConsole } from "./providers/cloudflare";
import { supabaseConsole } from "./providers/supabase";
import { UserError } from "./service";

type Found = Omit<DiscoveredResource, "inCatalog">;

/** Ресурсы аккаунта у провайдера: репозитории, базы, сервисы, таблицы. */
async function listAtProvider(store: Store, connectionId: string): Promise<Found[]> {
  const connection = (await store.listConnections()).find((c) => c.id === connectionId);
  if (!connection) throw new UserError("Аккаунт не найден", 404);
  const clients = new Clients(store);

  switch (connection.provider) {
    case "github": {
      const gh = (await clients.github(connectionId))!;
      return (await gh.client.listRepos()).map((r) => ({
        type: "github.repo",
        kind: "repo",
        name: r.full_name,
        externalId: r.full_name,
        url: r.html_url,
        consoleUrl: r.html_url,
        meta: { branch: r.default_branch },
      }));
    }
    case "cloudflare": {
      const cf = (await clients.cloudflare(connectionId))!;
      const [dbs, workers] = await Promise.all([cf.client.listD1(), cf.client.listWorkers()]);
      return [
        ...dbs.map(
          (d): Found => ({
            type: "cloudflare.d1",
            kind: "database",
            name: d.name,
            externalId: d.uuid,
            url: null,
            consoleUrl: cloudflareConsole.d1(cf.accountId, d.uuid),
            meta: {},
          }),
        ),
        ...workers.map(
          (w): Found => ({
            type: "cloudflare.worker",
            kind: "service",
            name: w.id,
            externalId: w.id,
            url: cf.subdomain ? `https://${w.id}.${cf.subdomain}.workers.dev` : null,
            consoleUrl: cloudflareConsole.worker(cf.accountId, w.id),
            meta: {},
          }),
        ),
      ];
    }
    case "supabase": {
      const sb = (await clients.supabase(connectionId))!;
      return (await sb.client.listOrgProjects(sb.organizationSlug)).map((p) => ({
        type: "supabase.project",
        kind: "database",
        name: p.name,
        externalId: p.ref,
        url: null,
        consoleUrl: supabaseConsole.project(p.ref),
        meta: { apiUrl: `https://${p.ref}.supabase.co` },
      }));
    }
    case "render": {
      const rn = (await clients.render(connectionId))!;
      return (await rn.client.listServices(rn.ownerId)).map((s) => ({
        type: "render.service",
        kind: "service",
        name: s.name,
        externalId: s.id,
        url: s.url,
        consoleUrl: s.dashboardUrl,
        meta: {},
      }));
    }
    case "google": {
      const google = (await clients.google(connectionId))!;
      return (await google.client.listSpreadsheets()).map((f) => ({
        type: "google.sheet",
        kind: "data",
        name: f.name,
        externalId: f.id,
        url: f.webViewLink,
        consoleUrl: f.webViewLink,
        meta: {},
      }));
    }
    default:
      throw new UserError("У этого подключения нет ресурсов для каталога");
  }
}

export async function discoverResources(store: Store, connectionId: string): Promise<DiscoveredResource[]> {
  const found = await listAtProvider(store, connectionId);
  const catalog = await store.listCatalog();
  return found.map((f) => ({
    ...f,
    inCatalog: catalog.some((r) => r.connectionId === connectionId && r.type === f.type && r.externalId === f.externalId),
  }));
}

/** Берёт под наблюдение существующие ресурсы аккаунта. apphub их не создавал — и у провайдера не удалит. */
export async function importResources(
  store: Store,
  connectionId: string,
  picks: { type: string; externalId: string }[],
): Promise<Resource[]> {
  const found = await listAtProvider(store, connectionId);
  const clients = new Clients(store);
  const imported: Resource[] = [];
  for (const pick of picks) {
    const f = found.find((x) => x.type === pick.type && x.externalId === pick.externalId);
    if (!f) throw new UserError(`Не найдено в аккаунте: ${pick.externalId}`, 404);
    if (await store.findResource(f.type, connectionId, f.externalId)) continue;

    const meta = { ...f.meta };
    if (f.type === "github.repo") {
      // Деплой через Actions — если в репо есть workflow, следим за ним как за сборкой проекта
      const gh = await clients.github(connectionId);
      const workflow = (await gh?.client.listWorkflows(f.externalId).catch(() => []))?.[0];
      if (workflow) meta.workflow = String(workflow.id);
    }
    imported.push(await store.addResource({ ...f, meta, connectionId, origin: "imported" }));
  }
  return imported;
}

/** Строка подключения к своему Postgres: postgres(ql)://user:password@host:port/db */
export function parsePostgresUrl(raw: string): { host: string; port: number; database: string; user: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UserError("Некорректная строка подключения. Формат: postgresql://user:password@host:5432/database");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new UserError("Строка подключения должна начинаться с postgresql:// или postgres://");
  }
  if (!url.hostname) throw new UserError("В строке подключения нет адреса сервера");
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    user: decodeURIComponent(url.username) || "postgres",
  };
}

/** Внешняя база (свой сервер): строка подключения хранится зашифрованной, apphub проверяет доступность сервера. */
export async function addExternalPostgres(store: Store, input: { name?: string; url?: string }): Promise<Resource> {
  const name = input.name?.trim();
  if (!name) throw new UserError("Укажите название базы");
  const parsed = parsePostgresUrl(input.url ?? "");
  const externalId = `${parsed.host}:${parsed.port}/${parsed.database}`;
  if (await store.findResource("postgres.external", null, externalId)) {
    throw new UserError("Эта база уже есть в каталоге", 409);
  }
  return store.addResource(
    {
      connectionId: null,
      type: "postgres.external",
      kind: "database",
      name,
      externalId,
      url: null,
      consoleUrl: null,
      meta: { host: parsed.host, port: String(parsed.port), database: parsed.database, user: parsed.user },
      origin: "external",
    },
    input.url!.trim(),
  );
}

/**
 * Убирает ресурс из каталога. Привязанный к проектам — нельзя (сначала отвяжите или удалите проекты).
 * atProvider: удалить и у провайдера — только для созданных apphub; импортированные и внешние не трогаем никогда.
 */
export async function removeFromCatalog(store: Store, id: string, atProvider: boolean): Promise<void> {
  const resource = await store.getResource(id);
  if (!resource) throw new UserError("Ресурс не найден", 404);
  const bound = await store.bindingCount(id);
  if (bound > 0) throw new UserError(`Ресурс используется в проектах (${bound}) — сначала отвяжите его`, 409);
  if (atProvider) {
    if (resource.origin !== "created") {
      throw new UserError("apphub удаляет у провайдера только ресурсы, которые сам создал", 409);
    }
    await deleteAtProvider(store, resource);
  }
  await store.deleteResource(id);
}
