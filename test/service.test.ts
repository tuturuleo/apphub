import { describe, expect, it } from "vitest";
import type { Store } from "../src/worker/db";
import { updateProjectFiles } from "../src/worker/service";

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
