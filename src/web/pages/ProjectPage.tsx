import { useState } from "react";
import type { ResourceKind } from "../../shared/types";
import { api } from "../api";
import { ErrorNote, ExternalLink, Loading, ProjectStatusBadge, StatusDot, timeAgo } from "../components";
import { href, navigate } from "../router";
import { useAsync } from "../useAsync";

const KIND_LABEL: Record<ResourceKind, string> = {
  repo: "Репозиторий",
  site: "Сайт",
  service: "Сервер",
  database: "База данных",
};

const RUN_STATE = (status: string, conclusion: string | null) =>
  status !== "completed" ? "pending" : conclusion === "success" ? "ok" : "error";

export function ProjectPage({ id }: { id: string }) {
  const details = useAsync(() => api.project(id), [id]);
  const status = useAsync(() => api.projectStatus(id), [id]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);

  if (details.error) return <ErrorNote message={details.error} />;
  if (!details.data) return <Loading />;

  const { project, resources, events } = details.data;
  const health = new Map(status.data?.health.map((h) => [h.resourceId, h]));

  async function deploy() {
    setDeploying(true);
    setActionError(null);
    try {
      await api.deploy(id);
      // GitHub создаёт запуск с небольшой задержкой
      setTimeout(() => void status.reload(), 3000);
      void details.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeploying(false);
    }
  }

  async function remove() {
    if (!confirm(`Убрать «${project.name}» из apphub? Репозиторий и сервисы у провайдеров останутся.`)) return;
    try {
      await api.deleteProject(id);
      navigate(href.projects);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <a className="back" href={href.projects}>
        ← Проекты
      </a>
      <div className="page-head">
        <h1>{project.name}</h1>
        <ProjectStatusBadge status={project.status} />
        <div className="spacer" />
        <button className="button button-quiet" onClick={() => void status.reload()} disabled={status.loading}>
          {status.loading ? "Проверяю…" : "Обновить статус"}
        </button>
        <button className="button" onClick={() => void deploy()} disabled={deploying || project.status !== "ready"}>
          {deploying ? "Запускаю…" : "Задеплоить"}
        </button>
      </div>

      <ErrorNote message={project.error} />
      <ErrorNote message={actionError} />
      <ErrorNote message={status.error} />

      <section>
        <h2 className="section-title">Ресурсы</h2>
        <ul className="resource-list">
          {resources.map((r) => {
            const h = health.get(r.id);
            return (
              <li key={r.id} className="resource">
                <StatusDot state={h?.state ?? "unknown"} />
                <div className="resource-main">
                  <div className="resource-title">
                    <span className="kind">{KIND_LABEL[r.kind]}</span>
                    <strong>{r.name}</strong>
                  </div>
                  <div className="muted small">{h?.summary ?? (status.loading ? "Проверяю…" : "—")}</div>
                </div>
                <div className="links">
                  {r.url && <ExternalLink url={r.url}>Открыть</ExternalLink>}
                  {r.consoleUrl && <ExternalLink url={r.consoleUrl}>Консоль</ExternalLink>}
                </div>
              </li>
            );
          })}
          {resources.length === 0 && <li className="muted">Ресурсов нет</li>}
        </ul>
      </section>

      {status.data && status.data.runs.length > 0 && (
        <section>
          <h2 className="section-title">Запуски GitHub Actions</h2>
          <ul className="resource-list">
            {status.data.runs.map((run) => (
              <li key={run.id} className="resource">
                <StatusDot state={RUN_STATE(run.status, run.conclusion)} />
                <div className="resource-main">
                  <div className="resource-title">
                    <strong>{run.name}</strong>
                    <span className="muted small">
                      {run.event} · {timeAgo(run.createdAt)}
                    </span>
                  </div>
                  {run.commitMessage && <div className="muted small">{run.commitMessage}</div>}
                </div>
                <div className="links">
                  <ExternalLink url={run.url}>Лог</ExternalLink>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="section-title">Журнал</h2>
        <ol className="log">
          {events.map((e) => (
            <li key={e.id} className={e.level === "error" ? "log-error" : undefined}>
              <time>{new Date(e.createdAt).toLocaleString("ru-RU")}</time>
              <span>{e.message}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="danger">
        <button className="button button-quiet" onClick={() => void remove()}>
          Убрать из apphub
        </button>
      </section>
    </>
  );
}
