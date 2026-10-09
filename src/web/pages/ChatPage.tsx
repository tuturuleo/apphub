import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ChatBlock, ChatMessage } from "../../shared/types";
import { api } from "../api";
import { ErrorNote, Loading } from "../components";
import { errorMessage } from "../queries";
import { href } from "../router";

const STORAGE_KEY = "apphub.chat";
const MODEL_KEY = "apphub.chat.model";

function loadModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveModel(id: string) {
  try {
    localStorage.setItem(MODEL_KEY, id);
  } catch {
    // без хранилища выбор просто не запомнится
  }
}

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
  list_resources: "смотрю каталог ресурсов",
  get_limits: "смотрю лимиты",
  get_resource_logs: "читаю логи",
  restart_proxy: "перезапускаю прокси",
  add_project_resource: "создаю ресурс",
  bind_resource: "привязываю ресурс",
  connect_resources: "связываю ресурсы",
  list_drive_sheets: "смотрю таблицы",
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

const URL_RE = /(https?:\/\/[^\s)*`]+)/g;
// Модели отвечают в markdown: показываем **жирный** и `код`, остальное — как есть
const MARK_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

function Links({ text }: { text: string }) {
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

function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(MARK_RE).map((part, i) => {
        if (i % 2 === 0) return <Links key={i} text={part} />;
        if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
        return (
          <strong key={i}>
            <Links text={part.slice(2, -2)} />
          </strong>
        );
      })}
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
  const models = useQuery({ queryKey: ["chat", "models"], queryFn: api.chatModels });
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState(loadModel);
  const endRef = useRef<HTMLDivElement>(null);
  // Сохранённая модель могла исчезнуть из каталога — тогда первая доступная
  const model = models.data?.find((m) => m.id === picked)?.id ?? models.data?.[0]?.id ?? "";
  const groups = [...new Set(models.data?.map((m) => m.group))];

  const send = useMutation({
    mutationFn: (history: ChatMessage[]) => api.chat(history, model),
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

  if (models.error) return <ErrorNote message={errorMessage(models.error)} />;
  if (!models.data) return <Loading />;
  const connected = models.data.length > 0;

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
        <div className="row">
          {connected && (
            <select
              className="chat-model"
              value={model}
              onChange={(e) => {
                setPicked(e.target.value);
                saveModel(e.target.value);
              }}
              disabled={send.isPending}
              aria-label="Модель ассистента"
            >
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {models
                    .data!.filter((m) => m.group === g)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {m.tools === false ? " (без инструментов)" : ""}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          )}
          {messages.length > 0 && (
            <button className="button button-quiet" onClick={() => setMessages([])} disabled={send.isPending}>
              Новый разговор
            </button>
          )}
        </div>
      </div>

      {!connected ? (
        <div className="note">
          Нет доступных моделей: Workers AI недоступен, а LLM-провайдеры не подключены.{" "}
          <a href={href.connections}>Подключить</a>. AppHub также доступен из Claude Code через MCP.
        </div>
      ) : (
        <>
          {messages.length === 0 && (
            <p className="muted lead">
              Опишите, что хотите сделать: «разверни сайт с базой для списка покупок», «почему упал деплой у notes?»,
              «добавь в todo-clock тёмную тему». Ассистент работает с проектами теми же средствами, что и интерфейс, и
              спросит согласия перед изменениями. Бесплатные модели хорошо справляются с вопросами и простыми
              действиями; для сборки проекта по описанию сильнее Claude — через Claude Code и MCP.
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
            {send.isPending && <div className="chat-msg chat-assistant chat-pending">Ассистент работает…</div>}
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
