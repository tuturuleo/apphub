import { describe, expect, it } from "vitest";
import type { LimitItem } from "../src/shared/types";
import type { Store } from "../src/worker/db";
import { describeLimit, formatAmount, limitTransitions } from "../src/worker/limits";

const limit = (state: LimitItem["state"], used: number | null = 1): LimitItem => ({
  key: "supabase.projects",
  provider: "supabase",
  label: "Supabase: активные проекты",
  used,
  limit: 2,
  unit: "",
  state,
  note: null,
  holders: ["sb-check", "py-check"],
  consoleUrl: null,
});

function memoryStore() {
  const meta = new Map<string, string>();
  return {
    getMeta: async (k: string) => meta.get(k) ?? null,
    setMeta: async (k: string, v: string) => void meta.set(k, v),
  } as unknown as Store;
}

describe("лимиты", () => {
  it("форматирует объёмы", () => {
    expect(formatAmount(5 * 1024 ** 3, "bytes")).toBe("5.0 ГБ");
    expect(formatAmount(28 * 1024 ** 2, "bytes")).toBe("28 МБ");
    expect(formatAmount(69632, "bytes")).toBe("68 КБ");
    expect(formatAmount(750, "hours")).toBe("750 ч");
  });

  it("описание называет, кто занимает лимит", () => {
    expect(describeLimit(limit("full", 2))).toBe("Supabase: активные проекты: 2 из 2 (sb-check, py-check)");
  });

  it("пишет только о переходах: исчерпан → без повторов → снова есть запас", async () => {
    const store = memoryStore();
    expect(await limitTransitions(store, [limit("full", 2)])).toHaveLength(1);
    expect(await limitTransitions(store, [limit("full", 2)])).toHaveLength(0);
    const back = await limitTransitions(store, [limit("ok", 1)]);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatch(/снова есть запас/);
    // «ok» с самого начала — не повод для сообщения, info — тоже
    expect(await limitTransitions(memoryStore(), [limit("ok"), limit("info", null)])).toHaveLength(0);
  });
});
