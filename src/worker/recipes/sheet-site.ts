import { renderTemplate } from "./templates";
import type { Recipe } from "./types";

const SCHEDULES = [
  { value: "0 * * * *", label: "Каждый час" },
  { value: "0 */6 * * *", label: "Каждые 6 часов" },
  { value: "0 6 * * *", label: "Раз в день" },
];

export const sheetSite: Recipe = {
  id: "sheet-site",
  name: "Сайт из Google-таблицы",
  summary: "Статический сайт на GitHub Pages, данные берутся из опубликованной таблицы и обновляются по расписанию.",
  stack: ["GitHub Pages", "GitHub Actions", "Google Sheets"],
  requires: ["github"],
  fields: [
    {
      key: "sheetUrl",
      label: "Ссылка на CSV таблицы",
      type: "url",
      required: true,
      placeholder: "https://docs.google.com/spreadsheets/d/e/…/pub?output=csv",
      help: "В Google Таблицах: Файл → Поделиться → Опубликовать в интернете → формат CSV.",
    },
    {
      key: "schedule",
      label: "Пересобирать",
      type: "select",
      options: SCHEDULES,
      default: "0 */6 * * *",
    },
  ],
  notes: [
    "Репозиторий будет публичным: на бесплатном тарифе GitHub Pages работает только для публичных репо.",
    "GitHub отключает расписание в репо без коммитов дольше 60 дней — apphub позже будет об этом предупреждать.",
  ],

  validate(params) {
    try {
      const url = new URL(params.sheetUrl ?? "");
      if (url.protocol !== "https:") return "Ссылка на таблицу должна начинаться с https://";
    } catch {
      return "Некорректная ссылка на таблицу";
    }
    if (!SCHEDULES.some((o) => o.value === params.schedule)) return "Некорректное расписание";
    return null;
  },

  async provision(ctx) {
    const { name } = ctx.project;
    const gh = ctx.github();

    await ctx.log("Создаю публичный репозиторий…");
    const repo = await gh.client.createRepo({
      name,
      description: "Создано в apphub: сайт из Google-таблицы",
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

    await ctx.log("Загружаю код из шаблона…");
    const files = renderTemplate("sheet-site", {
      PROJECT_NAME: name,
      // значение попадает внутрь JSON-строки в site.config.json
      SHEET_CSV_URL: JSON.stringify(ctx.params.sheetUrl).slice(1, -1),
      CRON: ctx.params.schedule,
    });
    await gh.client.commitFiles(repo.full_name, repo.default_branch, files, "Initial commit from apphub");
    await ctx.log("Первая сборка запущена в GitHub Actions");
  },
};
