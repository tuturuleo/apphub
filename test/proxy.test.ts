import { describe, expect, it } from "vitest";
import { caddyCommand } from "../src/worker/proxy";

describe("прокси на Render", () => {
  it("Caddy шлёт на Worker с его Host, секретом и исходным адресом", () => {
    const cmd = caddyCommand("https://apphub.example.workers.dev", "s3cret");
    expect(cmd).toContain("--from :10000");
    expect(cmd).toContain("--to https://apphub.example.workers.dev");
    expect(cmd).toContain("--change-host-header");
    expect(cmd).toContain("--header-up X-Apphub-Proxy:s3cret");
    expect(cmd).toContain("--header-up X-Apphub-Host:{host}");
    // аргументы без пробелов внутри — Render разбивает команду по пробелам
    expect(cmd.split(" ").filter((a) => a.startsWith("X-Apphub")).length).toBe(2);
  });
});
