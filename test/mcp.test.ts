import { describe, expect, it } from "vitest";
import type { Store } from "../src/worker/db";
import { handleMcp } from "../src/worker/mcp";

// Достаточно того, что читают list_recipes и list_connections.
const store = {
  listConnections: async () => [{ id: "conn-github", provider: "github", label: "me", accountId: "me", meta: {}, createdAt: 0 }],
  // настройка «Пользователи в России» включена
  getMeta: async (key: string) => (key === "settings.audienceRussia" ? "true" : null),
} as unknown as Store;

async function rpc(method: string, params: unknown = {}) {
  const res = await handleMcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    store,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: Record<string, unknown> }).result;
}

describe("MCP", () => {
  it("отдаёт инструменты; удаляющих среди них нет", async () => {
    const { tools } = (await rpc("tools/list")) as { tools: { name: string }[] };
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_recipes",
        "get_project",
        "create_project",
        "get_project_files",
        "update_project_files",
        "deploy_project",
        "wake_resource",
      ]),
    );
    expect(names.some((n) => /delete|remove/.test(n))).toBe(false);
  });

  it("list_recipes показывает недостающие подключения", async () => {
    const result = (await rpc("tools/call", { name: "list_recipes", arguments: {} })) as {
      content: { text: string }[];
    };
    const recipes = JSON.parse(result.content[0].text) as { id: string; missingConnections: string[] }[];
    expect(recipes.find((r) => r.id === "sheet-site")!.missingConnections).toEqual([]);
    expect(recipes.find((r) => r.id === "cf-fullstack")!.missingConnections).toEqual(["cloudflare"]);
    // при пользователях в России Cloudflare-рецепт не рекомендуется, остальные — да
    const recommended = recipes as unknown as { id: string; recommended: boolean }[];
    expect(recommended.find((r) => r.id === "cf-fullstack")!.recommended).toBe(false);
    expect(recommended.find((r) => r.id === "supabase-site")!.recommended).toBe(true);
  });
});
