import { describe, expect, it } from "vitest";
import type { ProjectStatusReport, Resource } from "../src/shared/types";
import { chunkMessages, deriveAlerts } from "../src/worker/monitor";

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
