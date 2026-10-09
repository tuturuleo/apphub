import { describe, expect, it, vi } from "vitest";
import type { BoundResource, Wire } from "../src/shared/types";
import type { Store } from "../src/worker/db";

// Подменяем клиентов провайдеров: Render записывает переменные в память
const renderCalls: string[] = [];
vi.mock("../src/worker/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/worker/engine")>()),
  Clients: class {
    render = async () => ({
      client: {
        setEnvVar: async (_id: string, key: string, value: string) => void renderCalls.push(`${key}=${value}`),
        triggerDeploy: async () => void renderCalls.push("deploy"),
      },
    });
  },
}));

const { connect, outputsOf } = await import("../src/worker/wiring");

const res = (id: string, type: BoundResource["type"], extra: Partial<BoundResource> = {}): BoundResource => ({
  id,
  connectionId: "conn",
  type,
  kind: "service",
  name: id,
  externalId: id,
  url: null,
  consoleUrl: null,
  meta: {},
  origin: "created",
  createdAt: 0,
  role: "x",
  binding: {},
  ...extra,
});

function fakeStore(secrets: Record<string, string>) {
  const saved: Wire[] = [];
  const store = {
    listResources: async () => [
      res("db", "postgres.external", { kind: "database" }),
      res("nodb", "supabase.project", { kind: "database" }),
      res("api", "render.service"),
      res("d1", "cloudflare.d1", { kind: "database" }),
      res("shared", "postgres.external", { kind: "database", binding: { mode: "isolated", schema: "p_x", role: "r" } }),
    ],
    getBindingSecret: async (_p: string, id: string) => (id === "shared" ? "postgresql://app_x:pw@h:5432/d" : null),
    hasResourceSecret: async (id: string) => id in secrets,
    getResourceSecret: async (id: string) => secrets[id] ?? null,
    saveWire: async (_p: string, w: Wire) => void saved.push(w),
    addEvent: async () => {},
  } as unknown as Store;
  return { store, saved };
}

describe("связи ресурсов", () => {
  it("DATABASE_URL базы записывается в env сервиса Render с передеплоем", async () => {
    renderCalls.length = 0;
    const { store, saved } = fakeStore({ db: "postgresql://u:p@h:5432/d" });
    const wire = await connect(store, "p", { sourceId: "db", output: "DATABASE_URL", targetId: "api" });
    expect(renderCalls).toEqual(["DATABASE_URL=postgresql://u:p@h:5432/d", "deploy"]);
    expect(wire.error).toBeNull();
    expect(wire.appliedAt).not.toBeNull();
    expect(saved.at(-1)?.name).toBe("DATABASE_URL");
  });

  it("нет строки подключения — связь сохраняется с ошибкой, а не теряется", async () => {
    const { store, saved } = fakeStore({});
    const wire = await connect(store, "p", { sourceId: "nodb", output: "DATABASE_URL", targetId: "api", name: "DB_URL" });
    expect(wire.error).toMatch(/не задана строка подключения/);
    expect(saved.at(-1)).toMatchObject({ name: "DB_URL", appliedAt: null });
  });

  it("проверки: потребитель, имя переменной, выход", async () => {
    const { store } = fakeStore({ db: "x" });
    await expect(connect(store, "p", { sourceId: "db", output: "DATABASE_URL", targetId: "d1" })).rejects.toThrow(
      /нельзя записывать/,
    );
    await expect(
      connect(store, "p", { sourceId: "db", output: "DATABASE_URL", targetId: "api", name: "bad-name" }),
    ).rejects.toThrow(/Имя переменной/);
    await expect(connect(store, "p", { sourceId: "db", output: "NOPE", targetId: "api" })).rejects.toThrow(/нет выхода/);
  });

  it("изолированная привязка отдаёт строку пользователя проекта, а не админскую", async () => {
    renderCalls.length = 0;
    const { store } = fakeStore({ shared: "postgresql://postgres:ADMIN@h:5432/d" });
    await connect(store, "p", { sourceId: "shared", output: "DATABASE_URL", targetId: "api" });
    expect(renderCalls[0]).toBe("DATABASE_URL=postgresql://app_x:pw@h:5432/d");
  });

  it("выход без сохранённого секрета помечен недоступным", async () => {
    const { store } = fakeStore({});
    const outputs = await outputsOf(store, res("nodb", "supabase.project"));
    expect(outputs.find((o) => o.key === "DATABASE_URL")?.available).toBe(false);
    expect(outputs.find((o) => o.key === "SUPABASE_URL")?.available).toBe(true);
  });
});
