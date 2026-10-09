// Ассистент в интерфейсе AppHub с теми же инструментами, что у MCP-сервера. Модель на выбор: Claude API или
// бесплатные OpenAI-совместимые (Workers AI без ключей, Groq, OpenRouter и др. из каталога ресурсов).
// Сервер без состояния: клиент присылает всю переписку и получает её обратно с новыми сообщениями.
// Переписка хранится в формате блоков Claude; для OpenAI-моделей она переводится туда и обратно.
// С Claude переписка только дополняется — блоки мышления возвращаются модели без изменений.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Store } from "./db";
import {
  DEFAULT_WORKERS_AI_MODEL,
  WORKERS_AI_MODELS,
  chatCompletion,
  isLlmProvider,
  llmCredentials,
  providerName,
  type LlmTarget,
  type OaiMessage,
  type OaiTool,
} from "./llm";
import { relayFetch } from "./providers/http";
import { UserError } from "./service";
import { INSTRUCTIONS, TOOLS, type AppTool } from "./tools";

const MODEL = "claude-opus-5-5";
const MAX_STEPS = 16;

const SYSTEM = `Ты — ассистент внутри веб-интерфейса apphub. Пользователь видит этот чат и страницы проектов рядом.
Отвечай по-русски, коротко и по делу. Ссылки на сайты и консоли давай полностью.
Перед действиями, которые создают или меняют что-то у провайдеров (create_project, update_project_files, deploy_project, wake_resource), опиши, что сделаешь, и дождись согласия пользователя в чате.
Создание проекта идёт в фоне: после create_project сообщи пользователю, что прогресс виден на странице проекта, и не опрашивай get_project больше пары раз подряд.

${INSTRUCTIONS}`;

export type ChatMessage = Anthropic.Beta.BetaMessageParam;

export interface ChatResult {
  messages: ChatMessage[];
  stopReason: string | null;
}

function toolDefinition(tool: AppTool): Anthropic.Beta.BetaTool {
  const { $schema: _, ...schema } = z.toJSONSchema(z.object(tool.input)) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
  };
}

async function runTool(
  store: Store,
  block: Anthropic.Beta.BetaToolUseBlock,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const tool = TOOLS.find((t) => t.name === block.name);
  const fail = (text: string) => ({
    type: "tool_result" as const,
    tool_use_id: block.id,
    content: text,
    is_error: true,
  });
  if (!tool) return fail(`Неизвестный инструмент ${block.name}`);

  const parsed = z.object(tool.input).safeParse(block.input);
  if (!parsed.success) return fail(`Некорректные параметры: ${parsed.error.message}`);
  try {
    const result = await tool.run(store, parsed.data as never);
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result, null, 2) };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export interface ChatModelOption {
  id: string;
  label: string;
  group: string;
  /** Известно ли, что модель умеет вызывать инструменты. */
  tools: boolean | null;
}

/** Модели для ассистента: Workers AI всегда, модели из каталога, Claude — если подключён ключ. */
export async function chatModels(store: Store): Promise<ChatModelOption[]> {
  const options: ChatModelOption[] = [];
  if (store.env.AI) {
    for (const m of WORKERS_AI_MODELS) {
      options.push({ id: `workers-ai:${m.id}`, label: m.label, group: "Workers AI — без ключей", tools: true });
    }
  }
  const connections = await store.listConnections();
  for (const r of (await store.listCatalog()).filter((x) => x.type === "llm.model")) {
    const c = connections.find((x) => x.id === r.connectionId);
    if (!c || !isLlmProvider(c.provider)) continue;
    options.push({
      id: `resource:${r.id}`,
      label: r.name,
      group: providerName(c.provider, c.meta.baseUrl),
      tools: r.meta.tools === "yes" ? true : r.meta.tools === "no" ? false : null,
    });
  }
  if (connections.some((c) => c.provider === "anthropic")) {
    options.push({ id: "anthropic", label: "Claude Opus 5.5", group: "Claude API", tools: true });
  }
  return options;
}

/** Куда идёт запрос для выбранной модели. */
async function resolveTarget(store: Store, model: string): Promise<LlmTarget | "anthropic"> {
  if (model === "anthropic") return "anthropic";
  if (model.startsWith("workers-ai:")) {
    const id = model.slice("workers-ai:".length);
    const known = WORKERS_AI_MODELS.find((m) => m.id === id);
    if (!known) throw new UserError("Неизвестная модель Workers AI");
    return { kind: "workers-ai", model: id, extra: known.extra };
  }
  if (model.startsWith("resource:")) {
    const r = await store.getResource(model.slice("resource:".length));
    if (!r || r.type !== "llm.model") throw new UserError("Модель не найдена в каталоге — выберите другую");
    const c = r.connectionId ? await store.getConnectionById(r.connectionId) : null;
    if (!c || !isLlmProvider(c.provider)) throw new UserError(`Аккаунт провайдера модели «${r.name}» не подключён`);
    return { kind: "http", provider: c.provider, ...llmCredentials(c), model: r.externalId };
  }
  throw new UserError("Неизвестная модель ассистента");
}

export async function runChat(
  store: Store,
  history: ChatMessage[],
  // Подмена сети для тестов
  opts: { fetch?: typeof fetch; model?: string } = {},
): Promise<ChatResult> {
  const last = history.at(-1);
  if (!last || last.role !== "user") throw new UserError("Последнее сообщение должно быть от пользователя");
  const target = await resolveTarget(store, opts.model ?? `workers-ai:${DEFAULT_WORKERS_AI_MODEL}`);
  if (target !== "anthropic") return runOpenAiChat(store, history, target, opts.fetch);

  const connection = await store.defaultConnection("anthropic");
  if (!connection) throw new UserError("Подключите Claude API на странице «Подключения»");

  const client = new Anthropic({ apiKey: connection.token, fetch: opts.fetch ?? relayFetch });
  const tools = TOOLS.map(toolDefinition);
  const messages = [...history];
  let stopReason: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        // Если модель откажется отвечать по соображениям безопасности, запрос подхватит резервная модель
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system: SYSTEM,
        tools,
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError)
        throw new UserError("Ключ Claude API недействителен — замените его в «Подключениях»");
      if (e instanceof Anthropic.RateLimitError)
        throw new UserError("Лимит запросов Claude API — попробуйте через минуту");
      if (e instanceof Anthropic.APIError) throw new UserError(`Claude API: ${e.message}`, 400);
      throw e;
    }

    messages.push({ role: "assistant", content: response.content });
    stopReason = response.stop_reason;
    if (response.stop_reason !== "tool_use") break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    // По одному: инструменты меняют проекты, порядок важен
    for (const block of response.content) {
      if (block.type === "tool_use") results.push(await runTool(store, block));
    }
    messages.push({ role: "user", content: results });
  }

  return { messages, stopReason };
}

// --- OpenAI-совместимые модели ---

/** Бесплатные модели слабее Claude: просим действовать короче и не выдумывать параметры. */
const OAI_SYSTEM = `${SYSTEM}

Вызывай инструменты, только когда нужны данные или действие; параметры бери из ответов инструментов, не выдумывай id.
Не пиши рассуждения в ответе — только итог для пользователя.`;

function oaiTool(tool: AppTool): OaiTool {
  const { $schema: _, ...schema } = z.toJSONSchema(z.object(tool.input)) as Record<string, unknown>;
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: schema } };
}

/** Переписка в формате блоков → сообщения OpenAI. Блоки мышления Claude пропускаются. */
export function toOpenAi(history: ChatMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: "system", content: OAI_SYSTEM }];
  for (const m of history) {
    if (typeof m.content === "string") {
      out.push(m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content });
      continue;
    }
    const blocks = m.content as unknown as { type: string; [k: string]: unknown }[];
    if (m.role === "user") {
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content });
        }
      }
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text))
        .join("\n");
      if (text) out.push({ role: "user", content: text });
    } else {
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text))
        .join("\n");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id),
          type: "function" as const,
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        }));
      // Пустая строка, а не null: Workers AI не принимает null рядом с tool_calls
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

/** Ответ модели → блоки. Рассуждения (<think>) выкидываем; у вызовов без id придумываем свой. */
export function fromOpenAi(
  message: { content: string | null; tool_calls?: unknown[] },
  step: number,
): {
  blocks: Anthropic.Beta.BetaContentBlockParam[];
  calls: { id: string; name: string; input: Record<string, unknown> | null }[];
} {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  const text = (message.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (text) blocks.push({ type: "text", text });
  const calls = (message.tool_calls ?? []).map((raw, i) => {
    const call = raw as {
      id?: string;
      name?: string;
      arguments?: unknown;
      function?: { name?: string; arguments?: unknown };
    };
    const name = call.function?.name ?? call.name ?? "";
    const args = call.function?.arguments ?? call.arguments;
    let input: Record<string, unknown> | null;
    try {
      input =
        typeof args === "string" ? (args.trim() ? JSON.parse(args) : {}) : ((args as Record<string, unknown>) ?? {});
    } catch {
      input = null; // модель прислала битый JSON — сообщим ей об этом результатом инструмента
    }
    const id = (call.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "") || `call_${step}_${i}`;
    return { id, name, input };
  });
  for (const c of calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
  return { blocks, calls };
}

async function runOpenAiChat(
  store: Store,
  history: ChatMessage[],
  target: LlmTarget,
  fetchImpl?: typeof fetch,
): Promise<ChatResult> {
  const tools = TOOLS.map(oaiTool);
  const messages = [...history];
  let stopReason: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await chatCompletion(store.env, target, { messages: toOpenAi(messages), tools }, fetchImpl);
    } catch (e) {
      const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
      throw new UserError(step === 0 ? reason : `${reason} (на шаге ${step + 1}, после вызова инструментов)`, 400);
    }
    const choice = response.choices?.[0];
    if (!choice) throw new UserError("Модель вернула пустой ответ — попробуйте ещё раз или выберите другую", 400);
    const { blocks, calls } = fromOpenAi(choice.message, step);
    if (blocks.length === 0) blocks.push({ type: "text", text: "(модель ничего не ответила)" });
    messages.push({ role: "assistant", content: blocks });
    stopReason = calls.length ? "tool_use" : (choice.finish_reason ?? "stop");
    if (!calls.length) break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      results.push(
        call.input === null
          ? {
              type: "tool_result",
              tool_use_id: call.id,
              content: "Аргументы не разобрались как JSON — повтори вызов",
              is_error: true,
            }
          : await runTool(store, {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.input,
            } as Anthropic.Beta.BetaToolUseBlock),
      );
    }
    messages.push({ role: "user", content: results });
  }
  return { messages, stopReason };
}
