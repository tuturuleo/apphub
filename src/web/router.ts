import { useEffect, useState } from "react";

export type Route =
  | { page: "projects" }
  | { page: "new"; recipeId?: string }
  | { page: "project"; id: string }
  | { page: "connections" }
  | { page: "chat" };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "new") return { page: "new", recipeId: parts[1] };
  if (parts[0] === "projects" && parts[1]) return { page: "project", id: parts[1] };
  if (parts[0] === "connections") return { page: "connections" };
  if (parts[0] === "chat") return { page: "chat" };
  return { page: "projects" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parse(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const href = {
  projects: "#/",
  newProject: (recipeId?: string) => (recipeId ? `#/new/${recipeId}` : "#/new"),
  project: (id: string) => `#/projects/${id}`,
  connections: "#/connections",
  chat: "#/chat",
};

export function navigate(to: string) {
  location.hash = to;
}
