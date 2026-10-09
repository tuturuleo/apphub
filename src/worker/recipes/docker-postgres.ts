import type { RenderRegion } from "../providers/render";
import { createServiceWhenRepoVisible } from "./render-service";
import { createSupabaseDatabase } from "./supabase-db";
import { renderTemplate } from "./templates";
import type { Recipe } from "./types";

// Регион Render и ближайшая к нему группа регионов Supabase
const REGIONS: { value: RenderRegion; label: string; supabase: string }[] = [
  { value: "frankfurt", label: "Европа (Франкфурт)", supabase: "emea" },
  { value: "virginia", label: "США, восток (Вирджиния)", supabase: "americas" },
  { value: "oregon", label: "США, запад (Орегон)", supabase: "americas" },
  { value: "singapore", label: "Азия (Сингапур)", supabase: "apac" },
];

export const dockerPostgres: Recipe = {
  id: "docker-postgres",
  name: "Docker-сервис + Postgres",
  summary:
    "Сервер в Docker на Render — шаблон на Python и FastAPI, заменяется на любой язык — и база Postgres в Supabase.",
  stack: ["Render", "Docker", "Python", "Supabase", "Postgres"],
  requires: ["github", "render", "supabase"],
  needs: ["supabase.projects", "render.hours"],
  russia: { ok: true, note: null },
  fields: [
    {
      key: "region",
      label: "Регион",
      type: "select",
      options: REGIONS.map(({ value, label }) => ({ value, label })),
      default: "frankfurt",
    },
  ],
  notes: [
    "Render собирает Docker-образ при каждом push в main — сборки видны в AppHub рядом с проектом. Первая — 3–5 минут.",
    "Бесплатный инстанс засыпает через 15 минут без запросов, первый запрос после сна — около минуты.",
    "Миграции из папки migrations применяются при старте приложения.",
    "Строка подключения к базе лежит в переменных окружения Render, в репозиторий не попадает.",
  ],

  validate(params) {
    return REGIONS.some((r) => r.value === params.region) ? null : "Некорректный регион";
  },

  // Порядок: репозиторий → сервис Render → база. Если Render не увидит репозиторий,
  // мы ещё не заняли бесплатный слот Supabase (их всего два).
  async provision(ctx) {
    const { name } = ctx.project;
    const gh = ctx.github();
    const render = ctx.render();
    ctx.supabase(); // все подключения проверяем до того, как что-то создать
    const region = REGIONS.find((r) => r.value === ctx.params.region)!;

    await ctx.log("Создаю репозиторий…");
    const repo = await gh.client.createRepo({
      name,
      description: "Создано в apphub: Docker на Render + Postgres в Supabase",
      private: true,
    });
    // Без meta.workflow: сборку и деплой делает Render, не GitHub Actions
    await ctx.addResource({
      type: "github.repo",
      kind: "repo",
      name: repo.full_name,
      externalId: repo.full_name,
      url: repo.html_url,
      consoleUrl: repo.html_url,
      meta: { branch: repo.default_branch },
    });

    // Код — до создания сервиса: Render сразу запускает первый деплой с последнего коммита
    await ctx.log("Загружаю код из шаблона…");
    const files = renderTemplate("docker-postgres", { PROJECT_NAME: name });
    await gh.client.commitFiles(repo.full_name, repo.default_branch, files, "Initial commit from apphub");

    await ctx.log("Создаю веб-сервис в Render…");
    const service = await createServiceWhenRepoVisible(ctx, () =>
      render.client.createDockerService({
        ownerId: render.ownerId,
        name,
        repoUrl: repo.html_url,
        branch: repo.default_branch,
        region: region.value,
        healthCheckPath: "/health",
      }),
    );
    await ctx.addResource({
      type: "render.service",
      kind: "service",
      name,
      externalId: service.id,
      url: service.serviceDetails.url ?? null,
      consoleUrl: service.dashboardUrl,
      meta: { region: region.value },
    });

    const db = await createSupabaseDatabase(ctx, region.supabase);

    await ctx.log("Передаю строку подключения в переменные окружения Render и перезапускаю деплой…");
    await render.client.setEnvVars(service.id, { DATABASE_URL: db.dbUrl });
    await render.client.triggerDeploy(service.id);
    await ctx.log("Render собирает деплой с базой (3–5 минут)");
  },
};
