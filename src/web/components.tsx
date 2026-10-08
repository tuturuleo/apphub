import type { HealthState, ProjectStatus } from "../shared/types";

const PROJECT_STATUS: Record<ProjectStatus, { label: string; state: HealthState }> = {
  pending: { label: "В очереди", state: "pending" },
  provisioning: { label: "Создаётся", state: "pending" },
  ready: { label: "Готов", state: "ok" },
  failed: { label: "Ошибка", state: "error" },
};

export function StatusDot({ state }: { state: HealthState }) {
  return <span className={`dot dot-${state}`} aria-hidden />;
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const { label, state } = PROJECT_STATUS[status];
  return (
    <span className={`badge badge-${state}`}>
      <StatusDot state={state} />
      {label}
    </span>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="note note-error" role="alert">
      {message}
    </div>
  );
}

export function Loading() {
  return <p className="muted">Загрузка…</p>;
}

export function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  );
}

const rtf = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });

export function timeAgo(date: string | number): string {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}
