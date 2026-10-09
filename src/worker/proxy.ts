// Доступ к apphub без VPN: прокси на Render (Caddy из готового образа) пересылает запросы на адрес Worker.
// Прокси подписывает запросы общим секретом — только тогда apphub верит переданному им адресу (для passkey и cookie).
import { decrypt, encrypt } from "./crypto";
import type { Store } from "./db";
import { Clients } from "./engine";
import type { RenderRegion } from "./providers/render";
import { UserError } from "./service";

const META_KEY = "proxy";
const REGIONS: RenderRegion[] = ["frankfurt", "virginia", "oregon", "ohio", "singapore"];
const CADDY_IMAGE = "docker.io/library/caddy:2";

interface StoredProxy {
  connectionId: string;
  serviceId: string;
  url: string | null;
  dashboardUrl: string;
  secret: string; // зашифрован
  createdAt: number;
}

export interface ProxyInfo {
  connectionId: string;
  serviceId: string;
  url: string | null;
  dashboardUrl: string;
  createdAt: number;
  state: "live" | "deploying" | "failed" | "unknown";
  summary: string;
}

async function load(store: Store): Promise<StoredProxy | null> {
  const raw = await store.getMeta(META_KEY);
  return raw ? (JSON.parse(raw) as StoredProxy) : null;
}

// Секрет нужен на каждый запрос через прокси — держим его в памяти изолята недолго
let cached: { secret: string | null; at: number } | null = null;
const CACHE_MS = 30_000;

export async function proxySecret(store: Store): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.secret;
  const stored = await load(store);
  const secret = stored ? await decrypt(stored.secret, store.env.ENCRYPTION_KEY) : null;
  cached = { secret, at: Date.now() };
  return secret;
}

function randomSecret(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(40)), (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Команда Caddy: слушает порт Render, шлёт всё на Worker с его Host, добавляет секрет и исходный адрес.
 * В образе у бинарника есть file capability (порты < 1024), а Render запрещает такие права — exec падает с
 * «operation not permitted». Копия без capability запускается; порт 10000 прав не требует.
 */
export function caddyCommand(upstream: string, secret: string): string {
  const caddy = [
    "/tmp/caddy reverse-proxy",
    "--from :10000",
    `--to ${upstream}`,
    "--change-host-header",
    `--header-up X-Apphub-Proxy:${secret}`,
    "--header-up X-Apphub-Host:{host}",
  ].join(" ");
  return `sh -c 'cp /usr/bin/caddy /tmp/caddy && exec ${caddy}'`;
}

export async function getProxy(store: Store): Promise<ProxyInfo | null> {
  const stored = await load(store);
  if (!stored) return null;
  const base = {
    connectionId: stored.connectionId,
    serviceId: stored.serviceId,
    url: stored.url,
    dashboardUrl: stored.dashboardUrl,
    createdAt: stored.createdAt,
  };
  const render = await new Clients(store).render(stored.connectionId);
  if (!render) return { ...base, state: "unknown", summary: "Аккаунт Render прокси не подключён" };
  try {
    const [service, deploys] = await Promise.all([
      render.client.getService(stored.serviceId),
      render.client.listDeploys(stored.serviceId, 1),
    ]);
    const url = service.serviceDetails.url ?? stored.url;
    if (url !== stored.url) await store.setMeta(META_KEY, JSON.stringify({ ...stored, url }));
    const status = deploys[0]?.status;
    if (status === "live") {
      return { ...base, url, state: "live", summary: "Работает; без запросов засыпает и просыпается около минуты" };
    }
    if (status && /failed|canceled|deactivated/.test(status)) {
      return { ...base, url, state: "failed", summary: `Деплой не удался: ${status}` };
    }
    return { ...base, url, state: "deploying", summary: "Render запускает прокси (1–3 минуты)" };
  } catch (e) {
    return { ...base, state: "unknown", summary: e instanceof Error ? e.message : String(e) };
  }
}

/** Создаёт прокси. upstream — собственный адрес Worker (workers.dev или свой домен). */
export async function createProxy(
  store: Store,
  upstream: string,
  input: { connectionId?: string; region?: string },
): Promise<ProxyInfo> {
  if (await load(store)) throw new UserError("Прокси уже создан — сначала удалите его", 409);
  const host = new URL(upstream).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) {
    throw new UserError("Прокси создаётся из развёрнутого apphub — локальный адрес недоступен из Render");
  }
  const region = (input.region ?? "frankfurt") as RenderRegion;
  if (!REGIONS.includes(region)) throw new UserError("Некорректный регион");
  const render = await new Clients(store).render(input.connectionId);
  if (!render) throw new UserError("Сначала подключите Render на странице «Подключения»");

  const secret = randomSecret();
  const suffix = randomSecret()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 4);
  const service = await render.client.createImageService({
    ownerId: render.ownerId,
    name: `apphub-proxy-${suffix}`,
    imagePath: CADDY_IMAGE,
    dockerCommand: caddyCommand(upstream, secret),
    region,
  });
  const stored: StoredProxy = {
    connectionId: render.connectionId,
    serviceId: service.id,
    url: service.serviceDetails.url ?? null,
    dashboardUrl: service.dashboardUrl,
    secret: await encrypt(secret, store.env.ENCRYPTION_KEY),
    createdAt: Date.now(),
  };
  await store.setMeta(META_KEY, JSON.stringify(stored));
  cached = null;
  return (await getProxy(store))!;
}

/** Переписывает команду запуска (например, после исправления в apphub) и перезапускает прокси. */
export async function redeployProxy(store: Store, upstream: string): Promise<ProxyInfo> {
  const stored = await load(store);
  if (!stored) throw new UserError("Прокси ещё не создан", 404);
  const render = await new Clients(store).render(stored.connectionId);
  if (!render) throw new UserError("Аккаунт Render прокси не подключён");
  const secret = await decrypt(stored.secret, store.env.ENCRYPTION_KEY);
  await render.client.updateDockerCommand(stored.serviceId, caddyCommand(upstream, secret));
  await render.client.triggerDeploy(stored.serviceId);
  return (await getProxy(store))!;
}

/** Удаляет сервис в Render и забывает секрет: запросы со старым секретом больше не принимаются. */
export async function deleteProxy(store: Store): Promise<void> {
  const stored = await load(store);
  if (!stored) return;
  const render = await new Clients(store).render(stored.connectionId);
  if (render) {
    await render.client.deleteService(stored.serviceId).catch((e: unknown) => {
      // уже удалён вручную в Render — не мешаем убрать прокси из apphub
      if (!(e instanceof Error && / 404 /.test(e.message))) throw e;
    });
  }
  await store.deleteMeta(META_KEY);
  cached = null;
}
