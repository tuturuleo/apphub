import { supabaseConsole } from "../providers/supabase";
import { renderTemplate } from "./templates";
import type { Recipe } from "./types";

const REGIONS = [
  { value: "emea", label: "Европа" },
  { value: "americas", label: "Америка" },
  { value: "apac", label: "Азия и Океания" },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Пароль только из букв и цифр, чтобы без сюрпризов жить в строке подключения. */
function generatePassword(length = 32): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export const supabaseSite: Recipe = {
  id: "supabase-site",
  name: "Сайт + Postgres",
  summary: "Статика на GitHub Pages, база и авторизация в Supabase. Сервер не нужен: доступ к данным задаётся правилами в базе.",
  stack: ["Supabase", "Postgres", "GitHub Pages", "GitHub Actions"],
  requires: ["github", "supabase"],
  fields: [
    {
      key: "region",
      label: "Где разместить базу",
      type: "select",
      options: REGIONS,
      default: "emea",
    },
  ],
  notes: [
    "Supabase поднимает базу 1–3 минуты — прогресс виден на странице проекта.",
    "Репозиторий публичный (иначе Pages платный). В код попадает только публичный ключ — данные защищены правилами RLS.",
    "Миграции из supabase/migrations применяются при каждом деплое.",
    "Бесплатный проект засыпает после недели без активности — apphub покажет это и даст разбудить.",
  ],

  validate(params) {
    return REGIONS.some((r) => r.value === params.region) ? null : "Некорректный регион";
  },

  async provision(ctx) {
    const { name } = ctx.project;
    const gh = ctx.github();
    const sb = ctx.supabase();

    await ctx.log("Создаю проект Supabase…");
    const dbPassword = generatePassword();
    const created = await sb.client.createProject({
      name,
      organizationSlug: sb.organizationSlug,
      dbPass: dbPassword,
      regionGroup: ctx.params.region,
    });
    const supabaseUrl = `https://${created.ref}.supabase.co`;
    await ctx.addResource({
      type: "supabase.project",
      kind: "database",
      name: `${name} (Supabase)`,
      externalId: created.ref,
      url: null,
      consoleUrl: supabaseConsole.project(created.ref),
      meta: { apiUrl: supabaseUrl },
    });

    await ctx.log("Жду, пока Supabase поднимет базу (обычно 1–3 минуты)…");
    const deadline = Date.now() + 6 * 60_000;
    for (;;) {
      const { status } = await sb.client.getProject(created.ref);
      if (status === "ACTIVE_HEALTHY") break;
      if (status === "INIT_FAILED") throw new Error("Supabase не смог создать проект (INIT_FAILED)");
      if (Date.now() > deadline) throw new Error(`Supabase слишком долго поднимает базу (статус ${status})`);
      await sleep(5000);
    }

    let publishableKey: string | null = null;
    for (let attempt = 0; attempt < 6 && !publishableKey; attempt++) {
      if (attempt > 0) await sleep(5000);
      publishableKey = await sb.client.publishableKey(created.ref);
    }
    if (!publishableKey) throw new Error("Supabase не выдал публичный ключ проекта");
    const dbUrl = await sb.client.sessionPoolerUrl(created.ref, dbPassword);

    await ctx.log("Создаю публичный репозиторий…");
    const repo = await gh.client.createRepo({
      name,
      description: "Создано в apphub: GitHub Pages + Supabase",
      private: false,
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

    await ctx.log("Включаю GitHub Pages…");
    const pages = await gh.client.enablePages(repo.full_name);
    await ctx.addResource({
      type: "github.pages",
      kind: "site",
      name: `${name} (Pages)`,
      externalId: repo.full_name,
      url: pages.html_url,
      consoleUrl: `${repo.html_url}/settings/pages`,
      meta: {},
    });

    await ctx.log("Настраиваю авторизацию Supabase: адрес сайта и анонимный вход…");
    await sb.client.updateAuthConfig(created.ref, {
      site_url: pages.html_url,
      uri_allow_list: `${pages.html_url.replace(/\/$/, "")}/**`,
      external_anonymous_users_enabled: true,
    });

    await ctx.log("Сохраняю строку подключения к базе в секреты репозитория…");
    await gh.client.setActionsSecret(repo.full_name, "SUPABASE_DB_URL", dbUrl);

    await ctx.log("Загружаю код из шаблона…");
    const files = renderTemplate("supabase-site", {
      PROJECT_NAME: name,
      SUPABASE_URL: supabaseUrl,
      SUPABASE_KEY: publishableKey,
    });
    await gh.client.commitFiles(repo.full_name, repo.default_branch, files, "Initial commit from apphub");
    await ctx.log("Первый деплой запущен в GitHub Actions: миграции, затем публикация сайта");
  },
};
