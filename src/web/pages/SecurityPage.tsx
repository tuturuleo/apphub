import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { authKey, registerPasskey, useAuthState } from "../auth";
import { ErrorNote, Loading } from "../components";
import { errorMessage } from "../queries";

const securityKey = ["security"] as const;

const formatDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "ещё не использовался";

export function SecurityPage() {
  const qc = useQueryClient();
  const auth = useAuthState();
  const info = useQuery({ queryKey: securityKey, queryFn: api.security });
  const refresh = () => qc.invalidateQueries({ queryKey: securityKey });

  const addPasskey = useMutation({ mutationFn: () => registerPasskey(), onSuccess: refresh });
  const removePasskey = useMutation({ mutationFn: api.deletePasskey, onSuccess: refresh });
  const removeToken = useMutation({ mutationFn: api.deleteToken, onSuccess: refresh });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => qc.invalidateQueries({ queryKey: authKey }),
  });

  const [tokenName, setTokenName] = useState("Claude Code");
  const [created, setCreated] = useState<string | null>(null);
  const createToken = useMutation({
    mutationFn: () => api.createToken(tokenName),
    onSuccess: (t) => {
      setCreated(t.token);
      void refresh();
    },
  });

  const mcpUrl = `${location.origin}/mcp`;

  return (
    <>
      <div className="page-head">
        <h1>Безопасность</h1>
        {!auth.data?.devNoAuth && (
          <button className="button button-quiet" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Выйти
          </button>
        )}
      </div>
      {auth.data?.devNoAuth && (
        <p className="note">
          Локальная разработка: вход отключён (DEV_ALLOW_NO_AUTH). Развёрнутый apphub всегда требует passkey.
        </p>
      )}

      <ErrorNote message={errorMessage(info.error)} />
      {info.isPending && <Loading />}

      <section>
        <h2 className="section-title">Passkeys</h2>
        <p className="muted">
          Вход в apphub. Passkey привязан к адресу: на другом адресе (например, через прокси без VPN) добавьте отдельный
          с кодом установки.
        </p>
        <ul className="resource-list">
          {info.data?.passkeys.map((p) => (
            <li key={p.id} className="resource">
              <div className="resource-main">
                <div className="resource-title">
                  <strong>{p.name}</strong>
                  <span className="kind">{p.rpId}</span>
                </div>
                <div className="muted small">
                  Создан {formatDate(p.createdAt)} · последний вход: {formatDate(p.lastUsedAt)}
                </div>
              </div>
              <button
                className="button button-quiet"
                disabled={removePasskey.isPending || (info.data?.passkeys.length ?? 0) <= 1}
                title={(info.data?.passkeys.length ?? 0) <= 1 ? "Последний passkey удалить нельзя" : undefined}
                onClick={() => confirm(`Удалить passkey «${p.name}»?`) && removePasskey.mutate(p.id)}
              >
                Удалить
              </button>
            </li>
          ))}
        </ul>
        <ErrorNote message={errorMessage(addPasskey.error ?? removePasskey.error)} />
        {!auth.data?.devNoAuth && (
          <button className="button button-quiet" onClick={() => addPasskey.mutate()} disabled={addPasskey.isPending}>
            {addPasskey.isPending ? "Жду подтверждения…" : "Добавить passkey на этом устройстве"}
          </button>
        )}
      </section>

      <section>
        <h2 className="section-title">Токены MCP</h2>
        <p className="muted">
          Для Claude Code и других MCP-клиентов. Токен показывается один раз; в apphub хранится только его хеш.
        </p>
        <ul className="resource-list">
          {info.data?.tokens.map((t) => (
            <li key={t.id} className="resource">
              <div className="resource-main">
                <div className="resource-title">
                  <strong>{t.name}</strong>
                </div>
                <div className="muted small">
                  Создан {formatDate(t.createdAt)} · использован: {formatDate(t.lastUsedAt)}
                </div>
              </div>
              <button
                className="button button-quiet"
                disabled={removeToken.isPending}
                onClick={() => confirm(`Отозвать токен «${t.name}»?`) && removeToken.mutate(t.id)}
              >
                Отозвать
              </button>
            </li>
          ))}
        </ul>

        {created ? (
          <div className="note">
            <p>Скопируйте токен сейчас — больше он показан не будет.</p>
            <pre className="code-block">{created}</pre>
            <p>Подключение в Claude Code:</p>
            <pre className="code-block">
              {`claude mcp add --transport http apphub ${mcpUrl} --header "Authorization: Bearer ${created}"`}
            </pre>
            <button className="button button-quiet" onClick={() => setCreated(null)}>
              Готово
            </button>
          </div>
        ) : (
          <form
            className="token-form"
            onSubmit={(e) => {
              e.preventDefault();
              createToken.mutate();
            }}
          >
            <label className="field">
              <span>Название</span>
              <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} maxLength={60} required />
            </label>
            <button className="button" type="submit" disabled={createToken.isPending}>
              Создать токен
            </button>
          </form>
        )}
        <ErrorNote message={errorMessage(createToken.error ?? removeToken.error)} />
      </section>
    </>
  );
}
