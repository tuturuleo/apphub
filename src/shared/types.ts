// Типы, общие для API (worker) и интерфейса (web).

export type ProviderId = "github" | "cloudflare";

export type ResourceKind = "repo" | "site" | "service" | "database";

/** Тип ресурса у конкретного провайдера, определяет, как проверять его статус. */
export type ResourceType = "github.repo" | "github.pages" | "cloudflare.worker" | "cloudflare.d1";

export type HealthState = "ok" | "pending" | "warn" | "error" | "unknown";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  summary: string;
  tokenUrl: string;
  /** Пошаговая инструкция, как получить токен с нужными правами. */
  steps: string[];
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

export type ProjectStatus = "provisioning" | "ready" | "failed";

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

export interface ResourceHealth {
  resourceId: string;
  state: HealthState;
  summary: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  event: string;
  url: string;
  commitMessage: string | null;
  createdAt: string;
}

export interface ProjectDetails {
  project: Project;
  resources: Resource[];
  events: ProjectEvent[];
}

export interface ProjectStatusReport {
  health: ResourceHealth[];
  runs: WorkflowRun[];
}

export interface ProjectSummary extends Project {
  links: { label: string; url: string }[];
}

export interface ApiError {
  error: string;
}
