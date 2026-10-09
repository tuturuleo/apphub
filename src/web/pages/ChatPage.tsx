import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ChatBlock, ChatMessage } from "../../shared/types";
import { api } from "../api";
import { ErrorNote, Loading } from "../components";
import { errorMessage, useConnections } from "../queries";
import { href } from "../router";

const STORAGE_KEY = "apphub.chat";

const TOOL_LABEL: Record<string, string> = {
  list_recipes: "смотрю рецепты",
  list_connections: "смотрю подключения",
  list_projects: "смотрю проекты",
  get_project: "проверяю проект",
  create_project: "создаю проект",
  get_project_files: "читаю код",
  update_project_files: "коммичу код",
  check_projects: "проверяю все проекты",
  deploy_project: "запускаю деплой",
  wake_resource: "действие над ресурсом",
};

// Переписка переживает переходы между страницами, но не закрытие вкладки
function loadHistory(): ChatMessage[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as ChatMessage[];
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // хранилище недоступно — переписка просто не сохранится
  }
}

const blocks = (m: ChatMessage): ChatBlock[] =>
  typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;

const URL_RE = /(https?:\/\/[^\s)]+)/g;

function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function toolSubject(input: Record<string, unknown>): string {
  const value = input.project ?? input.name ?? input.recipe;
  return typeof value === "string" ? ` · ${value}` : "";
}

/** Сообщение пользователя из одних результатов инструментов — служебное, его не показываем. */
const isToolResults = (m: ChatMessage) => m.role === "user" && blocks(m).every((b) => b.type === "tool_result");

export function ChatPage() {
  const connections = useConnections();
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const send = useMutation({
    mutationFn: (history: ChatMessage[]) => api.chat(history),
    onSuccess: (result) => {
      setMessages(result.messages);
      // Ассистент мог создать проект, задеплоить, закоммитить — обновляем всё
      void qc.invalidateQueries();
    },
    // Сообщение не дошло — убираем его из переписки и возвращаем в поле ввода, чтобы не задвоить при повторе
    onError: (_, history) => {
      const failed = history.at(-1);
      setMessages(history.slice(0, -1));
      if (failed && typeof failed.content === "string") setDraft(failed.content);
    },
  });

  useEffect(() => {
    saveHistory(messages);
  }, [messages]);
  // Без неявного return: в новых браузерах scrollIntoView возвращает Promise, а React ждёт от эффекта функцию очистки
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, send.isPending]);

  if (connections.error) return <ErrorNote message={errorMessage(connections.error)} />;
  if (!connections.data) return <Loading />;
  const connected = connections.data.some((c) => c.provider === "anthropic");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || send.isPending) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    send.mutate(next);
  }

  return (
    <>
      <div className="page-head">
        <h1>Ассистент</h1>
        {messages.length > 0 && (
          <button className="button button-quiet" onClick={() => setMessages([])} disabled={send.isPending}>
            Новый разговор
          </button>
        )}
      </div>

      {!connected ? (
        <div className="note">
          Ассистенту нужен ключ Claude API. <a href={href.connections}>Подключить</a>. Без ключа apphub доступен из
          Claude Code через MCP.
        </div>
      ) : (
        <>
          {messages.length === 0 && (
            <p className="muted lead">
              Опишите, что хотите сделать: «разверни сайт с базой для списка покупок», «почему упал деплой у notes?»,
              «добавь в todo-clock тёмную тему». Ассистент работает с проектами теми же средствами, что и интерфейс, и
              спросит согласия перед изменениями.
            </p>
          )}

          <div className="chat">
            {messages.map((m, i) =>
              isToolResults(m) ? null : (
                <div key={i} className={`chat-msg chat-${m.role}`}>
                  {blocks(m).map((b, j) => {
                    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
                      return (
                        <div key={j} className="chat-text">
                          <RichText text={b.text} />
                        </div>
                      );
                    }
                    if (b.type === "tool_use" && typeof b.name === "string") {
                      const input = (b.input ?? {}) as Record<string, unknown>;
                      return (
                        <div key={j} className="chat-tool">
                          {TOOL_LABEL[b.name] ?? b.name}
                          {toolSubject(input)}
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              ),
            )}
            {send.isPending && <div className="chat-msg chat-assistant chat-pending">Claude работает…</div>}
            <div ref={endRef} />
          </div>

          <ErrorNote message={errorMessage(send.error)} />

          <form className="chat-form" onSubmit={submit}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) submit(e);
              }}
              placeholder="Сообщение ассистенту… (Enter — отправить, Shift+Enter — новая строка)"
              rows={2}
              disabled={send.isPending}
            />
            <button className="button" type="submit" disabled={send.isPending || !draft.trim()}>
              Отправить
            </button>
          </form>
        </>
      )}
    </>
  );
}
