import { ChatPage } from "./pages/ChatPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { LimitsPage } from "./pages/LimitsPage";
import { ResourcesPage } from "./pages/ResourcesPage";
import { SecurityPage } from "./pages/SecurityPage";
import { AuthGate } from "./auth";
import { NewProjectPage } from "./pages/NewProjectPage";
import { ProjectPage } from "./pages/ProjectPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { href, useRoute } from "./router";

export function App() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  );
}

function Shell() {
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
          <a
            href={href.projects}
            aria-current={["projects", "project", "new"].includes(route.page) ? "page" : undefined}
          >
            Проекты
          </a>
          <a href={href.resources} aria-current={route.page === "resources" ? "page" : undefined}>
            Ресурсы
          </a>
          <a href={href.chat} aria-current={route.page === "chat" ? "page" : undefined}>
            Ассистент
          </a>
          <a href={href.limits} aria-current={route.page === "limits" ? "page" : undefined}>
            Лимиты
          </a>
          <a href={href.connections} aria-current={route.page === "connections" ? "page" : undefined}>
            Подключения
          </a>
          <a href={href.security} aria-current={route.page === "security" ? "page" : undefined}>
            Безопасность
          </a>
        </nav>
      </header>
      <main className="content">
        {route.page === "projects" && <ProjectsPage />}
        {route.page === "new" && <NewProjectPage recipeId={route.recipeId} />}
        {route.page === "project" && <ProjectPage id={route.id} />}
        {route.page === "connections" && <ConnectionsPage />}
        {route.page === "chat" && <ChatPage />}
        {route.page === "limits" && <LimitsPage />}
        {route.page === "resources" && <ResourcesPage />}
        {route.page === "security" && <SecurityPage />}
      </main>
    </div>
  );
}
