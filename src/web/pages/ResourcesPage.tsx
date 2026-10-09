import { useState } from "react";
import { KIND_LABEL, ORIGIN_LABEL } from "../../shared/labels";
import type { CatalogResource } from "../../shared/types";
import { ErrorNote, ExternalLink, Loading, StatusDot } from "../components";
import {
  errorMessage,
  useAddExternalPostgres,
  useConnections,
  useDiscover,
  useImportResources,
  useRemoveResource,
  useResources,
  useResourcesStatus,
  useSetResourceSecret,
} from "../queries";
import { href } from "../router";



// Провайдеры, в аккаунтах которых есть что искать
const DISCOVERABLE = new Set(["github", "cloudflare", "supabase", "render", "google"]);

type Panel = "none" | "discover" | "external";

export function ResourcesPage() {
  const resources = useResources();
  const status = useResourcesStatus();
  const remove = useRemoveResource();
  const [panel, setPanel] = useState<Panel>("none");
  const [secretFor, setSecretFor] = useState<string | null>(null);
  const health = new Map(status.data?.map((h) => [h.resourceId, h]));

  function removeResource(r: CatalogResource) {
    const atProvider = r.origin === "created";
    const message = atProvider
      ? `Удалить «${r.name}» и у провайдера? Данные в нём пропадут безвозвратно.`
      : `Убрать «${r.name}» из каталога? У провайдера (или на вашем сервере) он останется.`;
    if (confirm(message)) remove.mutate({ id: r.id, atProvider });
  }

  return (
    <>
      <div className="page-head">
        <h1>Ресурсы</h1>
        <button className="button button-quiet" onClick={() => setPanel(panel === "discover" ? "none" : "discover")}>
          Найти в аккаунте
        </button>
        <button className="button button-quiet" onClick={() => setPanel(panel === "external" ? "none" : "external")}>
          Добавить свою базу
        </button>
      </div>
      <p className="muted lead">
        Всё, чем управляет apphub: созданное по рецептам, найденное в подключённых аккаунтах и внешнее. Ресурс можно
        привязать к нескольким проектам — например, одну базу к нескольким прототипам.
      </p>

      {panel === "discover" && <DiscoverPanel onDone={() => setPanel("none")} />}
      {panel === "external" && <ExternalPanel onDone={() => setPanel("none")} />}

      <ErrorNote message={errorMessage(resources.error ?? remove.error)} />
      {resources.isPending && <Loading />}
      {resources.data?.length === 0 && <p className="muted">Ресурсов пока нет.</p>}

      <ul className="resource-list">
        {resources.data?.map((r) => {
          const h = health.get(r.id);
          return (
            <li key={r.id} className="resource">
              <StatusDot state={h?.state ?? "unknown"} />
              <div className="resource-main">
                <div className="resource-title">
                  <span className="kind">{KIND_LABEL[r.kind]}</span>
                  <strong>{r.name}</strong>
                  <span className="tag">{ORIGIN_LABEL[r.origin]}</span>
                  {r.account && <span className="muted small">{r.account}</span>}
                </div>
                <div className="muted small">{h?.summary ?? (status.isPending ? "Проверяю…" : "—")}</div>
                <div className="small">
                  {r.projects.length === 0 ? (
                    <span className="muted">Не привязан к проектам</span>
                  ) : (
                    <>
                      <span className="muted">Проекты: </span>
                      {r.projects.map((p, i) => (
                        <span key={p.id}>
                          {i > 0 && ", "}
                          <a href={href.project(p.id)}>{p.name}</a>
                        </span>
                      ))}
                    </>
                  )}
                </div>
              </div>
              <div className="links">
                {r.url && <ExternalLink url={r.url}>Открыть</ExternalLink>}
                {r.consoleUrl && <ExternalLink url={r.consoleUrl}>Консоль</ExternalLink>}
                {(r.type === "supabase.project" || r.type === "postgres.external") && (
                  <button className="link-button" onClick={() => setSecretFor(secretFor === r.id ? null : r.id)}>
                    {r.hasSecret ? "Сменить строку подключения" : "Задать строку подключения"}
                  </button>
                )}
                <button
                  className="link-button link-danger"
                  onClick={() => removeResource(r)}
                  disabled={r.projects.length > 0 || remove.isPending}
                  title={r.projects.length > 0 ? "Сначала отвяжите от проектов" : undefined}
                >
                  {r.origin === "created" ? "Удалить" : "Убрать"}
                </button>
              </div>
              {secretFor === r.id && <SecretForm resourceId={r.id} onDone={() => setSecretFor(null)} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function DiscoverPanel({ onDone }: { onDone: () => void }) {
  const connections = useConnections();
  const accounts = (connections.data ?? []).filter((c) => DISCOVERABLE.has(c.provider));
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const found = useDiscover(connectionId);
  const importResources = useImportResources();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const keyOf = (r: { type: string; externalId: string }) => `${r.type}|${r.externalId}`;

  function toggle(key: string) {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  }

  function submit() {
    const items = [...picked].map((k) => {
      const [type, externalId] = k.split("|");
      return { type, externalId };
    });
    importResources.mutate({ connectionId: connectionId!, items }, { onSuccess: onDone });
  }

  return (
    <div className="card panel">
      <h2>Найти ресурсы в аккаунте</h2>
      <p className="muted small">
        Найденное берётся под наблюдение: статусы, проблемы, привязка к проектам. apphub такие ресурсы не создавал — и у
        провайдера никогда их не удалит.
      </p>
      <select
        value={connectionId ?? ""}
        onChange={(e) => {
          setConnectionId(e.target.value || null);
          setPicked(new Set());
        }}
      >
        <option value="">Выберите аккаунт…</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.provider}: {a.label}
          </option>
        ))}
      </select>

      {found.isFetching && <Loading />}
      <ErrorNote message={errorMessage(found.error ?? importResources.error)} />
      {found.data && found.data.length === 0 && <p className="muted">В аккаунте ничего не найдено.</p>}
      {found.data && found.data.length > 0 && (
        <>
          <ul className="discover-list">
            {found.data.map((r) => (
              <li key={keyOf(r)}>
                <label className={r.inCatalog ? "muted" : undefined}>
                  <input
                    type="checkbox"
                    disabled={r.inCatalog}
                    checked={r.inCatalog || picked.has(keyOf(r))}
                    onChange={() => toggle(keyOf(r))}
                  />
                  <span className="kind">{KIND_LABEL[r.kind]}</span> {r.name}
                  {r.inCatalog && <span className="small"> · уже в каталоге</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="button" onClick={submit} disabled={picked.size === 0 || importResources.isPending}>
              {importResources.isPending ? "Импортирую…" : `Импортировать${picked.size ? ` (${picked.size})` : ""}`}
            </button>
            <button className="button button-quiet" onClick={onDone}>
              Отмена
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ExternalPanel({ onDone }: { onDone: () => void }) {
  const add = useAddExternalPostgres();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  return (
    <form
      className="card panel form"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate({ name, url }, { onSuccess: onDone });
      }}
    >
      <h2>Своя база Postgres</h2>
      <p className="muted small">
        База на вашем сервере или у другого провайдера. Строка подключения хранится зашифрованной; apphub проверяет, что
        сервер принимает подключения, и сможет передавать её проектам. Сервер должен быть доступен из интернета.
      </p>
      <label className="field">
        <span>Название</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Моя база" required />
      </label>
      <label className="field">
        <span>Строка подключения</span>
        <input
          type="password"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="postgresql://user:password@host:5432/database"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <ErrorNote message={errorMessage(add.error)} />
      <div className="row">
        <button className="button" type="submit" disabled={add.isPending}>
          {add.isPending ? "Добавляю…" : "Добавить"}
        </button>
        <button className="button button-quiet" type="button" onClick={onDone}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/** Строка подключения к базе — чтобы apphub мог передавать DATABASE_URL сервисам проектов. */
function SecretForm({ resourceId, onDone }: { resourceId: string; onDone: () => void }) {
  const save = useSetResourceSecret();
  const [value, setValue] = useState("");
  return (
    <form
      className="secret-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ id: resourceId, secret: value }, { onSuccess: onDone });
      }}
    >
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="postgresql://… (Supabase: Connect → Session pooler)"
        autoComplete="off"
        required
      />
      <button className="button" type="submit" disabled={save.isPending}>
        Сохранить
      </button>
      <ErrorNote message={errorMessage(save.error)} />
    </form>
  );
}
