export interface AppEnv {
  DB: D1Database;
  /** base64, 32 байта — ключ AES-GCM для токенов провайдеров. */
  ENCRYPTION_KEY: string;
  /** Только для локальной разработки: пропускать проверку Cloudflare Access. */
  DEV_ALLOW_NO_AUTH?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}
