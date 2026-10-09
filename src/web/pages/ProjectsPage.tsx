import { ErrorNote, ExternalLink, Loading, ProjectStatusBadge, StatusDot, timeAgo } from "../components";
import { errorMessage, useMonitor, useProjects, useRecipes, useRunMonitor } from "../queries";
import { href } from "../router";

export function ProjectsPage() {
  const projects = useProjects();
  const recipes = useRecipes();
  const monitor = useMonitor();
  const check = useRunMonitor();
  const recipeName = (id: string) => recipes.data?.find((r) => r.id === id)?.name ?? id;

  return (
    <>
      <div className="page-head">
        <h1>Проекты</h1>
        {monitor.data && (
          <span className="muted small" title={monitor.data.notifications ? undefined : "Telegram не подключён"}>
            {monitor.data.lastRunAt ? `Проверено ${timeAgo(monitor.data.lastRunAt)}` : "Ещё не проверялись"}
            {!monitor.data.notifications && " · без уведомлений"}
          </span>
        )}
        <button
          className="button button-quiet"
          onClick={() => check.mutate()}
          disabled={check.isPending || !projects.data?.length}
        >
          {check.isPending ? "Проверяю…" : "Проверить сейчас"}
        </button>
        <a className="button" href={href.newProject()}>
          Новый проект
        </a>
      </div>

      <ErrorNote message={errorMessage(projects.error ?? check.error)} />
      {projects.isPending && <Loading />}

      {projects.data?.length === 0 && (
        <div className="empty">
          <h2>Пока пусто</h2>
          <p className="muted">
            Выберите рецепт: AppHub создаст репозиторий, базу и сервер на бесплатных тарифах и настроит деплой.
          </p>
          <a className="button" href={href.newProject()}>
            Создать первый проект
          </a>
        </div>
      )}

      <ul className="card-list">
        {projects.data?.map((p) => (
          <li key={p.id} className="card card-link">
            <a className="card-cover" href={href.project(p.id)} aria-label={p.name} />
            <div className="card-row">
              <h2>{p.name}</h2>
              {p.alerts > 0 ? (
                <span className="badge badge-warn">
                  <StatusDot state="warn" />
                  {p.alerts === 1 ? "Проблема" : `Проблем: ${p.alerts}`}
                </span>
              ) : (
                <ProjectStatusBadge status={p.status} />
              )}
            </div>
            <p className="muted">
              {recipeName(p.recipeId)} · создан {timeAgo(p.createdAt)}
            </p>
            {p.links.length > 0 && (
              <div className="links">
                {p.links.map((l) => (
                  <ExternalLink key={l.url} url={l.url}>
                    {l.label}
                  </ExternalLink>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
