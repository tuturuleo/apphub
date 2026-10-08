// Клиент Telegram Bot API: проверка бота, поиск чата для уведомлений, отправка сообщений.
import { ProviderError } from "./errors";
import { providerFetch } from "./http";

interface Envelope<T> {
  ok: boolean;
  description?: string;
  result: T;
}

interface Chat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  username?: string;
}

export class Telegram {
  constructor(private token: string) {}

  private async call<T>(method: string, body?: unknown): Promise<T> {
    const res = await providerFetch("Telegram", `https://api.telegram.org/bot${this.token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !data?.ok) {
      // В URL лежит токен — в сообщение об ошибке его не выводим
      throw new ProviderError(`Telegram ${method}: ${res.status} ${data?.description ?? res.statusText}`, res.status);
    }
    return data.result;
  }

  async me(): Promise<{ username: string }> {
    return this.call("getMe");
  }

  /** Чат, из которого боту писали последним, — туда и отправляем уведомления. */
  async latestChat(): Promise<Chat | null> {
    const updates = await this.call<{ message?: { chat: Chat }; my_chat_member?: { chat: Chat } }[]>("getUpdates");
    for (let i = updates.length - 1; i >= 0; i--) {
      const chat = updates[i].message?.chat ?? updates[i].my_chat_member?.chat;
      if (chat) return chat;
    }
    return null;
  }

  async send(chatId: string, html: string): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const chatLabel = (chat: Chat) =>
  chat.title ?? (chat.username ? `@${chat.username}` : (chat.first_name ?? String(chat.id)));
