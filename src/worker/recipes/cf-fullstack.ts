import { cloudflareConsole } from "../providers/cloudflare";
import { renderTemplate } from "./templates";
import type { Recipe } from "./types";

// Совпадает с compatibility_date самого apphub — заведомо поддерживается текущим wrangler.
const COMPAT_DATE = "2026-09-15";

export const cfFullstack: Recipe = {
  id: "cf-fullstack",
  name: "Сайт + API + SQLite",
  summary: "Статический фронтенд, API на Cloudflare Workers и база D1. Деплой на каждый push.",
  stack: ["Cloudflare Workers", "D1", "GitHub Actions"],
  requires: ["github", "cloudflare"],
  needs: ["cloudflare.workers", "cloudflare.d1.count", "cloudflare.d1.storage"],
  fields: [
    {
      key: "visibility",
      label: "Репозиторий",
      type: "select",
      options: [
        { value: "private", label: "Приватный" },
        { value: "public", label: "Публичный" },
      ],
      default: "private",
    },
  ],
  notes: [
    "Сайт будет доступен на <имя>.<ваш поддомен>.workers.dev через 1–2 минуты после создания.",
    "Миграции из папки migrations применяются автоматически при каждом деплое.",
  ],

  async provision(ctx) {
    const { name } = ctx.project;
    const gh = ctx.github();
    const cf = ctx.cloudflare();

    await ctx.log("Создаю базу D1…");
    const db = await cf.client.createD1(`${name}-db`);
    await ctx.addResource({
      type: "cloudflare.d1",
      kind: "database",
      name: db.name,
      externalId: db.uuid,
      url: null,
      consoleUrl: cloudflareConsole.d1(cf.accountId, db.uuid),
      meta: {},
    });

    await ctx.log("Создаю репозиторий…");
    const repo = await gh.client.createRepo({
      name,
      description: "Создано в apphub: Cloudflare Workers + D1",
      private: ctx.params.visibility !== "public",
    });
    await ctx.addResource({
      type: "github.repo",
      kind: "repo",
      name: repo.full_name,
      externalId: repo.full_name,
      url: repo.html_url,
      consoleUrl: `${repo.html_url}/actions`,
      meta: { branch: repo.default_branch, workflow: "deploy.yml" },
    });

    await ctx.log("Сохраняю секреты для деплоя в репозиторий…");
    await gh.client.setActionsSecret(repo.full_name, "CLOUDFLARE_API_TOKEN", cf.token);
    await gh.client.setActionsSecret(repo.full_name, "CLOUDFLARE_ACCOUNT_ID", cf.accountId);

    await ctx.addResource({
      type: "cloudflare.worker",
      kind: "service",
      name,
      externalId: name,
      url: `https://${name}.${cf.subdomain}.workers.dev`,
      consoleUrl: cloudflareConsole.worker(cf.accountId, name),
      meta: {},
    });

    await ctx.log("Загружаю код из шаблона…");
    const files = renderTemplate("cf-fullstack", {
      PROJECT_NAME: name,
      COMPAT_DATE,
      D1_NAME: db.name,
      D1_ID: db.uuid,
    });
    await gh.client.commitFiles(repo.full_name, repo.default_branch, files, "Initial commit from apphub");
    await ctx.log("Первый деплой запущен в GitHub Actions");
  },
};
