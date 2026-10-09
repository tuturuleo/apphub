import { useState } from "react";
import type { Connection, InstructionStep, PermissionGroup, ProviderInfo } from "../../shared/types";
import { ErrorNote, ExternalLink, Loading, StatusDot } from "../components";
import {
  errorMessage,
  useAddConnection,
  useConnections,
  useDisconnect,
  useProviders,
  useReplaceToken,
} from "../queries";

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
        Аккаунт на каждой платформе заводится один раз вручную. Дальше AppHub работает через токен — он хранится
        зашифрованным.
      </p>
      <ul className="card-list card-list-wide">
        {providers.data.map((p) => (
          <ProviderCard key={p.id} provider={p} accounts={connections.data!.filter((c) => c.provider === p.id)} />
        ))}
      </ul>
    </>
  );
}

/** Форма токена с инструкцией провайдера — для нового аккаунта и для замены токена. */
function TokenForm({
  provider,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  provider: ProviderInfo;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (token: string) => void;
  onCancel?: () => void;
}) {
  const [token, setToken] = useState("");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(token);
      }}
    >
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
        <span>{provider.secretMultiline ? "Ключ (JSON)" : "Токен"}</span>
        {provider.secretMultiline ? (
          <textarea
            className="secret"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder='{ "type": "service_account", … }'
            required
          />
        ) : (
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        )}
      </label>
      <ErrorNote message={error} />
      <div className="row">
        <button className="button" type="submit" disabled={busy}>
          {busy ? "Проверяю…" : submitLabel}
        </button>
        {onCancel && (
          <button className="button button-quiet" type="button" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </form>
  );
}

function AccountRow({ provider, account }: { provider: ProviderInfo; account: Connection }) {
  const [editing, setEditing] = useState(false);
  const replace = useReplaceToken();
  const disconnect = useDisconnect();

  function remove() {
    const message =
      `Отключить ${provider.name} «${account.label}»? Токен будет удалён из apphub. ` +
      "Ресурсы этого аккаунта останутся в каталоге, но AppHub не сможет ими управлять, пока аккаунт не подключён снова.";
    if (confirm(message)) disconnect.mutate(account.id);
  }

  return (
    <li className="account">
      <div className="account-row">
        <StatusDot state="ok" />
        <span className="account-label">{account.label}</span>
        {!editing && (
          <div className="row">
            <button className="link-button" onClick={() => setEditing(true)}>
              Заменить токен
            </button>
            <button className="link-button link-danger" onClick={remove} disabled={disconnect.isPending}>
              Отключить
            </button>
          </div>
        )}
      </div>
      <ErrorNote message={errorMessage(disconnect.error)} />
      {editing && (
        <TokenForm
          provider={provider}
          submitLabel="Заменить"
          busy={replace.isPending}
          error={errorMessage(replace.error)}
          onSubmit={(token) => replace.mutate({ id: account.id, token }, { onSuccess: () => setEditing(false) })}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function ProviderCard({ provider, accounts }: { provider: ProviderInfo; accounts: Connection[] }) {
  const [adding, setAdding] = useState(false);
  const add = useAddConnection();
  // Нет ни одного аккаунта — форма сразу открыта
  const showForm = adding || accounts.length === 0;

  return (
    <li className="card">
      <div className="card-row">
        <h2>{provider.name}</h2>
        {accounts.length === 0 ? (
          <span className="badge">Не подключён</span>
        ) : (
          accounts.length > 1 && <span className="badge badge-ok">Аккаунтов: {accounts.length}</span>
        )}
      </div>
      <p className="muted">{provider.summary}</p>

      {accounts.length > 0 && (
        <ul className="accounts">
          {accounts.map((a) => (
            <AccountRow key={a.id} provider={provider} account={a} />
          ))}
        </ul>
      )}

      {showForm ? (
        <TokenForm
          provider={provider}
          submitLabel={accounts.length === 0 ? "Подключить" : "Добавить аккаунт"}
          busy={add.isPending}
          error={errorMessage(add.error)}
          onSubmit={(token) => add.mutate({ provider: provider.id, token }, { onSuccess: () => setAdding(false) })}
          onCancel={accounts.length > 0 ? () => setAdding(false) : undefined}
        />
      ) : (
        provider.multiAccount && (
          <div className="row">
            <button className="button button-quiet" onClick={() => setAdding(true)}>
              Добавить аккаунт
            </button>
          </div>
        )
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
