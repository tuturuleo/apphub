import type { Project, ProviderId, RecipeInfo, Resource } from "../../shared/types";
import type { Cloudflare } from "../providers/cloudflare";
import type { GitHub } from "../providers/github";
import type { GoogleDrive } from "../providers/google";
import type { Render } from "../providers/render";
import type { Supabase } from "../providers/supabase";

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

export interface SupabaseAccess {
  client: Supabase;
  organizationSlug: string;
}

export interface RenderAccess {
  client: Render;
  ownerId: string;
}

export interface ProvisionContext {
  project: Project;
  params: Record<string, string>;
  github(): GitHubAccess;
  cloudflare(): CloudflareAccess;
  supabase(): SupabaseAccess;
  render(): RenderAccess;
  google(): GoogleDrive;
  log(message: string): Promise<void>;
  addResource(resource: Omit<Resource, "id" | "projectId" | "createdAt">): Promise<Resource>;
}

/**
 * Рецепт — проверенный способ поднять проект: шаблон кода + какие ресурсы создать у провайдеров и как их связать.
 */
export interface Recipe extends RecipeInfo {
  /** Дополнительная проверка параметров; возвращает текст ошибки. */
  validate?(params: Record<string, string>): string | null;
  /** Подключения, нужные только при некоторых параметрах (например, Google — для приватной таблицы). */
  requiresFor?(params: Record<string, string>): ProviderId[];
  provision(ctx: ProvisionContext): Promise<void>;
}
