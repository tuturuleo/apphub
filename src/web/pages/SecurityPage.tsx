import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { authKey, registerPasskey, useAuthState } from "../auth";
import { ErrorNote, ExternalLink, Loading, StatusDot } from "../components";
import { errorMessage, useConnections } from "../queries";
import { href } from "../router";

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
          Локальная разработка: вход отключён (DEV_ALLOW_NO_AUTH). Развёрнутый AppHub всегда требует passkey.
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
          Для Claude Code и других MCP-клиентов. Токен показывается один раз; в AppHub хранится только его хеш.
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
      <ProxySection />
    </>
  );
}

const PROXY_DOT = { live: "ok", deploying: "pending", failed: "error", unknown: "unknown" } as const;

/** Прокси на Render: AppHub открывается по адресу onrender.com, если workers.dev недоступен без VPN. */
function ProxySection() {
  const qc = useQueryClient();
  const connections = useConnections();
  const renders = connections.data?.filter((c) => c.provider === "render") ?? [];
  const proxy = useQuery({
    queryKey: ["proxy"],
    queryFn: api.proxy,
    refetchInterval: (q) => (q.state.data?.state === "deploying" ? 10_000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["proxy"] });
  const [account, setAccount] = useState("");
  const [region, setRegion] = useState("frankfurt");
  const create = useMutation({
    mutationFn: () => api.createProxy(account || renders[0]?.id, region),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.deleteProxy, onSuccess: refresh });
  const redeploy = useMutation({ mutationFn: api.redeployProxy, onSuccess: refresh });
  const p = proxy.data;
  const viaProxy = !!p?.url && location.origin === p.url;

  return (
    <section>
      <h2 className="section-title">Доступ без VPN</h2>
      <p className="muted">
        Если адрес AppHub (workers.dev) открывается только через VPN, AppHub создаст в вашем аккаунте Render прокси:
        бесплатный сервис, который пересылает запросы сюда. Токены через него не хранятся — он только передаёт трафик.
        На новом адресе нужен свой passkey: войдите там с кодом установки. Бесплатный сервис засыпает без запросов —
        первый вход после паузы около минуты.
      </p>
      <ErrorNote message={errorMessage(proxy.error ?? create.error ?? remove.error ?? redeploy.error)} />
      {proxy.isPending ? (
        <Loading />
      ) : p ? (
        <ul className="resource-list">
          <li className="resource">
            <StatusDot state={PROXY_DOT[p.state]} />
            <div className="resource-main">
              <div className="resource-title">
                <strong>
                  {p.url ? <ExternalLink url={p.url}>{p.url.replace("https://", "")}</ExternalLink> : "Прокси"}
                </strong>
                {viaProxy && <span className="kind">вы здесь</span>}
              </div>
              <div className="muted small">{p.summary}</div>
            </div>
            <div className="links">
              <ExternalLink url={p.dashboardUrl}>Render</ExternalLink>
            </div>
            {p.state !== "live" && (
              <button
                className="button button-quiet"
                disabled={redeploy.isPending}
                onClick={() => redeploy.mutate()}
                title="Записать актуальную настройку прокси и перезапустить его"
              >
                {redeploy.isPending ? "Перезапускаю…" : "Обновить и перезапустить"}
              </button>
            )}
            <button
              className="button button-quiet"
              disabled={remove.isPending || viaProxy}
              title={viaProxy ? "Удалять прокси, открыв AppHub через него, нельзя" : undefined}
              onClick={() => confirm("Удалить прокси в Render? Адрес перестанет работать.") && remove.mutate()}
            >
              Удалить
            </button>
          </li>
        </ul>
      ) : renders.length === 0 ? (
        <p className="muted">
          Нужен аккаунт Render — <a href={href.connections}>подключите его</a>.
        </p>
      ) : (
        <form
          className="token-form"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          {renders.length > 1 && (
            <label className="field">
              <span>Аккаунт Render</span>
              <select value={account || renders[0].id} onChange={(e) => setAccount(e.target.value)}>
                {renders.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Регион</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="frankfurt">Франкфурт</option>
              <option value="virginia">Вирджиния</option>
              <option value="oregon">Орегон</option>
              <option value="ohio">Огайо</option>
              <option value="singapore">Сингапур</option>
            </select>
          </label>
          <button className="button" type="submit" disabled={create.isPending}>
            {create.isPending ? "Создаю…" : "Создать прокси"}
          </button>
        </form>
      )}
    </section>
  );
}
