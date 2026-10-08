// Каталог провайдеров: инструкции по получению токена и проверка подключения.
import type { Connection, ProviderId, ProviderInfo } from "../../shared/types";
import { Cloudflare } from "./cloudflare";
import { GitHub } from "./github";
import { Supabase } from "./supabase";
import { Telegram, chatLabel } from "./telegram";

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "github",
    name: "GitHub",
    summary: "Репозитории, сборка в Actions, статика на Pages",
    tokenUrl: "https://github.com/settings/personal-access-tokens/new",
    tokenLinkLabel: "страницу токенов GitHub",
    steps: [
      "Задайте имя токена, например apphub, и срок действия.",
      "Repository access: All repositories — иначе apphub не сможет работать с репозиториями, которые создаст.",
      {
        text: "Permissions → Repositories → Add permissions. Выставьте права, остальные оставьте No access:",
        permissions: [
          {
            section: "Repository permissions",
            items: [
              { name: "Actions", level: "Read and write" },
              { name: "Administration", level: "Read and write" },
              { name: "Contents", level: "Read and write" },
              { name: "Metadata", level: "Read-only" },
              { name: "Pages", level: "Read and write" },
              { name: "Secrets", level: "Read and write" },
              { name: "Workflows", level: "Read and write" },
            ],
          },
        ],
      },
      "Generate token и вставьте его сюда.",
    ],
    notes: [
      "Metadata: Read-only GitHub добавляет сам, как только выбрано любое другое право.",
      "Альтернатива: classic token со scope repo и workflow.",
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    summary: "Workers (сервер на JS/TS), D1 (SQLite), R2, KV, cron",
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
    tokenLinkLabel: "страницу токенов Cloudflare",
    steps: [
      "Create Token → шаблон «Edit Cloudflare Workers» → Use template.",
      {
        text: "Permissions: строки из шаблона не трогайте, нажмите «+ Add more» и заполните новую строку:",
        permissions: [{ section: "Новая строка", items: [{ name: "Account · D1", level: "Edit" }] }],
      },
      "Account Resources: Include → ваш аккаунт. Zone Resources оставьте как есть.",
      "Continue to summary → Create Token и вставьте токен сюда.",
    ],
    notes: [
      "Без права на D1 токен подключится, но рецепт с базой упадёт при её создании.",
      "Этот токен кладётся в секреты созданных репозиториев для деплоя из Actions — не давайте ему лишних прав.",
    ],
  },
  {
    id: "supabase",
    name: "Supabase",
    summary: "Postgres, авторизация и готовый API — часто без своего сервера",
    tokenUrl: "https://supabase.com/dashboard/account/tokens",
    tokenLinkLabel: "страницу токенов Supabase",
    steps: [
      "Если организации ещё нет, сначала создайте её: supabase.com/dashboard/new → Type: Personal, Plan: Free. Проект создавать не нужно — это сделает apphub.",
      "Generate new token, имя — например, apphub.",
      "Доступ: организация целиком, а не отдельный проект — иначе apphub не увидит проекты, которые создаст.",
      {
        text: "Permissions: раскройте разделы и выставьте права, остальное оставьте None:",
        permissions: [
          { section: "Project", items: [{ name: "Project Settings", level: "Read-write" }] },
          { section: "Database", items: [{ name: "Connection Pooling", level: "Read" }] },
          {
            section: "Application services",
            items: [
              { name: "API Keys", level: "Read" },
              { name: "API Key Secrets", level: "Read" },
              { name: "Auth Config", level: "Read-write" },
            ],
          },
          {
            section: "Account and organization",
            items: [
              { name: "Organizations", level: "Read" },
              { name: "Organization Projects", level: "Read-write" },
            ],
          },
        ],
      },
      "Создайте токен и вставьте его сюда.",
    ],
    notes: [
      "Раздел Infrastructure and delivery не нужен.",
      "Токен остаётся только в apphub: в репозитории уходит строка подключения к конкретной базе, а не он.",
      "На бесплатном тарифе — до 2 активных проектов в организации.",
    ],
  },
  {
    id: "telegram",
    name: "Telegram",
    summary: "Уведомления о проблемах в проектах: упал деплой, уснула база, отключено расписание",
    tokenUrl: "https://t.me/BotFather",
    tokenLinkLabel: "@BotFather в Telegram",
    steps: [
      "Отправьте /newbot, задайте имя и username бота — BotFather пришлёт токен.",
      "Откройте своего бота и отправьте ему любое сообщение, например /start — так apphub узнает, куда писать.",
      "Вставьте токен сюда. В чат придёт тестовое сообщение.",
    ],
    notes: [
      "Чтобы слать уведомления в группу, добавьте бота в группу и напишите там сообщение перед подключением.",
      "Проверка идёт по расписанию раз в 10 минут, когда apphub задеплоен. Локально — кнопкой «Проверить сейчас».",
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
    case "supabase": {
      const orgs = await new Supabase(token).organizations();
      const org = orgs[0];
      if (!org) throw new Error("В аккаунте Supabase нет ни одной организации — создайте её в панели Supabase");
      return { provider, label: org.name, accountId: org.slug, meta: {} };
    }
    case "telegram": {
      const bot = new Telegram(token);
      const me = await bot.me();
      const chat = await bot.latestChat();
      if (!chat) {
        throw new Error(`Напишите боту @${me.username} любое сообщение и нажмите «Подключить» ещё раз`);
      }
      const chatId = String(chat.id);
      await bot.send(chatId, `✅ <b>apphub</b> подключён. Сюда будут приходить уведомления о проблемах в проектах.`);
      return {
        provider,
        label: `@${me.username} → ${chatLabel(chat)}`,
        accountId: chatId,
        meta: { bot: me.username },
      };
    }
  }
}
