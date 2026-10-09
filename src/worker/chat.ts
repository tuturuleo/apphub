// Ассистент в интерфейсе apphub: Claude с теми же инструментами, что у MCP-сервера.
// Сервер без состояния: клиент присылает всю переписку и получает её обратно с новыми сообщениями.
// Переписка только дополняется — блоки мышления возвращаются модели без изменений.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Store } from "./db";
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

async function runTool(store: Store, block: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const tool = TOOLS.find((t) => t.name === block.name);
  const fail = (text: string) => ({ type: "tool_result" as const, tool_use_id: block.id, content: text, is_error: true });
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

export async function runChat(
  store: Store,
  history: ChatMessage[],
  // Подмена сети для тестов
  opts: { fetch?: typeof fetch } = {},
): Promise<ChatResult> {
  const connection = await store.getConnection("anthropic");
  if (!connection) throw new UserError("Подключите Claude API на странице «Подключения»");
  const last = history.at(-1);
  if (!last || last.role !== "user") throw new UserError("Последнее сообщение должно быть от пользователя");

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
      if (e instanceof Anthropic.AuthenticationError) throw new UserError("Ключ Claude API недействителен — замените его в «Подключениях»");
      if (e instanceof Anthropic.RateLimitError) throw new UserError("Лимит запросов Claude API — попробуйте через минуту");
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
