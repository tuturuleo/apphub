/** Параметры фонового Workflow: создание проекта по рецепту или отдельного ресурса в проекте (task). */
export interface ProvisionParams {
  projectId: string;
  task?: { kind: import("../shared/types").NewResourceKind; params: Record<string, string> };
}

export interface AppEnv {
  DB: D1Database;
  /** Фоновое создание ресурсов проекта (src/worker/workflow.ts). */
  PROVISION: Workflow<ProvisionParams>;
  /** base64, 32 байта — ключ AES-GCM для токенов провайдеров. */
  ENCRYPTION_KEY: string;
  /** Только для локальной разработки: пропускать авторизацию. */
  DEV_ALLOW_NO_AUTH?: string;
  /** Код установки: нужен для первого passkey и для восстановления доступа. */
  SETUP_CODE?: string;
  /** Общий секрет с прокси (доступ без VPN): только с ним доверяем X-Forwarded-Host. */
  PROXY_SECRET?: string;
  /** Необязательно: Cloudflare Access перед AppHub — домен команды и AUD приложения (переменные Worker). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}
