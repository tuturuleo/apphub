import { useState } from "react";
import type { Resource, ResourceActionId, ResourceKind } from "../../shared/types";
import { ErrorNote, ExternalLink, Loading, ProjectStatusBadge, StatusDot, UpdatedAt, timeAgo } from "../components";
import {
  errorMessage,
  useDeleteProject,
  useDeploy,
  useProject,
  useProjectStatus,
  useResourceAction,
  useStartProvision,
} from "../queries";
import { href, navigate } from "../router";

const KIND_LABEL: Record<ResourceKind, string> = {
  repo: "Репозиторий",
  site: "Сайт",
  service: "Сервер",
  database: "База данных",
};

const RUN_STATE = (status: string, conclusion: string | null) =>
  status !== "completed" ? "pending" : conclusion === "success" ? "ok" : "error";

// Сколько после ручного деплоя опрашивать часто: GitHub создаёт запуск с задержкой
const DEPLOY_BOOST_MS = 60_000;

export function ProjectPage({ id }: { id: string }) {
  const details = useProject(id);
  const projectStatus = details.data?.project.status;
  // Пока ресурсы создаются, статусы у провайдеров не запрашиваем — включатся сами по завершении
  const settled = projectStatus === "ready" || projectStatus === "failed";
  const [boostUntil, setBoostUntil] = useState(0);
  const status = useProjectStatus(id, { enabled: settled, boostUntil });

  const deploy = useDeploy(id);
  const provision = useStartProvision(id);
  const action = useResourceAction(id);
  const remove = useDeleteProject();

  if (details.error) return <ErrorNote message={errorMessage(details.error)} />;
  if (!details.data) return <Loading />;

  const { project, resources, events } = details.data;
  const health = new Map(status.data?.health.map((h) => [h.resourceId, h]));
  const actionError = errorMessage(deploy.error ?? provision.error ?? action.error ?? remove.error);
  const statusError = errorMessage(status.error);
  // Статус возвращает алерты после сверки — они свежее, чем в деталях проекта
  const alerts = status.data?.alerts ?? details.data.alerts;

  function runDeploy() {
    deploy.mutate(undefined, { onSuccess: () => setBoostUntil(Date.now() + DEPLOY_BOOST_MS) });
  }

  function runAction(resource: Resource, actionId: ResourceActionId) {
    action.mutate({ resourceId: resource.id, action: actionId });
  }

  function removeProject() {
    if (!confirm(`Убрать «${project.name}» из apphub? Репозиторий и сервисы у провайдеров останутся.`)) return;
    remove.mutate(id, { onSuccess: () => navigate(href.projects) });
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
        {settled && <UpdatedAt at={status.dataUpdatedAt} fetching={status.isFetching} />}
        <button
          className="button button-quiet"
          onClick={() => void status.refetch()}
          disabled={!settled || status.isFetching}
        >
          Обновить
        </button>
        <button className="button" onClick={runDeploy} disabled={deploy.isPending || project.status !== "ready"}>
          {deploy.isPending ? "Запускаю…" : "Задеплоить"}
        </button>
      </div>

      {project.status === "pending" && (
        <div className="note">
          Создание ресурсов ещё не запущено.{" "}
          <button className="link-button" onClick={() => provision.mutate()} disabled={provision.isPending}>
            Запустить
          </button>
        </div>
      )}
      {project.status === "provisioning" && (
        <div className="note">Создаю ресурсы у провайдеров — прогресс в журнале ниже.</div>
      )}
      <ErrorNote message={project.error} />
      {alerts.length > 0 && (
        <div className="note note-warn">
          <strong>Проблемы, найденные мониторингом</strong>
          <ul>
            {alerts.map((a) => (
              <li key={a.key}>
                {a.message} <span className="muted small">· {timeAgo(a.createdAt)}</span>
                {a.url && (
                  <>
                    {" "}
                    <ExternalLink url={a.url}>Открыть</ExternalLink>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNote message={actionError} />
      {statusError !== project.error && <ErrorNote message={statusError} />}

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
                  <div className="muted small">{h?.summary ?? (!settled ? "Создаётся…" : status.isPending ? "Проверяю…" : "—")}</div>
                </div>
                <div className="links">
                  {h?.action && (
                    <button
                      className="link-button"
                      onClick={() => runAction(r, h.action!.id)}
                      disabled={action.isPending && action.variables?.resourceId === r.id}
                    >
                      {action.isPending && action.variables?.resourceId === r.id ? "…" : h.action.label}
                    </button>
                  )}
                  {r.url && <ExternalLink url={r.url}>Открыть</ExternalLink>}
                  {r.consoleUrl && <ExternalLink url={r.consoleUrl}>Консоль</ExternalLink>}
                </div>
              </li>
            );
          })}
          {resources.length === 0 && <li className="resource muted">Ресурсов нет</li>}
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
        <button className="button button-quiet" onClick={removeProject} disabled={remove.isPending}>
          Убрать из apphub
        </button>
      </section>
    </>
  );
}
