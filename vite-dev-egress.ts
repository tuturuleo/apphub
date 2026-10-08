// Только для `vite dev`: локальный workerd не умеет ходить через прокси, и из сети, где API провайдеров
// заблокированы (Telegram), его запросы виснут. Воркер шлёт их сюда, а отсюда они уходят через прокси
// из HTTPS_PROXY или системных настроек macOS (VPN-клиенты в режиме системного прокси: Hiddify и т. п.).
import { execFileSync } from "node:child_process";
import https from "node:https";
import type { Plugin } from "vite";

const EGRESS_PATH = "/__egress";

// Прокси определяется на каждый запрос: VPN можно включать и выключать, не перезапуская dev-сервер.
function currentProxy(): string | undefined {
  const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (fromEnv) return fromEnv;
  if (process.platform !== "darwin") return undefined;
  try {
    const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 2000 });
    const field = (name: string) => out.match(new RegExp(`\\b${name} : (\\S+)`))?.[1];
    if (field("HTTPSEnable") !== "1") return undefined;
    const host = field("HTTPSProxy");
    const port = field("HTTPSPort");
    return host && port ? `http://${host}:${port}` : undefined;
  } catch {
    return undefined;
  }
}

const agents = new Map<string, https.Agent>();
function agentFor(proxy: string | undefined): https.Agent {
  const key = proxy ?? "";
  let agent = agents.get(key);
  if (!agent) {
    const proxyEnv: Record<string, string | undefined> = proxy
      ? { HTTPS_PROXY: proxy, NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy }
      : {};
    agent = new https.Agent({ keepAlive: true, proxyEnv: proxyEnv as https.AgentOptions["proxyEnv"] });
    agents.set(key, agent);
  }
  return agent;
}

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

export function devEgress(): Plugin {
  return {
    name: "apphub:dev-egress",
    apply: "serve",
    // Адрес ретранслятора для воркера (src/worker/providers/http.ts); в сборку не попадает — плагин только для serve
    config: (config) => ({
      define: {
        "import.meta.env.VITE_EGRESS_RELAY": JSON.stringify(`http://localhost:${config.server?.port ?? 5173}${EGRESS_PATH}`),
      },
    }),
    configureServer(server) {
      // Регистрируется сразу, а не в post-хуке, — чтобы запрос не ушёл в воркер плагина Cloudflare
      server.middlewares.use(EGRESS_PATH, (req, res) => {
        const target = req.url?.slice(1) ?? "";
        if (!target.startsWith("https://")) {
          res.writeHead(400).end("egress: ожидается /__egress/https://...");
          return;
        }
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name) && !name.startsWith("cf-")),
        );
        const upstream = https.request(target, { method: req.method, headers, agent: agentFor(currentProxy()) }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        });
        upstream.on("error", (e) => {
          // В URL может быть токен (Telegram) — наружу отдаём только хост
          const reason = `egress ${new URL(target).host}: ${e.message}`;
          if (res.headersSent) res.destroy(e);
          else res.writeHead(502).end(reason);
        });
        // Воркер оборвал запрос (таймаут providerFetch) — обрываем и исходящий
        res.on("close", () => {
          if (!res.writableFinished) upstream.destroy();
        });
        req.pipe(upstream);
      });
    },
  };
}
