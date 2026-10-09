import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundResource } from "../src/shared/types";
import type { Store } from "../src/worker/db";

// У провайдера ничего не удаляем по-настоящему — только записываем, что удалили бы
const deletedAtProvider: string[] = [];
vi.mock("../src/worker/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/worker/engine")>()),
  deleteAtProvider: vi.fn(async (_store: Store, r: BoundResource) => void deletedAtProvider.push(r.name)),
}));

const { destroyProject } = await import("../src/worker/service");

const resource = (name: string, origin: BoundResource["origin"], type: BoundResource["type"]): BoundResource => ({
  id: name,
  connectionId: "conn",
  type,
  kind: "database",
  name,
  externalId: name,
  url: null,
  consoleUrl: null,
  meta: {},
  origin,
  createdAt: 0,
  role: "database",
  binding: {},
});

function fakeStore(bindings: Record<string, number>, selfId: string | null = null) {
  const calls = { unbound: [] as string[], removed: [] as string[], projectDeleted: false };
  const store = {
    getProject: async () => ({ id: "p", name: "p", recipeId: "x", params: {}, status: "ready", error: null, createdAt: 0 }),
    listResources: async () => [
      resource("own-repo", "created", "github.repo"),
      resource("shared-db", "created", "supabase.project"),
      resource("imported-db", "imported", "cloudflare.d1"),
      resource("my-postgres", "external", "postgres.external"),
    ],
    bindingCount: async (id: string) => bindings[id] ?? 1,
    unbindResource: async (_p: string, id: string) => void calls.unbound.push(id),
    deleteResource: async (id: string) => void calls.removed.push(id),
    addEvent: async () => {},
    getMeta: async (key: string) => (key === "self.project" ? selfId : null),
    setProjectStatus: async () => {},
    deleteProject: async () => void (calls.projectDeleted = true),
  } as unknown as Store;
  return { store, calls };
}

describe("destroyProject", () => {
  beforeEach(() => void (deletedAtProvider.length = 0));

  it("сам apphub удалить из него нельзя", async () => {
    const { store, calls } = fakeStore({}, "p");
    await expect(destroyProject(store, "p")).rejects.toThrow(/сам apphub/);
    expect(deletedAtProvider).toEqual([]);
    expect(calls.projectDeleted).toBe(false);
  });

  it("удаляет у провайдера только созданное apphub и больше никому не нужное", async () => {
    const { store, calls } = fakeStore({ "shared-db": 2 });
    const result = await destroyProject(store, "p");

    expect(deletedAtProvider).toEqual(["own-repo"]);
    expect(result.deleted).toEqual(["own-repo"]);
    // общая база, импортированный и внешний ресурсы — только отвязаны
    expect(result.detached.sort()).toEqual(["imported-db", "my-postgres", "shared-db"]);
    expect(calls.unbound.sort()).toEqual(["imported-db", "my-postgres", "shared-db"]);
    expect(calls.removed).toEqual(["own-repo"]);
    expect(result.projectRemoved).toBe(true);
    expect(calls.projectDeleted).toBe(true);
  });
});
