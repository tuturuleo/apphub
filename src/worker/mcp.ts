// MCP-сервер apphub: инструменты из tools.ts для LLM-клиентов (Claude Code, Claude Desktop и т.п.).
// Stateless Streamable HTTP: новый сервер на каждый запрос.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Store } from "./db";
import { INSTRUCTIONS, TOOLS } from "./tools";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Ошибки ввода и провайдеров возвращаем модели текстом, чтобы она могла исправиться или объяснить пользователю. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

function buildServer(store: Store): McpServer {
  const server = new McpServer({ name: "apphub", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
      (input: Record<string, unknown>) => run(() => tool.run(store, input as never)),
    );
  }
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
