import { useState } from "react";
import type { Connection, InstructionStep, PermissionGroup, ProviderInfo } from "../../shared/types";
import { ErrorNote, ExternalLink, Loading, StatusDot } from "../components";
import { errorMessage, useConnect, useConnections, useDisconnect, useProviders } from "../queries";

export function ConnectionsPage() {
  const providers = useProviders();
  const connections = useConnections();

  if (providers.error || connections.error) {
    return <ErrorNote message={errorMessage(providers.error ?? connections.error)} />;
  }
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
}: {
  provider: ProviderInfo;
  connection?: Connection;
}) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const connect = useConnect();
  const disconnect = useDisconnect();

  function save(e: React.FormEvent) {
    e.preventDefault();
    connect.mutate(
      { provider: provider.id, token },
      {
        onSuccess: () => {
          setToken("");
          setEditing(false);
        },
      },
    );
  }

  function remove() {
    if (!confirm(`Отключить ${provider.name}? Токен будет удалён из apphub.`)) return;
    disconnect.mutate(provider.id);
  }

  const busy = connect.isPending;
  const error = errorMessage(connect.error ?? disconnect.error);

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
              Откройте <ExternalLink url={provider.tokenUrl}>{provider.tokenLinkLabel}</ExternalLink>.
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
        <>
          <ErrorNote message={errorMessage(disconnect.error)} />
          <div className="row">
            <button className="button button-quiet" onClick={() => setEditing(true)}>
              Заменить токен
            </button>
            <button className="button button-quiet" onClick={remove} disabled={disconnect.isPending}>
              Отключить
            </button>
          </div>
        </>
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
