import { renderTemplate } from "./templates";
import type { Recipe } from "./types";

const SOURCES = [
  { value: "published", label: "Опубликованная таблица (ссылка на CSV)" },
  { value: "drive", label: "Приватная таблица из Google Drive" },
];

const SCHEDULES = [
  { value: "0 * * * *", label: "Каждый час" },
  { value: "0 */6 * * *", label: "Каждые 6 часов" },
  { value: "0 6 * * *", label: "Раз в день" },
];

export const sheetSite: Recipe = {
  id: "sheet-site",
  name: "Сайт из Google-таблицы",
  summary:
    "Статический сайт на GitHub Pages, данные берутся из Google-таблицы — опубликованной или приватной из Drive — и обновляются по расписанию.",
  stack: ["GitHub Pages", "GitHub Actions", "Google Sheets"],
  requires: ["github"],
  needs: ["github.actions"],
  russia: { ok: true, note: null },
  fields: [
    {
      key: "source",
      label: "Откуда брать данные",
      type: "select",
      options: SOURCES,
      default: "published",
    },
    {
      key: "sheetUrl",
      label: "Ссылка на CSV таблицы",
      type: "url",
      placeholder: "https://docs.google.com/spreadsheets/d/e/…/pub?output=csv",
      help: "В Google Таблицах: Файл → Поделиться → Опубликовать в интернете → формат CSV.",
      showIf: { field: "source", values: ["published"] },
    },
    {
      key: "sheetId",
      label: "Таблица",
      type: "google-sheet",
      help: "Таблицы, которыми поделились с сервисным аккаунтом Google. Берётся первый лист.",
      showIf: { field: "source", values: ["drive"] },
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
    "Приватная таблица не публикуется в интернете, но её данные окажутся на публичном сайте — как и у опубликованной.",
    "GitHub отключает расписание в репо без коммитов дольше 60 дней — AppHub предупредит и даст включить обратно.",
  ],

  requiresFor(params) {
    return params.source === "drive" ? ["google"] : [];
  },

  validate(params) {
    if (!SOURCES.some((o) => o.value === params.source)) return "Некорректный источник данных";
    if (params.source === "drive") {
      if (!/^[\w-]{20,}$/.test(params.sheetId ?? "")) return "Выберите таблицу из Google Drive";
    } else {
      try {
        const url = new URL(params.sheetUrl ?? "");
        if (url.protocol !== "https:") return "Ссылка на таблицу должна начинаться с https://";
      } catch {
        return "Укажите ссылку на опубликованную таблицу в формате CSV";
      }
    }
    if (!SCHEDULES.some((o) => o.value === params.schedule)) return "Некорректное расписание";
    return null;
  },

  async provision(ctx) {
    const { name } = ctx.project;
    const gh = ctx.github();
    const fromDrive = ctx.params.source === "drive";

    // Доступ к таблице проверяем до создания репозитория: если его нет, нечего и создавать
    let sheet: { id: string; name: string; url: string } | null = null;
    if (fromDrive) {
      await ctx.log("Проверяю доступ к таблице в Google Drive…");
      const drive = ctx.google();
      const file = await drive.getFile(ctx.params.sheetId).catch((e: unknown) => {
        throw new Error(
          `Нет доступа к таблице — поделитесь ею с ${drive.email}. (${e instanceof Error ? e.message : String(e)})`,
        );
      });
      sheet = { id: file.id, name: file.name, url: file.webViewLink };
    }

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

    if (sheet) {
      await ctx.addResource({
        type: "google.sheet",
        kind: "data",
        name: sheet.name,
        externalId: sheet.id,
        url: sheet.url,
        consoleUrl: sheet.url,
        meta: {},
      });
      await ctx.log("Сохраняю ключ сервисного аккаунта Google в секреты репозитория…");
      await gh.client.setActionsSecret(repo.full_name, "GOOGLE_SA_KEY", JSON.stringify(ctx.google().key));
    }

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
      // значения попадают внутрь JSON-строк в site.config.json
      SHEET_CSV_URL: fromDrive ? "" : JSON.stringify(ctx.params.sheetUrl).slice(1, -1),
      GOOGLE_SHEET_ID: sheet?.id ?? "",
      CRON: ctx.params.schedule,
    });
    await gh.client.commitFiles(repo.full_name, repo.default_branch, files, "Initial commit from apphub");
    await ctx.log("Первая сборка запущена в GitHub Actions");
  },
};
