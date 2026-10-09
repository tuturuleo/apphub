// Клиент Render API: рабочие пространства, веб-сервисы из GitHub-репозитория (Docker), деплои.
import { ProviderError } from "./errors";
import { providerFetch } from "./http";

export type RenderRegion = "frankfurt" | "oregon" | "ohio" | "singapore" | "virginia";

export type RenderDeployStatus =
  | "created"
  | "queued"
  | "build_in_progress"
  | "update_in_progress"
  | "live"
  | "deactivated"
  | "build_failed"
  | "update_failed"
  | "canceled"
  | "pre_deploy_in_progress"
  | "pre_deploy_failed";

export interface RenderService {
  id: string;
  name: string;
  dashboardUrl: string;
  suspended: "suspended" | "not_suspended";
  serviceDetails: { url?: string };
}

export interface RenderDeploy {
  id: string;
  status: RenderDeployStatus;
  trigger?: string;
  commit?: { id: string; message: string } | null;
  createdAt: string;
  finishedAt?: string | null;
}

export class Render {
  constructor(private token: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await providerFetch("Render", `https://api.render.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // не JSON
      }
      throw new ProviderError(`Render ${method} ${path}: ${res.status} ${message}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async owners(): Promise<{ id: string; name: string; type: string }[]> {
    const items = await this.request<{ owner: { id: string; name: string; type: string } }[]>("GET", "/owners?limit=20");
    return items.map((i) => i.owner);
  }

  /** Веб-сервис на бесплатном тарифе, собирается из Dockerfile в корне репозитория при каждом push. */
  async createDockerService(opts: {
    ownerId: string;
    name: string;
    repoUrl: string;
    branch: string;
    region: RenderRegion;
    healthCheckPath: string;
    env?: Record<string, string>;
  }): Promise<RenderService> {
    const created = await this.request<{ service: RenderService }>("POST", "/services", {
      type: "web_service",
      name: opts.name,
      ownerId: opts.ownerId,
      repo: opts.repoUrl,
      branch: opts.branch,
      autoDeploy: "yes",
      envVars: Object.entries(opts.env ?? {}).map(([key, value]) => ({ key, value })),
      serviceDetails: {
        runtime: "docker",
        plan: "free",
        region: opts.region,
        healthCheckPath: opts.healthCheckPath,
        envSpecificDetails: { dockerfilePath: "./Dockerfile", dockerContext: "." },
      },
    });
    return created.service;
  }

  /** Полностью заменяет переменные окружения сервиса. Деплой не запускает. */
  async setEnvVars(serviceId: string, env: Record<string, string>): Promise<void> {
    await this.request(
      "PUT",
      `/services/${serviceId}/env-vars`,
      Object.entries(env).map(([key, value]) => ({ key, value })),
    );
  }

  async listServices(
    ownerId: string,
  ): Promise<{ id: string; name: string; plan: string | null; url: string | null; dashboardUrl: string }[]> {
    const items = await this.request<
      { service: { id: string; name: string; dashboardUrl: string; serviceDetails?: { plan?: string; url?: string } } }[]
    >("GET", `/services?ownerId=${ownerId}&limit=100`);
    return items.map(({ service }) => ({
      id: service.id,
      name: service.name,
      plan: service.serviceDetails?.plan ?? null,
      url: service.serviceDetails?.url ?? null,
      dashboardUrl: service.dashboardUrl,
    }));
  }

  async deleteService(id: string): Promise<void> {
    await this.request("DELETE", `/services/${id}`);
  }

  async getService(id: string): Promise<RenderService> {
    return this.request("GET", `/services/${id}`);
  }

  async listDeploys(serviceId: string, limit = 5): Promise<RenderDeploy[]> {
    const items = await this.request<{ deploy: RenderDeploy }[]>("GET", `/services/${serviceId}/deploys?limit=${limit}`);
    return items.map((i) => i.deploy);
  }

  async triggerDeploy(serviceId: string): Promise<void> {
    await this.request("POST", `/services/${serviceId}/deploys`, {});
  }
}
