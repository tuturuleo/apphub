// Мониторинг проектов: по расписанию (cron) или по кнопке проверяет статусы ресурсов,
// открывает и закрывает алерты и шлёт в Telegram только изменения — новую проблему или её исправление.
import type { MonitorResult, Project, ProjectStatusReport, Resource, ResourceKind } from "../shared/types";
import type { Store } from "./db";
import { projectStatus } from "./engine";
import { Telegram, escapeHtml } from "./providers/telegram";

const KIND_LABEL: Record<ResourceKind, string> = {
  repo: "Репозиторий",
  site: "Сайт",
  service: "Сервер",
  database: "База данных",
};

export interface AlertCandidate {
  key: string;
  message: string;
  url: string | null;
}

/**
 * Проблемы проекта по свежим статусам. Ключ — ресурс + вид проблемы, без текста статуса:
 * если «Deploy: failure» сменится на «Deploy: cancelled», это та же проблема и повторно не пишем.
 */
export function deriveAlerts(resources: Resource[], report: ProjectStatusReport): AlertCandidate[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const alerts: AlertCandidate[] = [];
  for (const h of report.health) {
    if (h.state !== "error" && h.state !== "warn") continue;
    const r = byId.get(h.resourceId);
    if (!r) continue;
    const url = r.type === "github.repo" && h.state === "error" ? (report.runs[0]?.url ?? r.consoleUrl) : r.consoleUrl;
    alerts.push({
      key: `${r.id}:${h.state}`,
      message: `${KIND_LABEL[r.kind]} ${r.name}: ${h.summary}`,
      url: url ?? r.url,
    });
  }
  return alerts;
}

const LAST_RUN_KEY = "monitor.lastRunAt";
const TELEGRAM_LIMIT = 4000;

export async function getLastRunAt(store: Store): Promise<number | null> {
  const value = await store.getMeta(LAST_RUN_KEY);
  return value ? Number(value) : null;
}

function link(url: string | null): string {
  return url ? `\n<a href="${escapeHtml(url)}">Открыть</a>` : "";
}

/** Склеивает сообщения в несколько, не превышая лимит Telegram на длину. */
export function chunkMessages(parts: string[], limit = TELEGRAM_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    const next = current ? `${current}\n\n${part}` : part;
    if (next.length > limit && current) {
      chunks.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

interface Reconciled {
  opened: number;
  resolved: number;
  /** Сообщения для Telegram об изменениях. */
  messages: string[];
}

/**
 * Сверяет активные алерты проекта со свежими статусами: открывает новые проблемы и закрывает исправленные.
 * Вызывается и мониторингом, и при каждом просмотре статуса — чтобы видимое в интерфейсе и уведомления не расходились.
 */
export async function reconcileAlerts(
  store: Store,
  project: Project,
  resources: Resource[],
  report: ProjectStatusReport,
): Promise<Reconciled> {
  const result: Reconciled = { opened: 0, resolved: 0, messages: [] };
  // Пока ресурсы создаются, их статусы неполные — проблемами их не считаем
  if (project.status !== "ready") return result;

  const current = deriveAlerts(resources, report);
  const active = await store.listAlerts(project.id);
  const title = `<b>${escapeHtml(project.name)}</b>`;

  for (const alert of current) {
    if (active.some((a) => a.key === alert.key)) continue;
    if (!(await store.openAlert(project.id, alert))) continue;
    result.opened++;
    await store.addEvent(project.id, "error", `Проблема: ${alert.message}`);
    result.messages.push(`⚠️ ${title}\n${escapeHtml(alert.message)}${link(alert.url)}`);
  }

  for (const alert of active) {
    if (current.some((c) => c.key === alert.key)) continue;
    if (!(await store.resolveAlert(project.id, alert.key))) continue;
    result.resolved++;
    await store.addEvent(project.id, "info", `Исправлено: ${alert.message}`);
    result.messages.push(`✅ ${title}\nИсправлено: ${escapeHtml(alert.message)}`);
  }
  return result;
}

/** Отправляет сообщения в Telegram, если он подключён. true — отправлено. */
export async function notify(store: Store, messages: string[]): Promise<boolean> {
  if (messages.length === 0) return false;
  const telegram = await store.getConnection("telegram").catch(() => null);
  if (!telegram) return false;
  try {
    const bot = new Telegram(telegram.token);
    for (const chunk of chunkMessages(messages)) await bot.send(telegram.accountId, chunk);
    return true;
  } catch (e) {
    console.error("Не удалось отправить уведомление в Telegram", e);
    return false;
  }
}

export async function runMonitor(store: Store): Promise<MonitorResult> {
  const projects = (await store.listProjects()).filter((p) => p.status === "ready");
  const messages: string[] = [];
  let opened = 0;
  let resolved = 0;

  for (const project of projects) {
    const resources = await store.listResources(project.id);
    const report = await projectStatus(store, resources);
    const r = await reconcileAlerts(store, project, resources, report);
    opened += r.opened;
    resolved += r.resolved;
    messages.push(...r.messages);
  }

  await store.setMeta(LAST_RUN_KEY, String(Date.now()));
  const notified = await notify(store, messages);
  return { checked: projects.length, opened, resolved, notified };
}
