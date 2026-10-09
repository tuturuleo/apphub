// Типы, общие для API (worker) и интерфейса (web).

export type ProviderId = "github" | "cloudflare" | "supabase" | "render" | "telegram";

export type ResourceKind = "repo" | "site" | "service" | "database";

/** Тип ресурса у конкретного провайдера, определяет, как проверять его статус. */
export type ResourceType =
  | "github.repo"
  | "github.pages"
  | "cloudflare.worker"
  | "cloudflare.d1"
  | "supabase.project"
  | "render.service";

export type HealthState = "ok" | "pending" | "warn" | "error" | "unknown";

/** Раздел прав в форме создания токена у провайдера — названия как в его интерфейсе. */
export interface PermissionGroup {
  section: string;
  items: { name: string; level: string }[];
}

export type InstructionStep = string | { text: string; permissions: PermissionGroup[] };

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  summary: string;
  tokenUrl: string;
  /** Подпись ссылки на tokenUrl в первом шаге инструкции. */
  tokenLinkLabel: string;
  /** Пошаговая инструкция, как получить токен с нужными правами. */
  steps: InstructionStep[];
  /** Пояснения под инструкцией: что apphub делает с токеном, ограничения тарифа. */
  notes: string[];
}

export interface Connection {
  provider: ProviderId;
  label: string;
  accountId: string;
  meta: Record<string, string>;
  createdAt: number;
}

export interface RecipeField {
  key: string;
  label: string;
  type: "text" | "url" | "select";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string;
}

export interface RecipeInfo {
  id: string;
  name: string;
  summary: string;
  stack: string[];
  requires: ProviderId[];
  fields: RecipeField[];
  notes: string[];
}

/** pending — создан, ресурсы ещё не начали создаваться. */
export type ProjectStatus = "pending" | "provisioning" | "ready" | "failed";

export interface Project {
  id: string;
  name: string;
  recipeId: string;
  params: Record<string, string>;
  status: ProjectStatus;
  error: string | null;
  createdAt: number;
}

export interface Resource {
  id: string;
  projectId: string;
  type: ResourceType;
  kind: ResourceKind;
  name: string;
  externalId: string;
  url: string | null;
  consoleUrl: string | null;
  meta: Record<string, string>;
  createdAt: number;
}

export interface ProjectEvent {
  id: number;
  level: "info" | "error";
  message: string;
  createdAt: number;
}

/** Действие, которое можно выполнить над ресурсом прямо из apphub. */
export type ResourceActionId = "wake" | "enable_workflows";

export interface ResourceHealth {
  resourceId: string;
  state: HealthState;
  summary: string;
  action?: { id: ResourceActionId; label: string };
}

/** Сборка или деплой: запуск GitHub Actions либо деплой Render. */
export interface WorkflowRun {
  source: "github" | "render";
  id: number | string;
  name: string;
  status: string;
  conclusion: string | null;
  event: string;
  url: string;
  commitMessage: string | null;
  createdAt: string;
}

/** Активная проблема проекта, найденная мониторингом. */
export interface ProjectAlert {
  key: string;
  message: string;
  url: string | null;
  createdAt: number;
}

export interface ProjectDetails {
  project: Project;
  resources: Resource[];
  events: ProjectEvent[];
  alerts: ProjectAlert[];
}

/** Итог полного удаления проекта. */
export interface DestroyResult {
  deleted: string[];
  failed: { resource: string; error: string }[];
  projectRemoved: boolean;
}

export interface MonitorState {
  /** Время последней проверки проектов, null — ещё не проверяли. */
  lastRunAt: number | null;
  notifications: boolean;
}

export interface MonitorResult {
  checked: number;
  opened: number;
  resolved: number;
  notified: boolean;
}

export interface ProjectStatusReport {
  health: ResourceHealth[];
  runs: WorkflowRun[];
  /** Активные алерты после сверки со свежим статусом (только в ответе API статуса). */
  alerts?: ProjectAlert[];
}

export interface ProjectSummary extends Project {
  links: { label: string; url: string }[];
  alerts: number;
}

export interface ApiError {
  error: string;
}
