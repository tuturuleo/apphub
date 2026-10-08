// Каталог провайдеров: инструкции по получению токена и проверка подключения.
import type { Connection, ProviderId, ProviderInfo } from "../../shared/types";
import { Cloudflare } from "./cloudflare";
import { GitHub } from "./github";

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "github",
    name: "GitHub",
    summary: "Репозитории, сборка в Actions, статика на Pages",
    tokenUrl: "https://github.com/settings/personal-access-tokens/new",
    steps: [
      "Создайте fine-grained token, Repository access: All repositories (иначе apphub не увидит новые репо).",
      "Repository permissions → Read and write: Administration, Contents, Workflows, Secrets, Actions, Pages.",
      "Metadata: Read-only (включается автоматически).",
      "Альтернатива: classic token со scope repo и workflow.",
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    summary: "Workers (сервер на JS/TS), D1 (SQLite), R2, KV, cron",
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
    steps: [
      "Create Token → шаблон «Edit Cloudflare Workers».",
      "Добавьте строку Account → D1 → Edit.",
      "Account Resources: ваш аккаунт. Сохраните и скопируйте токен.",
      "Этот же токен кладётся в секреты репозиториев для деплоя из Actions — не давайте ему лишних прав.",
    ],
  },
];

export function isProviderId(id: string): id is ProviderId {
  return PROVIDERS.some((p) => p.id === id);
}

/** Проверяет токен и собирает данные аккаунта для сохранения. */
export async function verifyConnection(
  provider: ProviderId,
  token: string,
): Promise<Omit<Connection, "createdAt">> {
  switch (provider) {
    case "github": {
      const user = await new GitHub(token).viewer();
      return { provider, label: user.login, accountId: user.login, meta: { url: user.html_url } };
    }
    case "cloudflare": {
      const accounts = await new Cloudflare(token).listAccounts();
      if (accounts.length === 0) throw new Error("Токену не доступен ни один аккаунт Cloudflare");
      if (accounts.length > 1) {
        throw new Error(
          `Токену доступно несколько аккаунтов (${accounts.map((a) => a.name).join(", ")}). Ограничьте токен одним аккаунтом.`,
        );
      }
      const account = accounts[0];
      const subdomain = await new Cloudflare(token, account.id).workersSubdomain();
      if (!subdomain) {
        throw new Error(
          "У аккаунта не настроен поддомен workers.dev. Откройте Workers & Pages в панели Cloudflare — он создастся при первом заходе.",
        );
      }
      return { provider, label: account.name, accountId: account.id, meta: { subdomain } };
    }
  }
}
