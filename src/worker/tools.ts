// Инструменты apphub для LLM: одни определения для MCP-сервера и встроенного чата.
import { z } from "zod";
import type { Project } from "../shared/types";
import type { Store } from "./db";
import { projectStatus } from "./engine";
import { collectLimits, formatAmount } from "./limits";
import { notify, reconcileAlerts, runMonitor } from "./monitor";
import { PROVIDERS } from "./providers";
import { RECIPES, recipeInfo } from "./recipes";
import {
  UserError,
  createProject,
  getSettings,
  listGoogleSheets,
  deployProject,
  listProjectFiles,
  listProjectSummaries,
  readProjectFiles,
  runAction,
  settleProvisioning,
  startProvisioning,
  updateProjectFiles,
} from "./service";

export const INSTRUCTIONS = `apphub создаёт прототипы на бесплатных тарифах (GitHub, Cloudflare, Supabase) по готовым рецептам и следит за ними.

Как разворачивать проект:
1. list_recipes — выбери рецепт под задачу пользователя. Предпочитай рецепты с recommended: true: если пользователи в России, это рецепты, которые открываются без VPN; рецепт с availableInRussiaWithoutVpn: false предлагай, только объяснив ограничение. Если у рецепта есть missingConnections, попроси пользователя подключить провайдера в интерфейсе apphub (страница «Подключения») — токены через MCP не передаются.
2. Согласуй с пользователем имя проекта (станет именем репозитория и сервисов) и параметры рецепта.
3. create_project — создаёт ресурсы у провайдеров. Это реальные репозитории и сервисы в аккаунтах пользователя, поэтому вызывай только после его явного согласия. Создание идёт в фоне: инструмент отвечает сразу, а status проекта в get_project меняется с provisioning на ready или failed (1–5 минут, с Supabase дольше).
4. Первый деплой идёт 1–5 минут (GitHub Actions или Render — см. runs). Проверяй get_project, пока он не завершится; при ошибке открой лог по ссылке из runs и разберись с причиной.

Своё приложение вместо демо из шаблона:
1. Создай проект по подходящему рецепту (create_project) — он даёт рабочую инфраструктуру и деплой.
2. get_project_files без paths — структура; затем прочитай ключевые файлы (конфиг, workflow, код, миграции), чтобы сохранить их соглашения.
3. update_project_files — закоммить код приложения. Не ломай конфиг деплоя (wrangler.jsonc, .github/workflows, Dockerfile, имена баз и биндингов). Схему базы меняй новыми файлами миграций, не правь применённые.
4. Коммит запускает деплой — дождись его в get_project и проверь, что сайт открывается.

Удалять проекты отсюда нельзя — только в интерфейсе apphub кнопкой «Удалить проект и ресурсы».`;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface AppTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run(store: Store, input: z.infer<z.ZodObject<S>>): Promise<unknown>;
}

const defineTool = <S extends z.ZodRawShape>(tool: AppTool<S>): AppTool => tool as unknown as AppTool;

export async function findProject(store: Store, ref: string): Promise<Project> {
  const project = (await store.getProject(ref)) ?? (await store.getProjectByName(ref.trim().toLowerCase()));
  if (!project) throw new UserError(`Проект «${ref}» не найден`, 404);
  return settleProvisioning(store, project);
}

async function projectView(store: Store, project: Project) {
  const resources = await store.listResources(project.id);
  const status = await projectStatus(store, resources).catch((e: unknown) => ({
    health: [],
    runs: [],
    error: e instanceof Error ? e.message : String(e),
  }));
  if (!("error" in status)) {
    // Как и в интерфейсе: увиденная проблема сразу становится алертом с уведомлением
    const { messages } = await reconcileAlerts(store, project, resources, status);
    await notify(store, messages);
  }
  const [events, alerts] = await Promise.all([store.listEvents(project.id), store.listAlerts(project.id)]);
  const health = new Map(status.health.map((h) => [h.resourceId, h]));
  return {
    id: project.id,
    name: project.name,
    recipe: project.recipeId,
    status: project.status,
    error: project.error,
    params: project.params,
    resources: resources.map((r) => {
      const h = health.get(r.id);
      return {
        id: r.id,
        kind: r.kind,
        type: r.type,
        name: r.name,
        url: r.url,
        consoleUrl: r.consoleUrl,
        health: h ? { state: h.state, summary: h.summary, action: h.action?.id } : null,
      };
    }),
    runs: status.runs.map((run) => ({
      source: run.source,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      commit: run.commitMessage,
      createdAt: run.createdAt,
      logUrl: run.url,
    })),
    statusError: "error" in status ? status.error : undefined,
    alerts: alerts.map((a) => ({ message: a.message, url: a.url, since: new Date(a.createdAt).toISOString() })),
    journal: events.slice(-20).map((e) => `${e.level === "error" ? "ОШИБКА: " : ""}${e.message}`),
  };
}

const projectRef = z.string().describe("id или имя проекта");

export const TOOLS: AppTool[] = [
  defineTool({
    name: "list_recipes",
    title: "Рецепты",
    description:
      "Список рецептов: что создаётся, на каких сервисах, какие параметры нужны и каких подключений не хватает.",
    annotations: { readOnlyHint: true },
    input: {},
    async run(store) {
      const connected = new Set((await store.listConnections()).map((c) => c.provider));
      const { audienceRussia } = await getSettings(store);
      return RECIPES.map((r) => {
        const info = recipeInfo(r);
        return {
          id: info.id,
          name: info.name,
          summary: info.summary,
          stack: info.stack,
          missingConnections: info.requires.filter((p) => !connected.has(p)),
          usesLimits: info.needs,
          availableInRussiaWithoutVpn: info.russia.ok,
          russiaNote: info.russia.note,
          recommended: !audienceRussia || info.russia.ok,
          params: info.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            onlyWhen: f.showIf,
            required: !!f.required,
            default: f.default,
            options: f.options?.map((o) => o.value),
            help: f.help,
          })),
          notes: info.notes,
        };
      });
    },
  }),
  defineTool({
    name: "list_connections",
    title: "Подключения",
    description:
      "Какие провайдеры подключены и под какими аккаунтами (у провайдера их может быть несколько). id аккаунта " +
      "передаётся в create_project.accounts, если нужен не аккаунт по умолчанию (первый). Токены не возвращаются.",
    annotations: { readOnlyHint: true },
    input: {},
    async run(store) {
      const connections = await store.listConnections();
      return PROVIDERS.map((p) => ({
        provider: p.id,
        name: p.name,
        accounts: connections
          .filter((c) => c.provider === p.id)
          .map((c, i) => ({ id: c.id, label: c.label, default: i === 0 })),
      }));
    },
  }),
  defineTool({
    name: "list_resources",
    title: "Каталог ресурсов",
    description:
      "Все ресурсы apphub: репозитории, базы, сервисы, таблицы, внешние базы — с аккаунтом, происхождением " +
      "(created — создан apphub, imported — найден в аккаунте, external — свой сервер) и проектами, к которым привязаны.",
    input: {},
    annotations: { readOnlyHint: true },
    async run(store) {
      return (await store.listCatalog()).map((r) => ({
        id: r.id,
        type: r.type,
        kind: r.kind,
        name: r.name,
        account: r.account,
        origin: r.origin,
        url: r.url,
        projects: r.projects,
      }));
    },
  }),
  defineTool({
    name: "list_drive_sheets",
    title: "Таблицы Google Drive",
    description:
      "Google-таблицы, доступные сервисному аккаунту apphub (ими поделились с его почтой). id подходит для параметра " +
      "sheetId рецепта sheet-site с source=drive. Если нужной таблицы нет — попроси пользователя поделиться ею с serviceAccount.",
    input: {},
    annotations: { readOnlyHint: true },
    async run(store) {
      return listGoogleSheets(store);
    },
  }),
  defineTool({
    name: "get_limits",
    title: "Лимиты бесплатных тарифов",
    description:
      "Занято / доступно по лимитам бесплатных тарифов подключённых провайдеров (проекты Supabase, базы D1, Workers, " +
      "часы Render и т.п.) и кто занимает. state: ok, warn (≥80%), full, info (потребление через API не узнать). " +
      "Сверяйся перед create_project: рецепт с исчерпанным лимитом не создастся.",
    input: {},
    annotations: { readOnlyHint: true },
    async run(store) {
      return (await collectLimits(store)).map((l) => ({
        key: l.key,
        label: l.label,
        state: l.state,
        used: l.used === null ? null : formatAmount(l.used, l.unit),
        limit: formatAmount(l.limit, l.unit),
        holders: l.holders,
        note: l.note,
        consoleUrl: l.consoleUrl,
      }));
    },
  }),
  defineTool({
    name: "list_projects",
    title: "Проекты",
    description: "Все проекты apphub со статусом создания и ссылками на сайты.",
    annotations: { readOnlyHint: true },
    input: {},
    async run(store) {
      return (await listProjectSummaries(store)).map((p) => ({
        id: p.id,
        name: p.name,
        recipe: p.recipeId,
        status: p.status,
        error: p.error,
        alerts: p.alerts,
        links: p.links,
      }));
    },
  }),
  defineTool({
    name: "get_project",
    title: "Проект",
    description:
      "Подробности проекта: ресурсы со статусами (живой запрос к провайдерам), последние сборки и деплои (GitHub Actions, Render) со ссылками на логи, активные проблемы и журнал.",
    input: { project: projectRef },
    annotations: { readOnlyHint: true },
    async run(store, { project }) {
      return projectView(store, await findProject(store, project));
    },
  }),
  defineTool({
    name: "create_project",
    title: "Создать проект",
    description:
      "Создаёт проект по рецепту: репозиторий, базы и сервисы в аккаунтах пользователя, секреты и деплой. " +
      "Создание идёт в фоне — следи за status и journal через get_project. Вызывай только с согласия пользователя.",
    input: {
      recipe: z.string().describe("id рецепта из list_recipes"),
      name: z.string().describe("имя проекта: 3–32 символа, латиница в нижнем регистре, цифры, дефис"),
      params: z.record(z.string(), z.string()).optional().describe("параметры рецепта по key из list_recipes"),
      accounts: z
        .record(z.string(), z.string())
        .optional()
        .describe("аккаунт для провайдера: { github: <id аккаунта> } из list_connections; по умолчанию — первый"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(store, { recipe, name, params, accounts }) {
      const created = await createProject(store, { recipeId: recipe, name, params, accounts });
      const project = await startProvisioning(store, created.id);
      return {
        id: project.id,
        name: project.name,
        status: project.status,
        error: project.error,
        next:
          project.status === "failed"
            ? "Создание не запустилось — см. error."
            : "Ресурсы создаются в фоне. Проверяй get_project раз в 30–60 секунд, пока status не станет ready или failed.",
      };
    },
  }),
  defineTool({
    name: "get_project_files",
    title: "Файлы проекта",
    description:
      "Без paths — список файлов репозитория проекта с размерами. С paths — содержимое этих файлов (до 30 за раз).",
    input: {
      project: projectRef,
      paths: z.array(z.string()).optional().describe("пути файлов от корня репозитория"),
    },
    annotations: { readOnlyHint: true },
    async run(store, { project, paths }) {
      const p = await findProject(store, project);
      return paths?.length ? readProjectFiles(store, p.id, paths) : listProjectFiles(store, p.id);
    },
  }),
  defineTool({
    name: "update_project_files",
    title: "Изменить код проекта",
    description:
      "Один коммит в основную ветку репозитория проекта: создать или заменить файлы целиком, удалить ненужные. " +
      "Push запускает деплой в GitHub Actions. До 100 файлов и 2 МБ за коммит.",
    input: {
      project: projectRef,
      message: z.string().describe("сообщение коммита"),
      files: z
        .array(z.object({ path: z.string(), content: z.string().describe("полное содержимое файла") }))
        .optional()
        .describe("файлы для создания или замены"),
      remove: z.array(z.string()).optional().describe("пути файлов для удаления"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run(store, { project, message, files, remove }) {
      const p = await findProject(store, project);
      const result = await updateProjectFiles(store, p.id, { files, remove, message });
      return { ...result, next: "Коммит запустил деплой. Проверь get_project через 1–2 минуты." };
    },
  }),
  defineTool({
    name: "check_projects",
    title: "Проверить проекты",
    description:
      "Проверяет все проекты сейчас: открывает алерты о новых проблемах (упал деплой, ресурс в ошибке, база уснула, " +
      "отключено расписание), закрывает исправленные и шлёт изменения в Telegram, если он подключён.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    input: {},
    async run(store) {
      return runMonitor(store);
    },
  }),
  defineTool({
    name: "deploy_project",
    title: "Задеплоить",
    description: "Запускает workflow деплоя проекта в GitHub Actions на текущем коде.",
    input: { project: projectRef },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(store, { project }) {
      const p = await findProject(store, project);
      await deployProject(store, p.id);
      return { started: true, next: "Запуск появится в get_project через несколько секунд." };
    },
  }),
  defineTool({
    name: "wake_resource",
    title: "Действие над ресурсом",
    description:
      "Действие над ресурсом, если get_project показывает health.action: wake — разбудить проект Supabase на паузе, " +
      "enable_workflows — включить workflow, которые GitHub отключил из-за неактивности.",
    input: {
      project: projectRef,
      resourceId: z.string().describe("id ресурса из get_project"),
      action: z.enum(["wake", "enable_workflows"]).optional().describe("по умолчанию wake"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(store, { project, resourceId, action }) {
      const p = await findProject(store, project);
      await runAction(store, p.id, resourceId, action ?? "wake");
      return { started: true, next: "Статус обновится в get_project через 1–2 минуты." };
    },
  }),
];
