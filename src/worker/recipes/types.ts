import type { Project, RecipeInfo, Resource } from "../../shared/types";
import type { Cloudflare } from "../providers/cloudflare";
import type { GitHub } from "../providers/github";

export interface GitHubAccess {
  client: GitHub;
  login: string;
}

export interface CloudflareAccess {
  client: Cloudflare;
  accountId: string;
  subdomain: string;
  /** Токен уходит в секреты репозитория, чтобы Actions могли деплоить. */
  token: string;
}

export interface ProvisionContext {
  project: Project;
  params: Record<string, string>;
  github(): GitHubAccess;
  cloudflare(): CloudflareAccess;
  log(message: string): Promise<void>;
  addResource(resource: Omit<Resource, "id" | "projectId" | "createdAt">): Promise<Resource>;
}

/**
 * Рецепт — проверенный способ поднять проект: шаблон кода + какие ресурсы создать у провайдеров и как их связать.
 */
export interface Recipe extends RecipeInfo {
  /** Дополнительная проверка параметров; возвращает текст ошибки. */
  validate?(params: Record<string, string>): string | null;
  provision(ctx: ProvisionContext): Promise<void>;
}
