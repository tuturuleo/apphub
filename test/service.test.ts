import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectStatus } from "../src/shared/types";
import type { Store } from "../src/worker/db";
import { settleProvisioning, updateProjectFiles } from "../src/worker/service";

// Проверки входа срабатывают до обращения к базе и GitHub — store не должен понадобиться.
const store = {} as Store;

describe("updateProjectFiles: проверка входа", () => {
  it.each(["../secret", "/etc/passwd", ".git/config", "a//b", "src/./x", "dir/"])("отклоняет путь %s", async (path) => {
    await expect(updateProjectFiles(store, "p", { files: [{ path, content: "x" }] })).rejects.toThrow(
      /Недопустимый путь/,
    );
  });

  it("отклоняет пустой коммит и повтор пути", async () => {
    await expect(updateProjectFiles(store, "p", {})).rejects.toThrow(/Нет изменений/);
    await expect(
      updateProjectFiles(store, "p", { files: [{ path: "a.txt", content: "1" }], remove: ["a.txt"] }),
    ).rejects.toThrow(/дважды/);
  });

  it("отклоняет слишком большой файл", async () => {
    const big = "x".repeat(600 * 1024);
    await expect(updateProjectFiles(store, "p", { files: [{ path: "big.txt", content: big }] })).rejects.toThrow(
      /больше 512 КБ/,
    );
  });
});

const NOW = 1_000_000_000;
const TEN_MINUTES = 10 * 60_000;

interface FakeOptions {
  workflowId?: string | null;
  /** Что вернёт PROVISION.get: статус, исключение в get или исключение в status(). */
  workflow?: { status: string } | { getThrows: true } | { statusThrows: true };
  lastEventAt?: number | null;
  /** Статус проекта при повторном чтении (процесс мог успеть записать итог). */
  freshStatus?: ProjectStatus;
}

function fakeStore(opts: FakeOptions) {
  const project: Project = {
    id: "p",
    name: "p",
    recipeId: "x",
    params: {},
    status: "provisioning",
    error: null,
    createdAt: NOW - TEN_MINUTES * 3,
  };
  const calls = { events: [] as string[], statuses: [] as string[], getProject: 0 };
  const provision = {
    get: vi.fn(async () => {
      const w = opts.workflow;
      if (w && "getThrows" in w) throw new Error("get failed");
      return {
        status: async () => {
          if (w && "statusThrows" in w) throw new Error("status failed");
          return { status: w && "status" in w ? w.status : "running" };
        },
      };
    }),
  };
  const store = {
    env: { PROVISION: provision },
    getWorkflowId: async () => (opts.workflowId === undefined ? "wf" : opts.workflowId),
    lastEventAt: async () => opts.lastEventAt ?? null,
    getProject: async () => {
      calls.getProject++;
      return { ...project, status: opts.freshStatus ?? project.status };
    },
    addEvent: async (_id: string, level: string, message: string) => void calls.events.push(`${level}: ${message}`),
    setProjectStatus: async (_id: string, status: ProjectStatus) => {
      calls.statuses.push(status);
      project.status = status;
    },
  } as unknown as Store;
  return { store, project, calls, provision };
}

describe("settleProvisioning", () => {
  afterEach(() => void vi.useRealTimers());

  it("не трогает проект не в статусе provisioning", async () => {
    const { store, project, calls, provision } = fakeStore({ workflow: { status: "errored" } });
    project.status = "ready";
    expect(await settleProvisioning(store, project)).toBe(project);
    expect(provision.get).not.toHaveBeenCalled();
    expect(calls.statuses).toEqual([]);
  });

  it.each([
    ["get", { getThrows: true } as const],
    ["status", { statusThrows: true } as const],
  ])("исключение в %s оставляет provisioning без события о прерывании", async (_name, workflow) => {
    const { store, project, calls } = fakeStore({ workflow });
    const result = await settleProvisioning(store, project);
    expect(result.status).toBe("provisioning");
    expect(calls.events).toEqual([]);
    expect(calls.statuses).toEqual([]);
  });

  it.each(["queued", "running", "paused", "waiting"])("рабочий статус %s оставляет provisioning", async (status) => {
    const { store, project, calls } = fakeStore({ workflow: { status } });
    expect((await settleProvisioning(store, project)).status).toBe("provisioning");
    expect(calls.events).toEqual([]);
    expect(calls.statuses).toEqual([]);
  });

  it.each(["errored", "terminated", "complete", "unknown"])("конечный статус %s переводит в failed", async (status) => {
    const { store, project, calls } = fakeStore({ workflow: { status } });
    const result = await settleProvisioning(store, project);
    expect(result.status).toBe("failed");
    expect(calls.statuses).toEqual(["failed"]);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]).toMatch(new RegExp(`^error: Создание прервалось: .*${status}`));
  });

  it("не пишет failed, если проект уже стал ready при повторном чтении", async () => {
    const { store, project, calls } = fakeStore({ workflow: { status: "complete" }, freshStatus: "ready" });
    const result = await settleProvisioning(store, project);
    expect(result.status).toBe("ready");
    expect(calls.getProject).toBe(1);
    expect(calls.events).toEqual([]);
    expect(calls.statuses).toEqual([]);
  });

  describe("проект без workflow", () => {
    it("ровно 10 минут без движения — ещё не прерван", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { store, project, calls, provision } = fakeStore({ workflowId: null, lastEventAt: NOW - TEN_MINUTES });
      expect((await settleProvisioning(store, project)).status).toBe("provisioning");
      expect(provision.get).not.toHaveBeenCalled();
      expect(calls.statuses).toEqual([]);
      expect(calls.events).toEqual([]);
    });

    it("больше 10 минут без движения — failed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { store, project, calls } = fakeStore({ workflowId: null, lastEventAt: NOW - TEN_MINUTES - 1 });
      expect((await settleProvisioning(store, project)).status).toBe("failed");
      expect(calls.statuses).toEqual(["failed"]);
      expect(calls.events).toEqual([expect.stringMatching(/нет движения больше 10 минут/)]);
    });

    it("без событий отсчитывает от создания проекта", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { store, project, calls } = fakeStore({ workflowId: null });
      project.createdAt = NOW - TEN_MINUTES;
      expect((await settleProvisioning(store, project)).status).toBe("provisioning");
      project.createdAt = NOW - TEN_MINUTES - 1;
      expect((await settleProvisioning(store, project)).status).toBe("failed");
      expect(calls.statuses).toEqual(["failed"]);
    });

    it("не пишет failed, если проект уже стал ready при повторном чтении", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { store, project, calls } = fakeStore({ workflowId: null, lastEventAt: 0, freshStatus: "ready" });
      expect((await settleProvisioning(store, project)).status).toBe("ready");
      expect(calls.events).toEqual([]);
      expect(calls.statuses).toEqual([]);
    });
  });
});
