import { defineConfig } from "vitest/config";

// Отдельный конфиг, чтобы тесты не поднимали плагин Cloudflare из vite.config.ts.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
