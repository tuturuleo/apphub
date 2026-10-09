import { describe, expect, it } from "vitest";
import type { Store } from "../src/worker/db";
import { runChat } from "../src/worker/chat";

const store = {
  defaultConnection: async (provider: string) =>
    provider === "anthropic"
      ? { id: "conn-anthropic", provider, label: "", accountId: "", meta: {}, createdAt: 0, token: "sk-test" }
      : null,
  listConnections: async () => [{ id: "conn-github", provider: "github", label: "me", accountId: "me", meta: {}, createdAt: 0 }],
  getMeta: async () => null,
} as unknown as Store;

const message = (content: unknown[], stop_reason: string) => ({
  id: "msg",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** Имитация Claude API: сначала просит инструмент, потом отвечает текстом. */
function fakeApi() {
  const requests: Record<string, unknown>[] = [];
  const responses = [
    message([{ type: "tool_use", id: "tu_1", name: "list_connections", input: {} }], "tool_use"),
    message([{ type: "text", text: "GitHub подключён." }], "end_turn"),
  ];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(responses.shift()), { headers: { "content-type": "application/json" } });
  };
  return { fetch, requests };
}

describe("runChat", () => {
  it("выполняет инструменты и возвращает дополненную переписку", async () => {
    const api = fakeApi();
    const result = await runChat(store, [{ role: "user", content: "Что подключено?" }], { fetch: api.fetch, model: "anthropic" });

    expect(result.stopReason).toBe("end_turn");
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const toolResult = (result.messages[2].content as { type: string; content: string; is_error?: boolean }[])[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.is_error).toBeUndefined();
    const github = JSON.parse(toolResult.content).find((c: { provider: string }) => c.provider === "github");
    expect(github.accounts).toEqual([{ id: "conn-github", label: "me", default: true }]);

    const first = api.requests[0];
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.fallbacks).toBe("default");
    expect((first.tools as { name: string }[]).map((t) => t.name)).toContain("create_project");
    // второй запрос несёт ответ модели без изменений + результаты инструментов
    expect((api.requests[1].messages as unknown[]).length).toBe(3);
  });

  it("неверные параметры инструмента возвращаются модели ошибкой, а не роняют чат", async () => {
    const responses = [
      message([{ type: "tool_use", id: "tu_1", name: "get_project", input: {} }], "tool_use"),
      message([{ type: "text", text: "Уточните проект." }], "end_turn"),
    ];
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify(responses.shift()), { headers: { "content-type": "application/json" } });
    const result = await runChat(store, [{ role: "user", content: "Покажи проект" }], { fetch, model: "anthropic" });
    const toolResult = (result.messages[2].content as { is_error?: boolean; content: string }[])[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/Некорректные параметры/);
  });

  it("без подключённого Claude API — понятная ошибка", async () => {
    const noKey = { defaultConnection: async () => null } as unknown as Store;
    await expect(runChat(noKey, [{ role: "user", content: "привет" }], { model: "anthropic" })).rejects.toThrow(/Подключите Claude API/);
  });
});

describe("ассистент на OpenAI-совместимой модели (Workers AI)", () => {
  function aiStore() {
    const bodies: { messages: { role: string; tool_call_id?: string; content?: string | null }[]; tools: unknown[] }[] = [];
    const replies = [
      { choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "list_connections", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [{ message: { content: "<think>смотрю…</think>GitHub подключён.", tool_calls: [] }, finish_reason: "stop" }] },
    ];
    const s = {
      ...store,
      env: { AI: { run: async (_model: string, body: never) => (bodies.push(body), replies.shift()) } },
    } as unknown as Store;
    return { store: s, bodies };
  }

  it("по умолчанию Workers AI: инструменты, id вызовов и чистый текст без рассуждений", async () => {
    const { store: s, bodies } = aiStore();
    const result = await runChat(s, [{ role: "user", content: "Что подключено?" }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools.length).toBeGreaterThan(10);
    // результат инструмента ушёл модели с тем же id, что у вызова
    const toolMsg = bodies[1].messages.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("call_0_0");
    expect(toolMsg.content).toContain("conn-github");
    const final = result.messages.at(-1)!;
    expect(final.content).toEqual([{ type: "text", text: "GitHub подключён." }]);
    expect(result.stopReason).toBe("stop");
  });

  it("битый JSON в аргументах — ошибка модели в результате инструмента, а не падение", async () => {
    const { fromOpenAi } = await import("../src/worker/chat");
    const { calls } = fromOpenAi({ content: null, tool_calls: [{ id: "a.b", name: "get_project", arguments: "{oops" }] }, 3);
    expect(calls[0]).toEqual({ id: "ab", name: "get_project", input: null });
    const objectArgs = fromOpenAi({ content: "", tool_calls: [{ name: "get_project", arguments: { project: "x" } }] }, 0);
    expect(objectArgs.calls[0].input).toEqual({ project: "x" });
  });
});
