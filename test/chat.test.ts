import { describe, expect, it } from "vitest";
import type { Store } from "../src/worker/db";
import { runChat } from "../src/worker/chat";

const store = {
  getConnection: async (provider: string) =>
    provider === "anthropic" ? { provider, label: "", accountId: "", meta: {}, createdAt: 0, token: "sk-test" } : null,
  listConnections: async () => [{ provider: "github", label: "me", accountId: "me", meta: {}, createdAt: 0 }],
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
    const result = await runChat(store, [{ role: "user", content: "Что подключено?" }], { fetch: api.fetch });

    expect(result.stopReason).toBe("end_turn");
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const toolResult = (result.messages[2].content as { type: string; content: string; is_error?: boolean }[])[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.is_error).toBeUndefined();
    expect(JSON.parse(toolResult.content).find((c: { provider: string }) => c.provider === "github").connected).toBe(true);

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
    const result = await runChat(store, [{ role: "user", content: "Покажи проект" }], { fetch });
    const toolResult = (result.messages[2].content as { is_error?: boolean; content: string }[])[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/Некорректные параметры/);
  });

  it("без подключённого Claude API — понятная ошибка", async () => {
    const noKey = { getConnection: async () => null } as unknown as Store;
    await expect(runChat(noKey, [{ role: "user", content: "привет" }])).rejects.toThrow(/Подключите Claude API/);
  });
});
