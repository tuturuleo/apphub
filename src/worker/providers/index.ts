// Каталог провайдеров: инструкции по получению токена и проверка подключения.
import type { Connection, ProviderId, ProviderInfo } from "../../shared/types";
import { Cloudflare } from "./cloudflare";
import { GitHub } from "./github";
import Anthropic from "@anthropic-ai/sdk";
import { relayFetch } from "./http";
import { GoogleDrive } from "./google";
import { Render } from "./render";
import { Supabase } from "./supabase";
import { Telegram, chatLabel } from "./telegram";
import { verifyLlmKey } from "../llm";

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "github",
    multiAccount: true,
    name: "GitHub",
    summary: "Репозитории, сборка в Actions, статика на Pages",
    tokenUrl: "https://github.com/settings/personal-access-tokens/new",
    tokenLinkLabel: "страницу токенов GitHub",
    steps: [
      "Задайте имя токена, например AppHub, и срок действия.",
      "Repository access: All repositories — иначе AppHub не сможет работать с репозиториями, которые создаст.",
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
    multiAccount: true,
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
    multiAccount: true,
    name: "Supabase",
    summary: "Postgres, авторизация и готовый API — часто без своего сервера",
    tokenUrl: "https://supabase.com/dashboard/account/tokens",
    tokenLinkLabel: "страницу токенов Supabase",
    steps: [
      "Если организации ещё нет, сначала создайте её: supabase.com/dashboard/new → Type: Personal, Plan: Free. Проект создавать не нужно — это сделает apphub.",
      "Generate new token, имя — например, apphub.",
      "Доступ: организация целиком, а не отдельный проект — иначе AppHub не увидит проекты, которые создаст.",
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
    id: "render",
    multiAccount: true,
    name: "Render",
    summary: "Docker-сервисы на любом языке: Python, Go, Java… Бесплатный инстанс засыпает без запросов",
    tokenUrl: "https://dashboard.render.com/u/settings#api-keys",
    tokenLinkLabel: "настройки аккаунта Render",
    steps: [
      "Account Settings → Account Security → Git Deployment Credentials → Add credential → GitHub, авторизуйте свой аккаунт и дайте доступ ко всем репозиториям (All repositories). Вход через GitHub (Login Methods) для этого не годится — Render не увидит репозитории.",
      "Account Settings → API Keys → Create API Key, скопируйте ключ сюда.",
    ],
    notes: [
      "Ограничить права ключа Render нельзя — он даёт полный доступ к аккаунту и хранится только в AppHub, в репозитории не попадает.",
      "Бесплатный сервис: 512 МБ памяти, засыпает через 15 минут без запросов и просыпается около минуты, 750 часов в месяц на аккаунт.",
    ],
  },
  {
    id: "google",
    multiAccount: true,
    name: "Google Drive",
    summary: "Приватные Google-таблицы как источник данных для сайтов — без публикации в интернете",
    tokenUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    tokenLinkLabel: "сервисные аккаунты в Google Cloud",
    secretMultiline: true,
    steps: [
      "Выберите или создайте проект Google Cloud (вверху страницы).",
      "APIs & Services → Library → Google Drive API → Enable.",
      "IAM & Admin → Service Accounts → Create service account, имя — например, apphub. Роли не нужны.",
      "Откройте аккаунт → Keys → Add key → Create new key → JSON. Скачается файл — вставьте его содержимое сюда целиком.",
      "Поделитесь нужными таблицами (или папкой) с почтой аккаунта — она вида apphub@…iam.gserviceaccount.com, права «Читатель».",
    ],
    notes: [
      "Аккаунт видит только то, чем с ним поделились. Его ключ кладётся в секреты репозиториев сайтов, которые читают приватные таблицы.",
      "Если Google не даёт создать ключ (политика организации iam.disableServiceAccountKeyCreation) — используйте личный аккаунт Google, а не рабочий.",
    ],
  },
  {
    id: "anthropic",
    multiAccount: false,
    name: "Claude API",
    summary: "Ассистент в интерфейсе apphub: создаёт и чинит проекты по описанию задачи",
    tokenUrl: "https://platform.claude.com/settings/keys",
    tokenLinkLabel: "страницу API-ключей Claude",
    steps: ["Create Key, задайте имя — например, AppHub — и скопируйте ключ сюда."],
    notes: [
      "Нужен ключ Claude API с оплатой по токенам — подписка Claude Pro/Max его не даёт. Без ключа AppHub доступен из Claude Code через MCP.",
      "Модель — Claude Opus 5.5. Ключ хранится только в apphub.",
    ],
  },
  {
    id: "groq",
    group: "llm",
    multiAccount: true,
    name: "Groq",
    summary: "Бесплатные LLM: gpt-oss-120b, Qwen — около 1000 запросов в день на модель, очень быстро",
    tokenUrl: "https://console.groq.com/keys",
    tokenLinkLabel: "страницу ключей Groq",
    steps: ["Войдите (карта не нужна), Create API Key, задайте имя — например, AppHub — и вставьте ключ сюда."],
    notes: [
      "Модели аккаунта появятся в «Ресурсах» → «Найти в аккаунте». Их можно выбрать в ассистенте и передать в проекты.",
    ],
  },
  {
    id: "openrouter",
    group: "llm",
    multiAccount: true,
    name: "OpenRouter",
    summary: "Много моделей через один ключ; бесплатные (:free) — около 50 запросов в день",
    tokenUrl: "https://openrouter.ai/settings/keys",
    tokenLinkLabel: "страницу ключей OpenRouter",
    steps: ["Войдите, Create Key, задайте имя — например, AppHub — и вставьте ключ сюда."],
    notes: ["AppHub показывает только бесплатные модели. Бесплатные провайдеры OpenRouter могут сохранять запросы."],
  },
  {
    id: "mistral",
    group: "llm",
    multiAccount: true,
    name: "Mistral",
    summary: "Модели Mistral: бесплатный план с ежемесячными кредитами",
    tokenUrl: "https://console.mistral.ai/api-keys",
    tokenLinkLabel: "страницу ключей Mistral",
    steps: [
      "Выберите бесплатный план (Experiment / Free), если ещё не выбран.",
      "Create new key, задайте имя — например, AppHub — и вставьте ключ сюда.",
    ],
    notes: ["На бесплатном плане запросы могут использоваться для обучения — это отключается в настройках Mistral."],
  },
  {
    id: "nvidia",
    group: "llm",
    multiAccount: true,
    name: "NVIDIA",
    summary: "Модели NVIDIA NIM: gpt-oss, Nemotron — бесплатно для участников NVIDIA Developer Program",
    tokenUrl: "https://build.nvidia.com/settings/api-keys",
    tokenLinkLabel: "страницу ключей NVIDIA",
    steps: ["Войдите в NVIDIA Developer Program, Generate API Key и вставьте ключ сюда."],
    notes: ["При подключении AppHub отправит один короткий запрос к модели, чтобы проверить ключ."],
  },
  {
    id: "openai_compat",
    group: "llm",
    multiAccount: true,
    name: "Другой OpenAI-совместимый",
    summary: "Любой сервис с OpenAI-совместимым API: свой сервер, прокси, другой провайдер",
    tokenUrl: "https://platform.openai.com/docs/api-reference/chat",
    tokenLinkLabel: "описание формата OpenAI API",
    secretMultiline: true,
    steps: [
      "Первая строка — адрес API (https, обычно оканчивается на /v1), вторая — ключ.",
      "AppHub проверит ключ запросом списка моделей.",
    ],
    notes: ["Например: https://api.example.com/v1 на первой строке и ключ sk-… на второй."],
  },
  {
    id: "telegram",
    multiAccount: false,
    name: "Telegram",
    summary: "Уведомления о проблемах в проектах: упал деплой, уснула база, отключено расписание",
    tokenUrl: "https://t.me/BotFather",
    tokenLinkLabel: "@BotFather в Telegram",
    steps: [
      "Отправьте /newbot, задайте имя и username бота — BotFather пришлёт токен.",
      "Откройте своего бота и отправьте ему любое сообщение, например /start — так AppHub узнает, куда писать.",
      "Вставьте токен сюда. В чат придёт тестовое сообщение.",
    ],
    notes: [
      "Чтобы слать уведомления в группу, добавьте бота в группу и напишите там сообщение перед подключением.",
      "Проверка идёт по расписанию раз в 10 минут, когда AppHub задеплоен. Локально — кнопкой «Проверить сейчас».",
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
): Promise<Omit<Connection, "id" | "createdAt">> {
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
    case "render": {
      const owners = await new Render(token).owners();
      if (owners.length === 0) throw new Error("Ключу Render не доступно ни одно рабочее пространство");
      if (owners.length > 1) {
        throw new Error(
          `Ключу доступно несколько рабочих пространств (${owners.map((o) => o.name).join(", ")}) — AppHub пока работает с одним.`,
        );
      }
      return { provider, label: owners[0].name, accountId: owners[0].id, meta: {} };
    }
    case "google": {
      const drive = new GoogleDrive(token);
      const sheets = await drive.listSpreadsheets();
      return {
        provider,
        label: drive.email,
        accountId: drive.email,
        meta: { sheets: String(sheets.length) },
      };
    }
    case "anthropic": {
      const model = await new Anthropic({ apiKey: token, fetch: relayFetch, maxRetries: 1 }).models.retrieve(
        "claude-opus-5-5",
      );
      return { provider, label: `доступна ${model.display_name}`, accountId: "anthropic", meta: {} };
    }
    case "groq":
    case "openrouter":
    case "mistral":
    case "nvidia":
    case "openai_compat":
      return verifyLlmKey(provider, token);
    case "telegram": {
      const bot = new Telegram(token);
      const me = await bot.me();
      const chat = await bot.latestChat();
      if (!chat) {
        throw new Error(`Напишите боту @${me.username} любое сообщение и нажмите «Подключить» ещё раз`);
      }
      const chatId = String(chat.id);
      await bot.send(chatId, `✅ <b>AppHub</b> подключён. Сюда будут приходить уведомления о проблемах в проектах.`);
      return {
        provider,
        label: `@${me.username} → ${chatLabel(chat)}`,
        accountId: chatId,
        meta: { bot: me.username },
      };
    }
  }
}
