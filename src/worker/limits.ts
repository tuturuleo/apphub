// Лимиты бесплатных тарифов: что можно — считаем через API провайдеров, остальное показываем как известный лимит
// со ссылкой на страницу потребления. Значения лимитов — публичные условия тарифов, могут меняться.
import type { Connection, LimitItem, LimitKey, LimitState } from "../shared/types";
import type { Store } from "./db";
import { Cloudflare } from "./providers/cloudflare";
import { Render } from "./providers/render";
import { Supabase, type SupabaseProjectStatus } from "./providers/supabase";
import { escapeHtml } from "./providers/telegram";

const GB = 1024 ** 3;
const WARN_RATIO = 0.8;

// Не занимают слот активного проекта Supabase
const SUPABASE_NOT_ACTIVE: SupabaseProjectStatus[] = ["INACTIVE", "REMOVED", "INIT_FAILED"];

function stateOf(used: number | null, limit: number): LimitState {
  if (used === null) return "info";
  if (used >= limit) return "full";
  if (used >= limit * WARN_RATIO) return "warn";
  return "ok";
}

function item(
  base: Omit<LimitItem, "state" | "holders" | "note" | "consoleUrl"> &
    Partial<Pick<LimitItem, "holders" | "note" | "consoleUrl">>,
): LimitItem {
  return {
    holders: [],
    note: null,
    consoleUrl: null,
    ...base,
    state: stateOf(base.used, base.limit),
  };
}

const failed = (base: Omit<LimitItem, "state" | "used" | "holders" | "note">, e: unknown): LimitItem => ({
  ...base,
  used: null,
  holders: [],
  state: "info",
  note: `Не удалось узнать потребление: ${e instanceof Error ? e.message : String(e)}`,
});

export function formatAmount(value: number, unit: LimitItem["unit"]): string {
  switch (unit) {
    case "bytes":
      if (value >= GB) return `${(value / GB).toFixed(1)} ГБ`;
      if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} МБ`;
      return `${Math.max(1, Math.round(value / 1024))} КБ`;
    case "hours":
      return `${value} ч`;
    case "minutes":
      return `${value} мин`;
    case "requests":
      return value.toLocaleString("ru-RU");
    default:
      return String(value);
  }
}

type Account = Connection & { token: string };

async function supabaseLimits(c: Account, suffix: string): Promise<LimitItem[]> {
  const base = {
    key: "supabase.projects" as const,
    provider: "supabase" as const,
    connectionId: c.id,
    label: `Supabase: активные проекты${suffix}`,
    limit: 2,
    unit: "" as const,
    consoleUrl: "https://supabase.com/dashboard/projects",
  };
  try {
    const projects = await new Supabase(c.token).listOrgProjects(c.accountId);
    const active = projects.filter((p) => !SUPABASE_NOT_ACTIVE.includes(p.status));
    return [
      item({
        ...base,
        used: active.length,
        holders: active.map((p) => p.name),
        note: "Проекты на паузе слот не занимают. Освободить: удалить проект или поставить его на паузу.",
      }),
    ];
  } catch (e) {
    return [failed(base, e)];
  }
}

async function cloudflareLimits(c: Account, suffix: string): Promise<LimitItem[]> {
  const consoleUrl = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";
  const common = { provider: "cloudflare" as const, connectionId: c.id, consoleUrl };
  const client = new Cloudflare(c.token, c.accountId);
  const items: LimitItem[] = [];
  try {
    const dbs = await client.listD1();
    items.push(
      item({
        ...common,
        key: "cloudflare.d1.count",
        label: `Cloudflare D1: базы${suffix}`,
        used: dbs.length,
        limit: 10,
        unit: "",
        holders: dbs.map((d) => d.name),
      }),
      item({
        ...common,
        key: "cloudflare.d1.storage",
        label: `Cloudflare D1: объём всех баз${suffix}`,
        used: dbs.reduce((sum, d) => sum + (d.file_size ?? 0), 0),
        limit: 5 * GB,
        unit: "bytes",
        note: "Одна база — до 500 МБ.",
      }),
    );
  } catch (e) {
    items.push(
      failed({ ...common, key: "cloudflare.d1.count", label: `Cloudflare D1: базы${suffix}`, limit: 10, unit: "" }, e),
    );
  }
  const workersBase = {
    ...common,
    key: "cloudflare.workers" as const,
    label: `Cloudflare Workers: скрипты${suffix}`,
    limit: 100,
    unit: "" as const,
  };
  try {
    const workers = await client.listWorkers();
    items.push(item({ ...workersBase, used: workers.length, holders: workers.map((w) => w.id) }));
  } catch (e) {
    items.push(failed(workersBase, e));
  }
  items.push(
    item({
      ...common,
      key: "cloudflare.requests",
      label: `Cloudflare Workers: запросы в сутки${suffix}`,
      used: null,
      limit: 100_000,
      unit: "requests",
      note: "На все Workers аккаунта. Сверх лимита запросы получают ошибку до конца суток (UTC).",
    }),
  );
  return items;
}

async function renderLimits(c: Account, suffix: string): Promise<LimitItem[]> {
  const base = {
    key: "render.hours" as const,
    provider: "render" as const,
    connectionId: c.id,
    label: `Render: часы работы бесплатных сервисов в месяц${suffix}`,
    limit: 750,
    unit: "hours" as const,
    consoleUrl: "https://dashboard.render.com/billing",
  };
  try {
    const free = (await new Render(c.token).listServices(c.accountId)).filter((s) => s.plan === "free");
    return [
      item({
        ...base,
        used: null,
        holders: free.map((s) => s.name),
        note:
          `Бесплатных сервисов: ${free.length}. Сервис расходует часы, пока не спит (засыпает через 15 минут ` +
          "без запросов): одного постоянно работающего хватает почти на весь месяц. Потребление — в панели Render.",
      }),
    ];
  } catch (e) {
    return [failed(base, e)];
  }
}

function githubLimits(c: Account, suffix: string): LimitItem[] {
  return [
    item({
      key: "github.actions",
      provider: "github",
      connectionId: c.id,
      label: `GitHub Actions: минуты для приватных репозиториев${suffix}`,
      used: null,
      limit: 2000,
      unit: "minutes",
      note: "Для публичных репозиториев без лимита. Сборки по расписанию в приватных репо расходуют минуты.",
      consoleUrl: "https://github.com/settings/billing/usage",
    }),
  ];
}

/** Лимиты по каждому подключённому аккаунту. Аккаунт, который не отвечает, не ломает остальные. */
export async function collectLimits(store: Store): Promise<LimitItem[]> {
  const connections = await store.listConnections();
  const perProvider = (provider: string) => connections.filter((c) => c.provider === provider).length;
  const tasks = connections.map(async (meta): Promise<LimitItem[]> => {
    // Подпись аккаунта нужна, только когда у провайдера их несколько
    const suffix = perProvider(meta.provider) > 1 ? ` · ${meta.label}` : "";
    const fetchers: Partial<Record<string, (c: Account, suffix: string) => Promise<LimitItem[]> | LimitItem[]>> = {
      supabase: supabaseLimits,
      cloudflare: cloudflareLimits,
      render: renderLimits,
      github: githubLimits,
    };
    const fetcher = fetchers[meta.provider];
    if (!fetcher) return [];
    const account = await store.getConnectionById(meta.id).catch(() => null);
    return account ? fetcher(account, suffix) : [];
  });
  return (await Promise.all(tasks)).flat();
}

/** Лимиты выбранных аккаунтов, которые не дадут создать проект по рецепту. */
export async function blockingLimits(store: Store, needs: LimitKey[], accounts: string[]): Promise<LimitItem[]> {
  if (needs.length === 0) return [];
  return (await collectLimits(store)).filter(
    (l) => needs.includes(l.key) && accounts.includes(l.connectionId) && l.state === "full",
  );
}

export function describeLimit(l: LimitItem): string {
  const amount = l.used === null ? "" : `: ${formatAmount(l.used, l.unit)} из ${formatAmount(l.limit, l.unit)}`;
  const holders = l.holders.length > 0 ? ` (${l.holders.join(", ")})` : "";
  return `${l.label}${amount}${holders}`;
}

const metaKey = (l: LimitItem) => `limit:${l.key}:${l.connectionId}`;

/**
 * Сообщения о переходах лимитов: «почти исчерпан» / «исчерпан» и обратно в норму.
 * Состояние хранится в meta — о длящейся ситуации не пишем повторно.
 */
export async function limitTransitions(store: Store, limits: LimitItem[]): Promise<string[]> {
  const messages: string[] = [];
  for (const l of limits) {
    if (l.state === "info") continue;
    const previous = (await store.getMeta(metaKey(l))) ?? "ok";
    if (previous === l.state) continue;
    await store.setMeta(metaKey(l), l.state);
    if (l.state === "ok") {
      messages.push(`✅ <b>Лимит</b>\n${escapeHtml(l.label)}: снова есть запас`);
    } else {
      const word = l.state === "full" ? "исчерпан" : "почти исчерпан";
      messages.push(`⚠️ <b>Лимит ${word}</b>\n${escapeHtml(describeLimit(l))}`);
    }
  }
  return messages;
}
