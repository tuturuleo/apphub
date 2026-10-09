import { createSupabaseDatabase, sleep } from "./supabase-db";
import { renderTemplate } from "./templates";
import type { Recipe } from "./types";

const REGIONS = [
  { value: "emea", label: "Европа" },
  { value: "americas", label: "Америка" },
  { value: "apac", label: "Азия и Океания" },
];

export const supabaseSite: Recipe = {
  id: "supabase-site",
  name: "Сайт + Postgres",
  summary: "Статика на GitHub Pages, база и авторизация в Supabase. Сервер не нужен: доступ к данным задаётся правилами в базе.",
  stack: ["Supabase", "Postgres", "GitHub Pages", "GitHub Actions"],
  requires: ["github", "supabase"],
  needs: ["supabase.projects"],
  russia: { ok: true, note: null },
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
    "Бесплатный проект засыпает после недели без активности — AppHub покажет это и даст разбудить.",
  ],

  validate(params) {
    return REGIONS.some((r) => r.value === params.region) ? null : "Некорректный регион";
  },

  async provision(ctx) {
    const { name } = ctx.project;
    const gh = ctx.github();
    const sb = ctx.supabase();

    const db = await createSupabaseDatabase(ctx, ctx.params.region);
    const supabaseUrl = db.apiUrl;

    let publishableKey: string | null = null;
    for (let attempt = 0; attempt < 6 && !publishableKey; attempt++) {
      if (attempt > 0) await sleep(5000);
      publishableKey = await sb.client.publishableKey(db.ref);
    }
    if (!publishableKey) throw new Error("Supabase не выдал публичный ключ проекта");
    const dbUrl = db.dbUrl;

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
    await sb.client.updateAuthConfig(db.ref, {
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
