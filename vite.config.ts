import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  // Фиксированный порт: на него смотрит MCP-конфиг Claude Code (.mcp.json)
  server: { port: 5179, strictPort: true },
});
