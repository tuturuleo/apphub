import type {
  Connection,
  MonitorResult,
  MonitorState,
  ProjectDetails,
  ProjectStatusReport,
  ProjectSummary,
  ProviderId,
  ProviderInfo,
  RecipeInfo,
  ResourceActionId,
} from "../shared/types";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // не JSON
    }
    throw new Error(message);
  }
  if (res.status === 204 || res.status === 202) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  providers: () => request<ProviderInfo[]>("GET", "/providers"),
  connections: () => request<Connection[]>("GET", "/connections"),
  connect: (provider: ProviderId, token: string) => request<Connection>("PUT", `/connections/${provider}`, { token }),
  disconnect: (provider: ProviderId) => request<void>("DELETE", `/connections/${provider}`),
  recipes: () => request<RecipeInfo[]>("GET", "/recipes"),
  projects: () => request<ProjectSummary[]>("GET", "/projects"),
  project: (id: string) => request<ProjectDetails>("GET", `/projects/${id}`),
  projectStatus: (id: string) => request<ProjectStatusReport>("GET", `/projects/${id}/status`),
  createProject: (recipeId: string, name: string, params: Record<string, string>) =>
    request<{ id: string }>("POST", "/projects", { recipeId, name, params }),
  provision: (id: string) => request<void>("POST", `/projects/${id}/provision`),
  resourceAction: (projectId: string, resourceId: string, action: ResourceActionId) =>
    request<void>("POST", `/projects/${projectId}/resources/${resourceId}/actions/${action}`),
  monitor: () => request<MonitorState>("GET", "/monitor"),
  runMonitor: () => request<MonitorResult>("POST", "/monitor/run"),
  deploy: (id: string) => request<void>("POST", `/projects/${id}/deploy`),
  deleteProject: (id: string) => request<void>("DELETE", `/projects/${id}`),
};
