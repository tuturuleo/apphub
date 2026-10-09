import type {
  AppSettings,
  CatalogResource,
  DiscoveredResource,
  NewResourceKind,
  Wire,
  ResourceHealth,
  ChatMessage,
  ChatResult,
  Connection,
  LimitItem,
  DestroyResult,
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
  addConnection: (provider: ProviderId, token: string) =>
    request<Connection>("POST", "/connections", { provider, token }),
  replaceToken: (id: string, token: string) => request<Connection>("PUT", `/connections/${id}`, { token }),
  disconnect: (id: string) => request<void>("DELETE", `/connections/${id}`),
  resources: () => request<CatalogResource[]>("GET", "/resources"),
  resourcesStatus: () => request<ResourceHealth[]>("GET", "/resources/status"),
  discover: (connectionId: string) => request<DiscoveredResource[]>("GET", `/connections/${connectionId}/discover`),
  importResources: (connectionId: string, items: { type: string; externalId: string }[]) =>
    request<unknown>("POST", `/connections/${connectionId}/import`, { items }),
  addExternalPostgres: (name: string, url: string) => request<unknown>("POST", "/resources/external", { name, url }),
  removeResource: (id: string, atProvider: boolean) =>
    request<void>("DELETE", `/resources/${id}${atProvider ? "?atProvider=1" : ""}`),
  bindResource: (projectId: string, resourceId: string, mode?: "isolated" | "shared") =>
    request<{ message: string }>("POST", `/projects/${projectId}/resources`, { resourceId, mode }),
  unbindResource: (projectId: string, resourceId: string) =>
    request<void>("DELETE", `/projects/${projectId}/resources/${resourceId}`),
  newResource: (projectId: string, kind: NewResourceKind, params: Record<string, string>) =>
    request<{ background: boolean }>("POST", `/projects/${projectId}/resources/new`, { kind, params }),
  addWire: (projectId: string, wire: { sourceId: string; output: string; targetId: string; name: string }) =>
    request<Wire>("POST", `/projects/${projectId}/wires`, wire),
  removeWire: (projectId: string, targetId: string, name: string) =>
    request<void>("DELETE", `/projects/${projectId}/wires/${targetId}/${encodeURIComponent(name)}`),
  reapplyWires: (projectId: string) => request<Wire[]>("POST", `/projects/${projectId}/wires/reapply`),
  setResourceSecret: (id: string, secret: string) => request<void>("PUT", `/resources/${id}/secret`, { secret }),
  recipes: () => request<RecipeInfo[]>("GET", "/recipes"),
  projects: () => request<ProjectSummary[]>("GET", "/projects"),
  project: (id: string) => request<ProjectDetails>("GET", `/projects/${id}`),
  projectStatus: (id: string) => request<ProjectStatusReport>("GET", `/projects/${id}/status`),
  createProject: (
    recipeId: string,
    name: string,
    params: Record<string, string>,
    accounts: Record<string, string> = {},
  ) => request<{ id: string }>("POST", "/projects", { recipeId, name, params, accounts }),
  provision: (id: string) => request<void>("POST", `/projects/${id}/provision`),
  resourceAction: (projectId: string, resourceId: string, action: ResourceActionId) =>
    request<void>("POST", `/projects/${projectId}/resources/${resourceId}/actions/${action}`),
  chat: (messages: ChatMessage[]) => request<ChatResult>("POST", "/chat", { messages }),
  googleSheets: (connectionId: string) =>
    request<{ serviceAccount: string; sheets: { id: string; name: string; modifiedTime: string; url: string }[] }>(
      "GET",
      `/google/sheets?connection=${encodeURIComponent(connectionId)}`,
    ),
  settings: () => request<AppSettings>("GET", "/settings"),
  saveSettings: (patch: Partial<AppSettings>) => request<AppSettings>("PUT", "/settings", patch),
  limits: () => request<LimitItem[]>("GET", "/limits"),
  monitor: () => request<MonitorState>("GET", "/monitor"),
  runMonitor: () => request<MonitorResult>("POST", "/monitor/run"),
  deploy: (id: string) => request<void>("POST", `/projects/${id}/deploy`),
  deleteProject: (id: string) => request<void>("DELETE", `/projects/${id}`),
  destroyProject: (id: string) => request<DestroyResult>("POST", `/projects/${id}/destroy`),
};
