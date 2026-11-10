import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundResource, Wire } from "../src/shared/types";
import type { Store } from "../src/worker/db";
import { ProviderError } from "../src/worker/providers/errors";

// Подменяем клиентов провайдеров: вызовы пишутся в память, сбои и отсутствие аккаунта задаёт тест
const renderCalls: string[] = [];
const failures: Record<string, Error> = {};
const noAccount = new Set<string>();
const call = async (entry: string, method: string) => {
  const err = failures[method];
  if (err) throw err;
  renderCalls.push(entry);
};
vi.mock("../src/worker/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/worker/engine")>()),
  Clients: class {
    render = async () =>
      noAccount.has("render")
        ? null
        : {
            client: {
              setEnvVar: (_id: string, key: string, value: string) => call(`${key}=${value}`, "setEnvVar"),
              deleteEnvVar: (id: string, key: string) => call(`render-del ${id} ${key}`, "deleteEnvVar"),
              triggerDeploy: () => call("deploy", "triggerDeploy"),
            },
          };
    cloudflare = async () =>
      noAccount.has("cloudflare")
        ? null
        : {
            client: {
              deleteWorkerSecret: (id: string, key: string) => call(`cf-del ${id} ${key}`, "deleteWorkerSecret"),
            },
          };
    github = async () =>
      noAccount.has("github")
        ? null
        : {
            client: {
              deleteActionsSecret: (id: string, key: string) => call(`gh-del ${id} ${key}`, "deleteActionsSecret"),
            },
          };
  },
}));

const { connect, disconnect, dropWiresOf, outputsOf } = await import("../src/worker/wiring");

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

const wire = (sourceId: string, targetId: string, name: string): Wire => ({
  sourceId,
  output: "DATABASE_URL",
  targetId,
  name,
  appliedAt: 1,
  error: null,
});

function fakeStore(secrets: Record<string, string>, initialWires: Wire[] = []) {
  const saved: Wire[] = [];
  const wires = [...initialWires];
  const store = {
    listWires: async () => [...wires],
    deleteWire: async (_p: string, targetId: string, name: string) => {
      const i = wires.findIndex((w) => w.targetId === targetId && w.name === name);
      if (i >= 0) wires.splice(i, 1);
    },
    listResources: async () => [
      res("worker", "cloudflare.worker"),
      res("repo", "github.repo", { kind: "repo" }),
      res("db", "postgres.external", { kind: "database" }),
      res("nodb", "supabase.project", { kind: "database" }),
      res("api", "render.service"),
      res("d1", "cloudflare.d1", { kind: "database" }),
      res("shared", "postgres.external", { kind: "database", binding: { mode: "isolated", schema: "p_x", role: "r" } }),
      res("model", "llm.model", { kind: "llm", connectionId: "conn-groq", externalId: "openai/gpt-oss-120b" }),
    ],
    getConnectionById: async (id: string) =>
      id === "conn-groq" ? { id, provider: "groq", label: "", accountId: "", meta: {}, createdAt: 0, token: "gsk_key" } : null,
    getBindingSecret: async (_p: string, id: string) => (id === "shared" ? "postgresql://app_x:pw@h:5432/d" : null),
    hasResourceSecret: async (id: string) => id in secrets,
    getResourceSecret: async (id: string) => secrets[id] ?? null,
    saveWire: async (_p: string, w: Wire) => void saved.push(w),
    addEvent: async () => {},
  } as unknown as Store;
  return { store, saved, wires };
}

beforeEach(() => {
  renderCalls.length = 0;
  for (const k of Object.keys(failures)) delete failures[k];
  noAccount.clear();
});

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

  it("модель LLM отдаёт проекту адрес API, ключ и имя модели", async () => {
    renderCalls.length = 0;
    const { store } = fakeStore({});
    for (const output of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) {
      const wire = await connect(store, "p", { sourceId: "model", output, targetId: "api" });
      expect(wire.error).toBeNull();
    }
    expect(renderCalls.filter((c) => c !== "deploy")).toEqual([
      "LLM_BASE_URL=https://api.groq.com/openai/v1",
      "LLM_API_KEY=gsk_key",
      "LLM_MODEL=openai/gpt-oss-120b",
    ]);
  });
});

describe("отвязка переменных", () => {
  const consumers = [
    { target: "api", provider: "render", method: "deleteEnvVar", calls: ["render-del api DB", "deploy"] },
    { target: "worker", provider: "cloudflare", method: "deleteWorkerSecret", calls: ["cf-del worker DB"] },
    { target: "repo", provider: "github", method: "deleteActionsSecret", calls: ["gh-del repo DB"] },
  ];

  for (const c of consumers) {
    describe(c.provider, () => {
      it("успех: переменная удалена, затем связь", async () => {
        const { store, wires } = fakeStore({}, [wire("db", c.target, "DB")]);
        await disconnect(store, "p", c.target, "DB");
        expect(renderCalls).toEqual(c.calls);
        expect(wires).toEqual([]);
      });

      it("аккаунт не подключён — ошибка, связь остаётся", async () => {
        noAccount.add(c.provider);
        const { store, wires } = fakeStore({}, [wire("db", c.target, "DB")]);
        await expect(disconnect(store, "p", c.target, "DB")).rejects.toThrow(/не подключён/);
        expect(wires).toHaveLength(1);
      });

      it("ошибка API — связь остаётся, повтор удаляет её", async () => {
        failures[c.method] = new ProviderError("сбой", 500);
        const { store, wires } = fakeStore({}, [wire("db", c.target, "DB")]);
        await expect(disconnect(store, "p", c.target, "DB")).rejects.toThrow("сбой");
        expect(wires).toHaveLength(1);
        delete failures[c.method];
        await disconnect(store, "p", c.target, "DB");
        expect(wires).toEqual([]);
      });

      it("404 — переменной уже нет, связь удаляется", async () => {
        failures[c.method] = new ProviderError("not found", 404);
        const { store, wires } = fakeStore({}, [wire("db", c.target, "DB")]);
        await disconnect(store, "p", c.target, "DB");
        expect(wires).toEqual([]);
      });
    });
  }

  it("Render: 404 при удалении всё равно запускает передеплой", async () => {
    failures.deleteEnvVar = new ProviderError("not found", 404);
    const { store } = fakeStore({}, [wire("db", "api", "DB")]);
    await disconnect(store, "p", "api", "DB");
    expect(renderCalls).toEqual(["deploy"]);
  });

  it("Render: сбой передеплоя сохраняет связь, повтор передеплоит и удаляет её", async () => {
    failures.triggerDeploy = new ProviderError("deploy failed", 500);
    const { store, wires } = fakeStore({}, [wire("db", "api", "DB")]);
    await expect(disconnect(store, "p", "api", "DB")).rejects.toThrow("deploy failed");
    expect(wires).toHaveLength(1);
    delete failures.triggerDeploy;
    // Переменная уже удалена прошлой попыткой — Render отвечает 404, деплой всё равно нужен
    failures.deleteEnvVar = new ProviderError("not found", 404);
    await disconnect(store, "p", "api", "DB");
    expect(renderCalls).toEqual(["render-del api DB", "deploy"]);
    expect(wires).toEqual([]);
  });

  it("потребителя нет в проекте — снимается только запись", async () => {
    noAccount.add("render");
    const { store, wires } = fakeStore({}, [wire("db", "gone", "DB")]);
    await disconnect(store, "p", "gone", "DB");
    expect(renderCalls).toEqual([]);
    expect(wires).toEqual([]);
  });

  it("dropWiresOf останавливается на первой ошибке и не трогает остальные связи", async () => {
    failures.deleteWorkerSecret = new ProviderError("сбой", 500);
    const { store, wires } = fakeStore({}, [
      wire("db", "api", "A"),
      wire("db", "worker", "B"),
      wire("db", "repo", "C"),
      wire("other", "repo", "D"),
    ]);
    await expect(dropWiresOf(store, "p", "db")).rejects.toThrow("сбой");
    expect(renderCalls).toEqual(["render-del api A", "deploy"]);
    expect(wires.map((w) => w.name)).toEqual(["B", "C", "D"]);
    delete failures.deleteWorkerSecret;
    await dropWiresOf(store, "p", "db");
    expect(wires.map((w) => w.name)).toEqual(["D"]);
  });
});
