import { api } from "../api";
import { ErrorNote, ExternalLink, Loading, ProjectStatusBadge, timeAgo } from "../components";
import { href } from "../router";
import { useAsync } from "../useAsync";

export function ProjectsPage() {
  const projects = useAsync(() => api.projects(), []);
  const recipes = useAsync(() => api.recipes(), []);
  const recipeName = (id: string) => recipes.data?.find((r) => r.id === id)?.name ?? id;

  return (
    <>
      <div className="page-head">
        <h1>Проекты</h1>
        <a className="button" href={href.newProject()}>
          Новый проект
        </a>
      </div>

      <ErrorNote message={projects.error} />
      {projects.loading && !projects.data && <Loading />}

      {projects.data?.length === 0 && (
        <div className="empty">
          <h2>Пока пусто</h2>
          <p className="muted">
            Выберите рецепт: apphub создаст репозиторий, базу и сервер на бесплатных тарифах и настроит деплой.
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
              <ProjectStatusBadge status={p.status} />
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
