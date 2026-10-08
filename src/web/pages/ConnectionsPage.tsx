import { useState } from "react";
import type { Connection, InstructionStep, PermissionGroup, ProviderInfo } from "../../shared/types";
import { api } from "../api";
import { ErrorNote, ExternalLink, Loading, StatusDot } from "../components";
import { useAsync } from "../useAsync";

export function ConnectionsPage() {
  const providers = useAsync(() => api.providers(), []);
  const connections = useAsync(() => api.connections(), []);

  if (providers.error || connections.error) return <ErrorNote message={providers.error ?? connections.error} />;
  if (!providers.data || !connections.data) return <Loading />;

  return (
    <>
      <div className="page-head">
        <h1>Подключения</h1>
      </div>
      <p className="muted lead">
        Аккаунт на каждой платформе заводится один раз вручную. Дальше apphub работает через токен — он хранится
        зашифрованным.
      </p>
      <ul className="card-list card-list-wide">
        {providers.data.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            connection={connections.data!.find((c) => c.provider === p.id)}
            onChange={() => void connections.reload()}
          />
        ))}
        <li className="card card-muted">
          <div className="card-row">
            <h2>Render, Google Drive</h2>
            <span className="badge">Скоро</span>
          </div>
          <p className="muted">Docker-сервисы на любом языке, файлы и таблицы.</p>
        </li>
      </ul>
    </>
  );
}

function ProviderCard({
  provider,
  connection,
  onChange,
}: {
  provider: ProviderInfo;
  connection?: Connection;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connect(provider.id, token);
      setToken("");
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm(`Отключить ${provider.name}? Токен будет удалён из apphub.`)) return;
    await api.disconnect(provider.id);
    onChange();
  }

  const showForm = editing || !connection;

  return (
    <li className="card">
      <div className="card-row">
        <h2>{provider.name}</h2>
        {connection ? (
          <span className="badge badge-ok">
            <StatusDot state="ok" />
            {connection.label}
          </span>
        ) : (
          <span className="badge">Не подключён</span>
        )}
      </div>
      <p className="muted">{provider.summary}</p>

      {showForm ? (
        <form className="form" onSubmit={save}>
          <ol className="steps">
            <li>
              Откройте <ExternalLink url={provider.tokenUrl}>страницу токенов {provider.name}</ExternalLink>.
            </li>
            {provider.steps.map((step, i) => (
              <Step key={i} step={step} />
            ))}
          </ol>
          {provider.notes.length > 0 && (
            <ul className="notes">
              {provider.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <label className="field">
            <span>Токен</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <ErrorNote message={error} />
          <div className="row">
            <button className="button" type="submit" disabled={busy}>
              {busy ? "Проверяю…" : "Подключить"}
            </button>
            {connection && (
              <button className="button button-quiet" type="button" onClick={() => setEditing(false)}>
                Отмена
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="row">
          <button className="button button-quiet" onClick={() => setEditing(true)}>
            Заменить токен
          </button>
          <button className="button button-quiet" onClick={() => void disconnect()}>
            Отключить
          </button>
        </div>
      )}
    </li>
  );
}

function Step({ step }: { step: InstructionStep }) {
  if (typeof step === "string") return <li>{step}</li>;
  return (
    <li>
      {step.text}
      <div className="perm-groups">
        {step.permissions.map((group) => (
          <PermissionBlock key={group.section} group={group} />
        ))}
      </div>
    </li>
  );
}

const isWriteLevel = (level: string) => /write|edit/i.test(level);

function PermissionBlock({ group }: { group: PermissionGroup }) {
  return (
    <div className="perm-group">
      <div className="perm-section">{group.section}</div>
      <ul>
        {group.items.map((item) => (
          <li key={item.name}>
            <span>{item.name}</span>
            <span className={`perm-level${isWriteLevel(item.level) ? " perm-level-write" : ""}`}>{item.level}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
