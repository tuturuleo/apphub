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
    // бинарник из образа с file capability Render не запускает — работает копия
    expect(cmd).toMatch(/^sh -c 'cp \/usr\/bin\/caddy \/tmp\/caddy && exec \/tmp\/caddy reverse-proxy /);
    expect(cmd.endsWith("'")).toBe(true);
  });
});
