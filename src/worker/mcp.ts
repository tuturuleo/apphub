// MCP-сервер apphub: те же операции, что в интерфейсе, в виде инструментов для LLM-клиентов
// (Claude Code, Claude Desktop и т.п.). Stateless Streamable HTTP: новый сервер на каждый запрос.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Project } from "../shared/types";
import type { Store } from "./db";
import { projectStatus } from "./engine";
import { PROVIDERS } from "./providers";
import { RECIPES, recipeInfo } from "./recipes";
import {
  UserError,
  createProject,
  deployProject,
  listProjectFiles,
  listProjectSummaries,
  provisionProject,
  readProjectFiles,
  runAction,
  updateProjectFiles,
} from "./service";

const INSTRUCTIONS = `apphub создаёт прототипы на бесплатных тарифах (GitHub, Cloudflare, Supabase) по готовым рецептам и следит за ними.

Как разворачивать проект:
1. list_recipes — выбери рецепт под задачу пользователя. Если у рецепта есть missingConnections, попроси пользователя подключить провайдера в интерфейсе apphub (страница «Подключения») — токены через MCP не передаются.
2. Согласуй с пользователем имя проекта (станет именем репозитория и сервисов) и параметры рецепта.
3. create_project — создаёт ресурсы у провайдеров. Это реальные репозитории и сервисы в аккаунтах пользователя, поэтому вызывай только после его явного согласия.
4. Первый деплой идёт в GitHub Actions 1–3 минуты. Проверяй get_project, пока запуск не завершится; при ошибке открой лог по ссылке из runs и разберись с причиной.

Своё приложение вместо демо из шаблона:
1. Создай проект по подходящему рецепту (create_project) — он даёт рабочую инфраструктуру и деплой.
2. get_project_files без paths — структура; затем прочитай ключевые файлы (конфиг, workflow, код, миграции), чтобы сохранить их соглашения.
3. update_project_files — закоммить код приложения. Не ломай конфиг деплоя (wrangler.jsonc, .github/workflows, имена баз и биндингов). Схему базы меняй новыми файлами миграций, не правь применённые.
4. Коммит запускает деплой — дождись его в get_project и проверь, что сайт открывается.

Удалять ресурсы через apphub нельзя — только в консолях провайдеров.`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

/** Ошибки ввода и провайдеров возвращаем модели текстом, чтобы она могла исправиться или объяснить пользователю. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

async function findProject(store: Store, ref: string): Promise<Project> {
  const project = (await store.getProject(ref)) ?? (await store.getProjectByName(ref.trim().toLowerCase()));
  if (!project) throw new UserError(`Проект «${ref}» не найден`, 404);
  return project;
}

async function projectView(store: Store, project: Project) {
  const [resources, events] = await Promise.all([store.listResources(project.id), store.listEvents(project.id)]);
  const status = await projectStatus(store, resources).catch((e: unknown) => ({
    health: [],
    runs: [],
    error: e instanceof Error ? e.message : String(e),
  }));
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
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      commit: run.commitMessage,
      createdAt: run.createdAt,
      logUrl: run.url,
    })),
    statusError: "error" in status ? status.error : undefined,
    journal: events.slice(-20).map((e) => `${e.level === "error" ? "ОШИБКА: " : ""}${e.message}`),
  };
}

function buildServer(store: Store): McpServer {
  const server = new McpServer({ name: "apphub", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const projectRef = z.string().describe("id или имя проекта");

  server.registerTool(
    "list_recipes",
    {
      title: "Рецепты",
      description:
        "Список рецептов: что создаётся, на каких сервисах, какие параметры нужны и каких подключений не хватает.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const connected = new Set((await store.listConnections()).map((c) => c.provider));
        return RECIPES.map((r) => {
          const info = recipeInfo(r);
          return {
            id: info.id,
            name: info.name,
            summary: info.summary,
            stack: info.stack,
            missingConnections: info.requires.filter((p) => !connected.has(p)),
            params: info.fields.map((f) => ({
              key: f.key,
              label: f.label,
              required: !!f.required,
              default: f.default,
              options: f.options?.map((o) => o.value),
              help: f.help,
            })),
            notes: info.notes,
          };
        });
      }),
  );

  server.registerTool(
    "list_connections",
    {
      title: "Подключения",
      description: "Какие провайдеры подключены к apphub и под какими аккаунтами. Токены не возвращаются.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const connections = await store.listConnections();
        return PROVIDERS.map((p) => {
          const c = connections.find((x) => x.provider === p.id);
          return { provider: p.id, name: p.name, connected: !!c, account: c?.label ?? null };
        });
      }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "Проекты",
      description: "Все проекты apphub со статусом создания и ссылками на сайты.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () =>
        (await listProjectSummaries(store)).map((p) => ({
          id: p.id,
          name: p.name,
          recipe: p.recipeId,
          status: p.status,
          error: p.error,
          links: p.links,
        })),
      ),
  );

  server.registerTool(
    "get_project",
    {
      title: "Проект",
      description:
        "Подробности проекта: ресурсы со статусами (живой запрос к провайдерам), последние запуски GitHub Actions со ссылками на логи и журнал создания.",
      inputSchema: { project: projectRef },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => run(async () => projectView(store, await findProject(store, project))),
  );

  server.registerTool(
    "create_project",
    {
      title: "Создать проект",
      description:
        "Создаёт проект по рецепту: репозиторий, базы и сервисы в аккаунтах пользователя, секреты и деплой. " +
        "Ждёт окончания создания (для Supabase — до нескольких минут). Вызывай только с согласия пользователя.",
      inputSchema: {
        recipe: z.string().describe("id рецепта из list_recipes"),
        name: z.string().describe("имя проекта: 3–32 символа, латиница в нижнем регистре, цифры, дефис"),
        params: z.record(z.string(), z.string()).optional().describe("параметры рецепта по key из list_recipes"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ recipe, name, params }) =>
      run(async () => {
        const created = await createProject(store, { recipeId: recipe, name, params });
        const project = await provisionProject(store, created.id);
        return {
          ...(await projectView(store, project)),
          next:
            project.status === "ready"
              ? "Ресурсы созданы, первый деплой идёт в GitHub Actions. Проверь get_project через 1–2 минуты."
              : "Создание не удалось — см. error и journal. Созданные ресурсы остались у провайдеров.",
        };
      }),
  );

  server.registerTool(
    "get_project_files",
    {
      title: "Файлы проекта",
      description:
        "Без paths — список файлов репозитория проекта с размерами. С paths — содержимое этих файлов (до 30 за раз).",
      inputSchema: {
        project: projectRef,
        paths: z.array(z.string()).optional().describe("пути файлов от корня репозитория"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project, paths }) =>
      run(async () => {
        const p = await findProject(store, project);
        return paths?.length ? readProjectFiles(store, p.id, paths) : listProjectFiles(store, p.id);
      }),
  );

  server.registerTool(
    "update_project_files",
    {
      title: "Изменить код проекта",
      description:
        "Один коммит в основную ветку репозитория проекта: создать или заменить файлы целиком, удалить ненужные. " +
        "Push запускает деплой в GitHub Actions. До 100 файлов и 2 МБ за коммит.",
      inputSchema: {
        project: projectRef,
        message: z.string().describe("сообщение коммита"),
        files: z
          .array(z.object({ path: z.string(), content: z.string().describe("полное содержимое файла") }))
          .optional()
          .describe("файлы для создания или замены"),
        remove: z.array(z.string()).optional().describe("пути файлов для удаления"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ project, message, files, remove }) =>
      run(async () => {
        const p = await findProject(store, project);
        const result = await updateProjectFiles(store, p.id, { files, remove, message });
        return { ...result, next: "Коммит запустил деплой. Проверь get_project через 1–2 минуты." };
      }),
  );

  server.registerTool(
    "deploy_project",
    {
      title: "Задеплоить",
      description: "Запускает workflow деплоя проекта в GitHub Actions на текущем коде.",
      inputSchema: { project: projectRef },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ project }) =>
      run(async () => {
        const p = await findProject(store, project);
        await deployProject(store, p.id);
        return { started: true, next: "Запуск появится в get_project через несколько секунд." };
      }),
  );

  server.registerTool(
    "wake_resource",
    {
      title: "Разбудить ресурс",
      description: "Будит уснувший ресурс (например, проект Supabase на паузе). Доступно, если у ресурса health.action = wake.",
      inputSchema: { project: projectRef, resourceId: z.string().describe("id ресурса из get_project") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ project, resourceId }) =>
      run(async () => {
        const p = await findProject(store, project);
        await runAction(store, p.id, resourceId, "wake");
        return { started: true, next: "Пробуждение занимает 1–2 минуты, статус виден в get_project." };
      }),
  );

  return server;
}

export async function handleMcp(request: Request, store: Store): Promise<Response> {
  const server = buildServer(store);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
