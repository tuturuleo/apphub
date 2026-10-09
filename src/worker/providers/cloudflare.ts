// Клиент Cloudflare API v4: аккаунты, поддомен workers.dev, базы D1, деплои Workers.
import { ProviderError } from "./errors";
import { providerFetch } from "./http";

interface Envelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

export interface D1Database {
  uuid: string;
  name: string;
  file_size?: number;
  num_tables?: number;
}

export class Cloudflare {
  constructor(
    private token: string,
    readonly accountId = "",
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await providerFetch("Cloudflare", `https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: Envelope<T> | null = null;
    try {
      data = (await res.json()) as Envelope<T>;
    } catch {
      // не JSON
    }
    if (!res.ok || !data?.success) {
      const message = data?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || res.statusText;
      throw new ProviderError(`Cloudflare ${method} ${path}: ${res.status} ${message}`, res.status);
    }
    return data.result;
  }

  private get account(): string {
    if (!this.accountId) throw new Error("Cloudflare: не указан account id");
    return `/accounts/${this.accountId}`;
  }

  async listAccounts(): Promise<{ id: string; name: string }[]> {
    return this.request("GET", "/accounts");
  }

  /** Поддомен <subdomain>.workers.dev; null, если ещё не зарегистрирован. */
  async workersSubdomain(): Promise<string | null> {
    try {
      const r = await this.request<{ subdomain: string }>("GET", `${this.account}/workers/subdomain`);
      return r.subdomain || null;
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async createD1(name: string): Promise<D1Database> {
    return this.request("POST", `${this.account}/d1/database`, { name });
  }

  async deleteD1(uuid: string): Promise<void> {
    await this.request("DELETE", `${this.account}/d1/database/${uuid}`);
  }

  async deleteWorker(script: string): Promise<void> {
    await this.request("DELETE", `${this.account}/workers/scripts/${script}?force=true`);
  }

  async getD1(uuid: string): Promise<D1Database> {
    return this.request("GET", `${this.account}/d1/database/${uuid}`);
  }

  /** Последний деплой Worker; null, если скрипт ещё не задеплоен. */
  async latestDeployment(script: string): Promise<{ created_on: string } | null> {
    try {
      const r = await this.request<{ deployments: { created_on: string }[] }>(
        "GET",
        `${this.account}/workers/scripts/${script}/deployments`,
      );
      return r.deployments[0] ?? null;
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }
}

export const cloudflareConsole = {
  d1: (accountId: string, uuid: string) => `https://dash.cloudflare.com/${accountId}/workers/d1/databases/${uuid}`,
  worker: (accountId: string, name: string) =>
    `https://dash.cloudflare.com/${accountId}/workers/services/view/${name}/production`,
};
