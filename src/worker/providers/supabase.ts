// Клиент Supabase Management API: организации, проекты, ключи, пулер, настройки авторизации.
import { ProviderError } from "./errors";
import { providerFetch } from "./http";

export type SupabaseProjectStatus =
  | "INACTIVE"
  | "ACTIVE_HEALTHY"
  | "ACTIVE_UNHEALTHY"
  | "COMING_UP"
  | "UNKNOWN"
  | "GOING_DOWN"
  | "INIT_FAILED"
  | "REMOVED"
  | "RESTORING"
  | "UPGRADING"
  | "PAUSING"
  | "RESTORE_FAILED"
  | "RESTARTING"
  | "PAUSE_FAILED"
  | "RESIZING";

export interface SupabaseProject {
  ref: string;
  name: string;
  region: string;
  organization_slug: string;
  status: SupabaseProjectStatus;
}

interface PoolerConfig {
  database_type: string;
  db_user: string;
  db_host: string;
  db_port: number;
  db_name: string;
  pool_mode: string;
}

export class Supabase {
  constructor(private token: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await providerFetch("Supabase", `https://api.supabase.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        const json = JSON.parse(text) as { message?: string; missing_permissions?: unknown[] };
        message = json.message ?? text;
        // Scoped-токен без нужного права: Supabase перечисляет, чего не хватает
        if (json.missing_permissions?.length) {
          message += `. Не хватает прав токена: ${json.missing_permissions.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(", ")}`;
        }
      } catch {
        // не JSON
      }
      throw new ProviderError(`Supabase ${method} ${path}: ${res.status} ${message}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async organizations(): Promise<{ slug: string; name: string }[]> {
    return this.request("GET", "/organizations");
  }

  async createProject(opts: {
    name: string;
    organizationSlug: string;
    dbPass: string;
    regionGroup: string;
  }): Promise<SupabaseProject> {
    return this.request("POST", "/projects", {
      name: opts.name,
      organization_slug: opts.organizationSlug,
      db_pass: opts.dbPass,
      region_selection: { type: "smartGroup", code: opts.regionGroup },
    });
  }

  async getProject(ref: string): Promise<SupabaseProject> {
    return this.request("GET", `/projects/${ref}`);
  }

  /** Публичный ключ для браузера: новый publishable, либо legacy anon. */
  async publishableKey(ref: string): Promise<string | null> {
    const keys = await this.request<{ type: string | null; name: string; api_key: string | null }[]>(
      "GET",
      `/projects/${ref}/api-keys`,
    );
    const key = keys.find((k) => k.type === "publishable") ?? keys.find((k) => k.name === "anon");
    return key?.api_key ?? null;
  }

  /** Строка подключения через пулер в session mode: GitHub-раннеры не умеют IPv6 для прямого подключения. */
  async sessionPoolerUrl(ref: string, password: string): Promise<string> {
    const configs = await this.request<PoolerConfig[]>("GET", `/projects/${ref}/config/database/pooler`);
    const primary = configs.find((c) => c.database_type === "PRIMARY") ?? configs[0];
    if (!primary) throw new Error("Supabase не вернул настройки пулера");
    return `postgresql://${primary.db_user}:${encodeURIComponent(password)}@${primary.db_host}:5432/${primary.db_name}`;
  }

  async updateAuthConfig(ref: string, config: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `/projects/${ref}/config/auth`, config);
  }

  async deleteProject(ref: string): Promise<void> {
    await this.request("DELETE", `/projects/${ref}`);
  }

  async restoreProject(ref: string): Promise<void> {
    await this.request("POST", `/projects/${ref}/restore`);
  }
}

export const supabaseConsole = {
  project: (ref: string) => `https://supabase.com/dashboard/project/${ref}`,
};
