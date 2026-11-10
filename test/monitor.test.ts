import { describe, expect, it } from "vitest";
import type { HealthState, Project, ProjectAlert, ProjectStatusReport, Resource } from "../src/shared/types";
import type { Store } from "../src/worker/db";
import { chunkMessages, deriveAlerts, reconcileAlerts } from "../src/worker/monitor";

const resource = (id: string, type: Resource["type"], kind: Resource["kind"]): Resource => ({
  id,
  connectionId: "conn-1",
  type,
  kind,
  name: id,
  externalId: id,
  url: `https://${id}.example`,
  consoleUrl: `https://console/${id}`,
  meta: {},
  origin: "created",
  createdAt: 0,
});

const resources = [
  resource("repo", "github.repo", "repo"),
  resource("db", "supabase.project", "database"),
  resource("site", "github.pages", "site"),
];

const report = (health: ProjectStatusReport["health"]): ProjectStatusReport => ({
  health,
  runs: [
    {
      source: "github",
      id: 1,
      name: "Deploy",
      status: "completed",
      conclusion: "failure",
      event: "push",
      url: "https://github.com/run/1",
      commitMessage: null,
      createdAt: "",
    },
  ],
});

describe("deriveAlerts", () => {
  it("алерты только на error и warn; pending и unknown — не проблема", () => {
    const alerts = deriveAlerts(
      resources,
      report([
        { resourceId: "repo", state: "error", summary: "Deploy: failure" },
        { resourceId: "db", state: "warn", summary: "На паузе" },
        { resourceId: "site", state: "unknown", summary: "Не удалось проверить: таймаут" },
      ]),
    );
    expect(alerts.map((a) => a.key)).toEqual(["repo:error", "db:warn"]);
  });

  it("упавший деплой ведёт на лог запуска", () => {
    const [alert] = deriveAlerts(resources, report([{ resourceId: "repo", state: "error", summary: "Deploy: failure" }]));
    expect(alert.url).toBe("https://github.com/run/1");
    expect(alert.message).toBe("Репозиторий repo: Deploy: failure");
  });

  it("ключ не зависит от текста статуса — смена формулировки не создаёт новую проблему", () => {
    const a = deriveAlerts(resources, report([{ resourceId: "repo", state: "error", summary: "Deploy: failure" }]));
    const b = deriveAlerts(resources, report([{ resourceId: "repo", state: "error", summary: "Deploy: cancelled" }]));
    expect(a[0].key).toBe(b[0].key);
  });
});

describe("chunkMessages", () => {
  it("склеивает сообщения и режет по лимиту", () => {
    expect(chunkMessages(["a", "b"], 100)).toEqual(["a\n\nb"]);
    expect(chunkMessages(["x".repeat(60), "y".repeat(60)], 100)).toEqual(["x".repeat(60), "y".repeat(60)]);
  });
});

/** Хранилище алертов и событий в памяти — только то, что нужно reconcileAlerts. */
function memoryStore() {
  const alerts = new Map<string, ProjectAlert & { projectId: string }>();
  const events: { level: string; message: string }[] = [];
  const store = {
    listAlerts: async (projectId: string) => [...alerts.values()].filter((a) => a.projectId === projectId),
    openAlert: async (projectId: string, alert: Omit<ProjectAlert, "createdAt">) => {
      const id = `${projectId}/${alert.key}`;
      if (alerts.has(id)) return false;
      alerts.set(id, { ...alert, projectId, createdAt: 0 });
      return true;
    },
    resolveAlert: async (projectId: string, key: string) => alerts.delete(`${projectId}/${key}`),
    addEvent: async (_projectId: string, level: string, message: string) => void events.push({ level, message }),
  } as unknown as Store;
  return { store, events, keys: () => [...alerts.values()].map((a) => a.key) };
}

describe("reconcileAlerts", () => {
  const project: Project = { id: "p1", name: "App", recipeId: "r", params: {}, status: "ready", error: null, createdAt: 0 };
  const health = (state: HealthState, summary = "Deploy: failure") => report([{ resourceId: "repo", state, summary }]);

  it("error → unknown → error: алерт остаётся, повторных уведомлений нет", async () => {
    const { store, events, keys } = memoryStore();
    const first = await reconcileAlerts(store, project, resources, health("error"));
    expect(first).toMatchObject({ opened: 1, resolved: 0 });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain("Deploy: failure");

    const unknown = await reconcileAlerts(store, project, resources, health("unknown", "Не удалось проверить: таймаут"));
    expect(unknown).toEqual({ opened: 0, resolved: 0, messages: [] });
    expect(keys()).toEqual(["repo:error"]);

    const again = await reconcileAlerts(store, project, resources, health("error"));
    expect(again).toEqual({ opened: 0, resolved: 0, messages: [] });
    expect(keys()).toEqual(["repo:error"]);
    expect(events).toEqual([{ level: "error", message: "Проблема: Репозиторий repo: Deploy: failure" }]);
  });

  it("error → pending: алерт остаётся", async () => {
    const { store, events, keys } = memoryStore();
    await reconcileAlerts(store, project, resources, health("error"));
    const r = await reconcileAlerts(store, project, resources, health("pending", "Deploy: выполняется"));
    expect(r).toEqual({ opened: 0, resolved: 0, messages: [] });
    expect(keys()).toEqual(["repo:error"]);
    expect(events).toHaveLength(1);
  });

  it("нет результата проверки ресурса — алерт остаётся", async () => {
    const { store, events, keys } = memoryStore();
    await reconcileAlerts(store, project, resources, health("error"));
    const r = await reconcileAlerts(store, project, resources, report([]));
    expect(r).toEqual({ opened: 0, resolved: 0, messages: [] });
    expect(keys()).toEqual(["repo:error"]);
    expect(events).toHaveLength(1);
  });

  it("error → ok: закрывается ровно один раз", async () => {
    const { store, events, keys } = memoryStore();
    await reconcileAlerts(store, project, resources, health("error"));
    const fixed = await reconcileAlerts(store, project, resources, health("ok", "Deploy: success"));
    expect(fixed.resolved).toBe(1);
    expect(fixed.opened).toBe(0);
    expect(fixed.messages).toHaveLength(1);
    expect(fixed.messages[0]).toContain("Исправлено: Репозиторий repo: Deploy: failure");
    expect(keys()).toEqual([]);

    const again = await reconcileAlerts(store, project, resources, health("ok", "Deploy: success"));
    expect(again).toEqual({ opened: 0, resolved: 0, messages: [] });
    expect(events).toEqual([
      { level: "error", message: "Проблема: Репозиторий repo: Deploy: failure" },
      { level: "info", message: "Исправлено: Репозиторий repo: Deploy: failure" },
    ]);
  });

  it("warn ↔ error: старый алерт заменяется новым, без зависших", async () => {
    const { store, events, keys } = memoryStore();
    const dbHealth = (state: HealthState, summary: string) => report([{ resourceId: "db", state, summary }]);
    await reconcileAlerts(store, project, resources, dbHealth("warn", "На паузе"));
    expect(keys()).toEqual(["db:warn"]);

    const toError = await reconcileAlerts(store, project, resources, dbHealth("error", "Удалён"));
    expect(toError).toMatchObject({ opened: 1, resolved: 1 });
    expect(toError.messages).toHaveLength(2);
    expect(keys()).toEqual(["db:error"]);

    const toWarn = await reconcileAlerts(store, project, resources, dbHealth("warn", "На паузе"));
    expect(toWarn).toMatchObject({ opened: 1, resolved: 1 });
    expect(keys()).toEqual(["db:warn"]);
    expect(events.map((e) => e.message)).toEqual([
      "Проблема: База данных db: На паузе",
      "Проблема: База данных db: Удалён",
      "Исправлено: База данных db: На паузе",
      "Проблема: База данных db: На паузе",
      "Исправлено: База данных db: Удалён",
    ]);
  });

  it("ресурса больше нет в проекте — его алерт закрывается", async () => {
    const { store, events, keys } = memoryStore();
    await reconcileAlerts(store, project, resources, health("error"));
    const remaining = resources.filter((r) => r.id !== "repo");
    const r = await reconcileAlerts(store, project, remaining, report([]));
    expect(r).toMatchObject({ opened: 0, resolved: 1 });
    expect(r.messages).toHaveLength(1);
    expect(keys()).toEqual([]);
    expect(events).toHaveLength(2);
  });

  it("повторная сверка с тем же статусом не создаёт дублей", async () => {
    const { store, events, keys } = memoryStore();
    const both = report([
      { resourceId: "repo", state: "error", summary: "Deploy: failure" },
      { resourceId: "db", state: "warn", summary: "На паузе" },
    ]);
    const first = await reconcileAlerts(store, project, resources, both);
    expect(first.opened).toBe(2);
    for (let i = 0; i < 3; i++) {
      expect(await reconcileAlerts(store, project, resources, both)).toEqual({ opened: 0, resolved: 0, messages: [] });
    }
    expect(keys()).toEqual(["repo:error", "db:warn"]);
    expect(events).toHaveLength(2);
  });
});
