// Данные интерфейса через TanStack Query: кеш между страницами, опрос с частотой по состоянию,
// обновление после действий. Так видны и изменения, сделанные мимо интерфейса (через MCP, push в репо).
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NewResourceKind, ProjectStatusReport, ProviderId, ResourceActionId } from "../shared/types";
import { api } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

export const keys = {
  providers: ["providers"] as const,
  connections: ["connections"] as const,
  resources: ["resources"] as const,
  resourcesStatus: ["resources", "status"] as const,
  recipes: ["recipes"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  projectStatus: (id: string) => ["projects", id, "status"] as const,
  monitor: ["monitor"] as const,
  limits: ["limits"] as const,
  settings: ["settings"] as const,
  googleSheets: ["google", "sheets"] as const,
};

// Частота опроса: пока что-то создаётся или деплоится — часто, в покое — редко.
const FAST = 2_500;
const MEDIUM = 5_000;
const IDLE = 30_000;

const isBusy = (status: string) => status === "pending" || status === "provisioning";

/** Статусы провайдеров — живые запросы к их API, поэтому в покое опрашиваем реже. */
const statusIsBusy = (report: ProjectStatusReport | undefined) =>
  !!report &&
  (report.runs.some((r) => r.status !== "completed") || report.health.some((h) => h.state === "pending"));

// --- справочники ---

export const useProviders = () =>
  useQuery({ queryKey: keys.providers, queryFn: api.providers, staleTime: Infinity });

export const useRecipes = () => useQuery({ queryKey: keys.recipes, queryFn: api.recipes, staleTime: Infinity });

export const useConnections = () => useQuery({ queryKey: keys.connections, queryFn: api.connections });

// --- проекты ---

export const useProjects = () =>
  useQuery({
    queryKey: keys.projects,
    queryFn: api.projects,
    refetchInterval: (q) => (q.state.data?.some((p) => isBusy(p.status)) ? MEDIUM : IDLE),
  });

/** boostUntil — до этого момента журнал опрашивается часто: в фоне создаётся ресурс проекта. */
export const useProject = (id: string, boostUntil = 0) =>
  useQuery({
    queryKey: keys.project(id),
    queryFn: () => api.project(id),
    refetchInterval: (q) =>
      (q.state.data && isBusy(q.state.data.project.status)) || Date.now() < boostUntil ? FAST : IDLE / 2,
  });

/**
 * boostUntil — до этого момента опрашиваем часто, даже если всё выглядит спокойно:
 * после ручного деплоя GitHub создаёт запуск с задержкой в несколько секунд.
 */
export const useProjectStatus = (id: string, opts: { enabled: boolean; boostUntil: number }) =>
  useQuery({
    queryKey: keys.projectStatus(id),
    queryFn: () => api.projectStatus(id),
    enabled: opts.enabled,
    refetchInterval: (q) => (statusIsBusy(q.state.data) || Date.now() < opts.boostUntil ? MEDIUM : IDLE),
  });

// --- действия ---

export function useAddConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, token }: { provider: ProviderId; token: string }) => api.addConnection(provider, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connections }),
  });
}

export function useReplaceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, token }: { id: string; token: string }) => api.replaceToken(id, token),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connections }),
  });
}

export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.disconnect(id),
    onSuccess: () => qc.invalidateQueries(),
  });
}

// --- каталог ресурсов ---

export const useResources = () => useQuery({ queryKey: keys.resources, queryFn: api.resources });

/** Статусы всех ресурсов — запросы ко всем провайдерам, поэтому раз в минуту. */
export const useResourcesStatus = () =>
  useQuery({ queryKey: keys.resourcesStatus, queryFn: api.resourcesStatus, staleTime: 30_000, refetchInterval: 60_000 });

export const useDiscover = (connectionId: string | null) =>
  useQuery({
    queryKey: ["discover", connectionId],
    queryFn: () => api.discover(connectionId!),
    enabled: !!connectionId,
  });

/** Меняют каталог и привязки — обновляем всё, что может это показывать. */
function useCatalogMutation<T, R>(mutationFn: (input: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries() });
}

export const useImportResources = () =>
  useCatalogMutation((input: { connectionId: string; items: { type: string; externalId: string }[] }) =>
    api.importResources(input.connectionId, input.items),
  );

export const useAddExternalPostgres = () =>
  useCatalogMutation((input: { name: string; url: string }) => api.addExternalPostgres(input.name, input.url));

export const useRemoveResource = () =>
  useCatalogMutation((input: { id: string; atProvider: boolean }) => api.removeResource(input.id, input.atProvider));

export const useBindResource = () =>
  useCatalogMutation((input: { projectId: string; resourceId: string }) =>
    api.bindResource(input.projectId, input.resourceId),
  );

export const useNewResource = () =>
  useCatalogMutation((input: { projectId: string; kind: NewResourceKind; params: Record<string, string> }) =>
    api.newResource(input.projectId, input.kind, input.params),
  );

export const useAddWire = () =>
  useCatalogMutation(
    (input: { projectId: string; wire: { sourceId: string; output: string; targetId: string; name: string } }) =>
      api.addWire(input.projectId, input.wire),
  );

export const useRemoveWire = () =>
  useCatalogMutation((input: { projectId: string; targetId: string; name: string }) =>
    api.removeWire(input.projectId, input.targetId, input.name),
  );

export const useReapplyWires = () => useCatalogMutation((projectId: string) => api.reapplyWires(projectId));

export const useSetResourceSecret = () =>
  useCatalogMutation((input: { id: string; secret: string }) => api.setResourceSecret(input.id, input.secret));

export const useUnbindResource = () =>
  useCatalogMutation((input: { projectId: string; resourceId: string }) =>
    api.unbindResource(input.projectId, input.resourceId),
  );

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      recipeId: string;
      name: string;
      params: Record<string, string>;
      accounts: Record<string, string>;
    }) => {
      const { id } = await api.createProject(input.recipeId, input.name, input.params, input.accounts);
      // Создание ресурсов — долгий запрос; прогресс страница проекта получает опросом журнала.
      // Ошибки создания записываются в сам проект, поэтому здесь их не ловим.
      api.provision(id).catch(() => {}).finally(() => void qc.invalidateQueries({ queryKey: keys.project(id) }));
      return id;
    },
    // exact: префикс ["projects"] задел бы и статусы проектов — это живые запросы к провайдерам
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects, exact: true }),
  });
}

export function useStartProvision(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      api.provision(id).catch(() => {}).finally(() => void qc.invalidateQueries({ queryKey: keys.project(id) }));
    },
    // provision уже перевёл проект в provisioning — подтягиваем, чтобы включился частый опрос
    onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: keys.project(id) }), 500),
  });
}

export function useDeploy(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deploy(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.project(id) });
      void qc.invalidateQueries({ queryKey: keys.projectStatus(id) });
    },
  });
}

export function useResourceAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ resourceId, action }: { resourceId: string; action: ResourceActionId }) =>
      api.resourceAction(projectId, resourceId, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.project(projectId) }),
  });
}

export function useDestroyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.destroyProject(id),
    onSuccess: (result, id) => {
      if (result.projectRemoved) qc.removeQueries({ queryKey: keys.project(id) });
      else void qc.invalidateQueries({ queryKey: keys.project(id) });
      return qc.invalidateQueries({ queryKey: keys.projects, exact: true });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: keys.project(id) });
      return qc.invalidateQueries({ queryKey: keys.projects, exact: true });
    },
  });
}

// --- настройки ---

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: Infinity });

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (settings) => qc.setQueryData(keys.settings, settings),
  });
}

// --- Google Drive ---

export const useGoogleSheets = (connectionId: string) =>
  useQuery({
    queryKey: [...keys.googleSheets, connectionId],
    queryFn: () => api.googleSheets(connectionId),
    enabled: !!connectionId,
    staleTime: 30_000,
  });

// --- лимиты ---

/** Лимиты — запросы к API нескольких провайдеров, поэтому редко: раз в 5 минут и при возврате на вкладку. */
export const useLimits = () =>
  useQuery({ queryKey: keys.limits, queryFn: api.limits, staleTime: 60_000, refetchInterval: 5 * 60_000 });

// --- мониторинг ---

export const useMonitor = () => useQuery({ queryKey: keys.monitor, queryFn: api.monitor, refetchInterval: IDLE });

export function useRunMonitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.runMonitor,
    // Проверка обновила алерты, журналы и статусы — подтягиваем всё
    onSuccess: () => qc.invalidateQueries(),
  });
}

export const errorMessage = (e: unknown) => (e ? (e instanceof Error ? e.message : String(e)) : null);
