import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/worker/recipes/templates";

describe("renderTemplate", () => {
  it("cf-fullstack: подставляет переменные и переименовывает служебные файлы", () => {
    const files = renderTemplate("cf-fullstack", {
      PROJECT_NAME: "demo-app",
      COMPAT_DATE: "2026-09-15",
      D1_NAME: "demo-app-db",
      D1_ID: "1111-2222",
    });
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain(".github/workflows/deploy.yml");
    expect(paths).toContain(".gitignore");
    expect(paths).toContain("wrangler.jsonc");
    expect(paths.some((p) => p.startsWith("_"))).toBe(false);

    const all = files.map((f) => f.content).join("\n");
    expect(all).not.toMatch(/%%[A-Z0-9_]+%%/);
    expect(files.find((f) => f.path === "wrangler.jsonc")!.content).toContain('"database_id": "1111-2222"');
    // выражения GitHub Actions не должны пострадать от подстановки
    expect(files.find((f) => f.path === ".github/workflows/deploy.yml")!.content).toContain(
      "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    );
  });

  it("sheet-site: подставляет расписание и ссылку", () => {
    const files = renderTemplate("sheet-site", {
      PROJECT_NAME: "my-sheet",
      SHEET_CSV_URL: "https://example.com/pub?output=csv",
      GOOGLE_SHEET_ID: "",
      CRON: "0 */6 * * *",
    });
    const config = JSON.parse(files.find((f) => f.path === "site.config.json")!.content);
    expect(config.sheetCsvUrl).toBe("https://example.com/pub?output=csv");
    expect(files.find((f) => f.path === ".github/workflows/deploy.yml")!.content).toContain('cron: "0 */6 * * *"');
  });

  it("supabase-site: ключи в config.js, миграции и workflow на месте", () => {
    const files = renderTemplate("supabase-site", {
      PROJECT_NAME: "notes",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_KEY: "sb_publishable_xyz",
    });
    const config = files.find((f) => f.path === "public/config.js")!.content;
    expect(config).toContain('SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co"');
    expect(config).toContain('SUPABASE_KEY = "sb_publishable_xyz"');
    expect(files.some((f) => f.path.startsWith("supabase/migrations/") && f.path.endsWith(".sql"))).toBe(true);
    expect(files.find((f) => f.path === ".github/workflows/deploy.yml")!.content).toContain(
      "${{ secrets.SUPABASE_DB_URL }}",
    );
    expect(files.map((f) => f.content).join("\n")).not.toMatch(/%%[A-Z0-9_]+%%/);
  });

  it("docker-postgres: Dockerfile, .dockerignore, миграции; секретов в репо нет", () => {
    const files = renderTemplate("docker-postgres", { PROJECT_NAME: "py-app" });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["Dockerfile", ".dockerignore", ".gitignore", "app/main.py", "migrations/0001_notes.sql"]),
    );
    expect(paths.some((p) => p.startsWith(".github/"))).toBe(false);
    const all = files.map((f) => f.content).join("\n");
    expect(all).not.toMatch(/%%[A-Z0-9_]+%%/);
    expect(all).not.toMatch(/postgresql:\/\/[^.\s]+:[^@\s]+@/);
  });

  it("падает на незаданной переменной", () => {
    expect(() => renderTemplate("sheet-site", { PROJECT_NAME: "x" })).toThrow(/не задана переменная/);
  });
});
