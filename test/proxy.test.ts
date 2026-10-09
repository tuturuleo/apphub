import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PROXY_COMMAND, PROXY_ENV, caddyScript } from "../src/worker/proxy";

describe("прокси на Render", () => {
  it("Caddy шлёт на Worker с его Host, секретом и исходным адресом", () => {
    const script = caddyScript("https://apphub.example.workers.dev", "s3cret");
    expect(script).toMatch(/^cp \/usr\/bin\/caddy \/tmp\/caddy && exec \/tmp\/caddy reverse-proxy /);
    expect(script).toContain("--from :10000");
    expect(script).toContain("--to https://apphub.example.workers.dev");
    expect(script).toContain("--change-host-header");
    expect(script).toContain("--header-up X-Apphub-Proxy:s3cret");
    expect(script).toContain("--header-up X-Apphub-Host:{host}");
  });

  it("команда запуска без пробелов и кавычек-обёрток, sh разворачивает скрипт из переменной", () => {
    const [shell, flag, arg, ...rest] = PROXY_COMMAND.split(" ");
    expect([shell, flag, rest.length]).toEqual(["sh", "-c", 0]);
    // как это выполнит sh в контейнере: echo вместо cp/caddy
    const out = execFileSync("sh", ["-c", arg], {
      env: { ...process.env, [PROXY_ENV]: "echo one && echo two {host} --to x" },
    }).toString();
    expect(out).toBe("one\ntwo {host} --to x\n");
  });
});
