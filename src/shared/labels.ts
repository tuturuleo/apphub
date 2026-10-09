import type { ResourceKind, ResourceOrigin } from "./types";

export const KIND_LABEL: Record<ResourceKind, string> = {
  repo: "Репозиторий",
  site: "Сайт",
  service: "Сервер",
  database: "База данных",
  data: "Данные",
  bot: "Telegram-бот",
  llm: "Модель LLM",
};

export const ORIGIN_LABEL: Record<ResourceOrigin, string> = {
  created: "создан apphub",
  imported: "импортирован",
  external: "внешний",
};
