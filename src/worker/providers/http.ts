// fetch к API провайдеров с таймаутом. Чтения повторяются: если у хоста несколько адресов и один
// недоступен из текущей сети, соединение может зависнуть, а повтор обычно попадает на рабочий адрес.
import { ProviderError } from "./errors";

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
const READ_ATTEMPTS = 3;
// Только в `vite dev`: ретранслятор в Node, который ходит через прокси (см. vite-dev-egress.ts)
const EGRESS_RELAY: string | undefined = import.meta.env.VITE_EGRESS_RELAY;

export async function providerFetch(provider: string, url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const isRead = method === "GET" || method === "HEAD";
  const attempts = isRead ? READ_ATTEMPTS : 1;
  const timeout = isRead ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      const target = EGRESS_RELAY ? `${EGRESS_RELAY}/${url}` : url;
      return await fetch(target, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      if (attempt < attempts) continue;
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      const reason = timedOut ? `нет ответа за ${timeout / 1000} с` : e instanceof Error ? e.message : String(e);
      throw new ProviderError(`${provider} ${method} ${new URL(url).pathname}: ${reason}`, 504);
    }
  }
}
