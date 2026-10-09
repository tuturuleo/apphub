// Типы, общие для API (worker) и интерфейса (web).

export type ProviderId = "github" | "cloudflare" | "supabase" | "render" | "google" | "telegram" | "anthropic";

export type ResourceKind = "repo" | "site" | "service" | "database" | "data" | "bot";

/** Тип ресурса у конкретного провайдера, определяет, как проверять его статус. */
export type ResourceType =
  | "github.repo"
  | "github.pages"
  | "cloudflare.worker"
  | "cloudflare.d1"
  | "supabase.project"
  | "render.service"
  | "google.sheet"
  | "postgres.external"
  | "telegram.bot";

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
  /** Секрет — многострочный текст (JSON-ключ), а не короткий токен. */
  secretMultiline?: boolean;
  /** Можно подключить несколько аккаунтов. Служебные подключения apphub (уведомления, ассистент) — по одному. */
  multiAccount: boolean;
}

/** Подключённый аккаунт провайдера. Аккаунтов одного провайдера может быть несколько. */
export interface Connection {
  id: string;
  provider: ProviderId;
  label: string;
  accountId: string;
  meta: Record<string, string>;
  createdAt: number;
}

export interface RecipeField {
  key: string;
  label: string;
  /** google-sheet — выбор из таблиц, доступных сервисному аккаунту Google. */
  type: "text" | "url" | "select" | "google-sheet";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string;
  /** Поле показывается, только когда другое поле имеет одно из значений. */
  showIf?: { field: string; values: string[] };
}

export interface RecipeInfo {
  id: string;
  name: string;
  summary: string;
  stack: string[];
  requires: ProviderId[];
  fields: RecipeField[];
  notes: string[];
  /** Лимиты, которые рецепт расходует — по ним проверяем, влезет ли проект. */
  needs: LimitKey[];
  /** Открывается ли созданный сайт из России без VPN. */
  russia: { ok: boolean; note: string | null };
}

export interface AppSettings {
  /** Пользователи сайтов — в России: рекомендуем рецепты, которые открываются без VPN. */
  audienceRussia: boolean;
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

/** Откуда ресурс: создан apphub, найден в подключённом аккаунте или внешний (свой сервер). */
export type ResourceOrigin = "created" | "imported" | "external";

/** Ресурс каталога — существует сам по себе и может быть привязан к нескольким проектам. */
export interface Resource {
  id: string;
  /** Аккаунт, через который apphub управляет ресурсом; null — у внешнего ресурса аккаунта нет. */
  connectionId: string | null;
  type: ResourceType;
  kind: ResourceKind;
  name: string;
  externalId: string;
  url: string | null;
  consoleUrl: string | null;
  meta: Record<string, string>;
  origin: ResourceOrigin;
  createdAt: number;
}

/** Ресурс в составе проекта: с ролью и параметрами привязки. */
export interface BoundResource extends Resource {
  role: string;
  binding: Record<string, string>;
}

/** Ресурс, найденный в подключённом аккаунте, — кандидат на импорт в каталог. */
export interface DiscoveredResource {
  type: ResourceType;
  kind: ResourceKind;
  name: string;
  externalId: string;
  url: string | null;
  consoleUrl: string | null;
  meta: Record<string, string>;
  inCatalog: boolean;
}

/** Ресурс на странице каталога: чей аккаунт и к каким проектам привязан. */
export interface CatalogResource extends Resource {
  account: string | null;
  /** Сохранена ли строка подключения/токен (нужно, чтобы передавать значение другим ресурсам). */
  hasSecret: boolean;
  projects: { id: string; name: string; role: string }[];
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

/** Значение, которое ресурс может передать другим: строка подключения, адрес, токен. */
export interface ResourceOutput {
  key: string;
  label: string;
  secret: boolean;
  /** false — значения пока нет (например, не задана строка подключения базы). */
  available: boolean;
}

/** Связь: выход одного ресурса записан в переменную другого. */
export interface Wire {
  sourceId: string;
  output: string;
  targetId: string;
  name: string;
  appliedAt: number | null;
  error: string | null;
}

/** Что можно создать в проекте прямо со страницы проекта. */
export type NewResourceKind = "github-repo" | "supabase-db" | "d1-db" | "render-service" | "telegram-bot";

export interface ProjectDetails {
  project: Project;
  resources: BoundResource[];
  wires: Wire[];
  /** Выходы ресурсов проекта и какие ресурсы могут принимать переменные. */
  outputs: Record<string, ResourceOutput[]>;
  consumers: string[];
  events: ProjectEvent[];
  alerts: ProjectAlert[];
}

/** Итог полного удаления проекта. */
export interface DestroyResult {
  /** Удалены у провайдера. */
  deleted: string[];
  /** Отвязаны, но оставлены: нужны другим проектам, импортированы или внешние. */
  detached: string[];
  failed: { resource: string; error: string }[];
  projectRemoved: boolean;
}

/** Сообщение переписки с ассистентом в формате Claude API (интерфейсу нужны только эти поля). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ChatBlock[];
}

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export interface ChatResult {
  messages: ChatMessage[];
  stopReason: string | null;
}

/** Ограничение бесплатного тарифа, которое apphub может посчитать или хотя бы показать. */
export type LimitKey =
  | "supabase.projects"
  | "cloudflare.d1.count"
  | "cloudflare.d1.storage"
  | "cloudflare.workers"
  | "render.hours"
  | "cloudflare.requests"
  | "github.actions";

export type LimitState = "ok" | "warn" | "full" | "info";

export interface LimitItem {
  key: LimitKey;
  provider: ProviderId;
  /** Аккаунт, к которому относится лимит. */
  connectionId: string;
  label: string;
  /** null — потребление через API не узнать, показываем только лимит. */
  used: number | null;
  limit: number;
  unit: "" | "bytes" | "hours" | "minutes" | "requests";
  state: LimitState;
  note: string | null;
  /** Кто занимает (например, имена проектов Supabase). */
  holders: string[];
  consoleUrl: string | null;
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
