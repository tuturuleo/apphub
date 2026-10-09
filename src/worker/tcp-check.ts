// Проверка TCP-доступности сервера из Worker (cloudflare:sockets). Импортируется динамически:
// модуля cloudflare:sockets нет вне рантайма Workers (например, в тестах).
import { connect } from "cloudflare:sockets";

export async function checkTcp(hostname: string, port: number, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
  const socket = connect({ hostname, port });
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`нет ответа за ${timeoutMs / 1000} с`)), timeoutMs)),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    socket.close().catch(() => {});
  }
}
