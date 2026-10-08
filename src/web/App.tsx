import { ConnectionsPage } from "./pages/ConnectionsPage";
import { NewProjectPage } from "./pages/NewProjectPage";
import { ProjectPage } from "./pages/ProjectPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { href, useRoute } from "./router";

export function App() {
  const route = useRoute();

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href={href.projects}>
          <span className="brand-mark" aria-hidden>
            ▲
          </span>
          apphub
        </a>
        <nav>
          <a href={href.projects} aria-current={route.page !== "connections" ? "page" : undefined}>
            Проекты
          </a>
          <a href={href.connections} aria-current={route.page === "connections" ? "page" : undefined}>
            Подключения
          </a>
        </nav>
      </header>
      <main className="content">
        {route.page === "projects" && <ProjectsPage />}
        {route.page === "new" && <NewProjectPage recipeId={route.recipeId} />}
        {route.page === "project" && <ProjectPage id={route.id} />}
        {route.page === "connections" && <ConnectionsPage />}
      </main>
    </div>
  );
}
