import { describe, expect, it } from "vitest";
import type { Resource } from "../src/shared/types";
import { deletionOrder } from "../src/worker/engine";

const r = (type: Resource["type"]): Resource => ({
  id: type,
  connectionId: "conn-1",
  type,
  kind: "repo",
  name: type,
  externalId: type,
  url: null,
  consoleUrl: null,
  meta: {},
  origin: "created",
  createdAt: 0,
});

describe("deletionOrder", () => {
  it("сначала сервисы, потом базы, репозиторий последним", () => {
    const order = deletionOrder([
      r("github.repo"),
      r("supabase.project"),
      r("github.pages"),
      r("render.service"),
      r("cloudflare.d1"),
      r("cloudflare.worker"),
    ]).map((x) => x.type);
    expect(order).toEqual([
      "render.service",
      "cloudflare.worker",
      "github.pages",
      "cloudflare.d1",
      "supabase.project",
      "github.repo",
    ]);
  });
});
