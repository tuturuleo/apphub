import { useState } from "react";
import { KIND_LABEL, ORIGIN_LABEL } from "../../shared/labels";
import type {
  BoundResource,
  NewResourceKind,
  ProjectDetails,
  Resource,
  ResourceActionId,
} from "../../shared/types";
import { ErrorNote, ExternalLink, Loading, ProjectStatusBadge, StatusDot, UpdatedAt, timeAgo } from "../components";
import {
  errorMessage,
  useAddWire,
  useBindResource,
  useNewResource,
  useReapplyWires,
  useRemoveWire,
  useConnections,
  useResources,
  useUnbindResource,
  useDeleteProject,
  useDeploy,
  useDestroyProject,
  useProject,
  useProjectStatus,
  useResourceAction,
  useStartProvision,
} from "../queries";
import { href, navigate } from "../router";



const RUN_STATE = (status: string, conclusion: string | null) =>
  status !== "completed" ? "pending" : conclusion === "success" ? "ok" : "error";

// Сколько после ручного деплоя опрашивать часто: GitHub создаёт запуск с задержкой
const DEPLOY_BOOST_MS = 60_000;

export function ProjectPage({ id }: { id: string }) {
  // Пока в фоне создаётся ресурс проекта, журнал опрашиваем часто
  const [taskBoostUntil, setTaskBoostUntil] = useState(0);
  const details = useProject(id, taskBoostUntil);
  const projectStatus = details.data?.project.status;
  // Пока ресурсы создаются, статусы у провайдеров не запрашиваем — включатся сами по завершении
  const settled = projectStatus === "ready" || projectStatus === "failed";
  const [boostUntil, setBoostUntil] = useState(0);
  const status = useProjectStatus(id, { enabled: settled, boostUntil });

  const deploy = useDeploy(id);
  const provision = useStartProvision(id);
  const action = useResourceAction(id);
  const remove = useDeleteProject();
  const destroy = useDestroyProject();
  const unbind = useUnbindResource();
  const connections = useConnections();
  const accountLabel = (connectionId: string | null) => {
    if (!connectionId) return null;
    const account = connections.data?.find((c) => c.id === connectionId);
    return account ? account.label : "аккаунт не подключён";
  };

  if (details.error) return <ErrorNote message={errorMessage(details.error)} />;
  if (!details.data) return <Loading />;

  const { project, resources, events } = details.data;
  const health = new Map(status.data?.health.map((h) => [h.resourceId, h]));
  const actionError = errorMessage(
    deploy.error ?? provision.error ?? action.error ?? remove.error ?? destroy.error ?? unbind.error,
  );
  const destroyFailures = destroy.data && !destroy.data.projectRemoved ? destroy.data.failed : [];
  const statusError = errorMessage(status.error);
  // Статус возвращает алерты после сверки — они свежее, чем в деталях проекта
  const alerts = status.data?.alerts ?? details.data.alerts;

  function runDeploy() {
    deploy.mutate(undefined, { onSuccess: () => setBoostUntil(Date.now() + DEPLOY_BOOST_MS) });
  }

  function unbindResource(resource: Resource) {
    const hint =
      resource.origin === "created"
        ? "Ресурс останется в каталоге — удалить его у провайдера можно на странице «Ресурсы»."
        : "Ресурс останется в каталоге и у провайдера.";
    if (confirm(`Отвязать «${resource.name}» от проекта? ${hint}`)) unbind.mutate({ projectId: id, resourceId: resource.id });
  }

  function runAction(resource: Resource, actionId: ResourceActionId) {
    action.mutate({ resourceId: resource.id, action: actionId });
  }

  function removeProject() {
    if (!confirm(`Убрать «${project.name}» из apphub? Репозиторий и сервисы у провайдеров останутся.`)) return;
    remove.mutate(id, { onSuccess: () => navigate(href.projects) });
  }

  function destroyProject() {
    const list = resources.map((r) => `• ${KIND_LABEL[r.kind]}: ${r.name}`).join("\n");
    const typed = prompt(
      `Будут безвозвратно удалены у провайдеров:\n${list || "• (ресурсов нет)"}\n\n` +
        `Данные в базах и код в репозитории восстановить будет нельзя.\nВведите имя проекта «${project.name}» для подтверждения:`,
    );
    if (typed === null) return;
    if (typed.trim() !== project.name) {
      alert("Имя не совпало — ничего не удалено.");
      return;
    }
    destroy.mutate(id, { onSuccess: (result) => result.projectRemoved && navigate(href.projects) });
  }

  return (
    <>
      <a className="back" href={href.projects}>
        ← Проекты
      </a>
      <div className="page-head">
        <h1>{project.name}</h1>
        <ProjectStatusBadge status={project.status} />
        <div className="spacer" />
        {settled && <UpdatedAt at={status.dataUpdatedAt} fetching={status.isFetching} />}
        <button
          className="button button-quiet"
          onClick={() => void status.refetch()}
          disabled={!settled || status.isFetching}
        >
          Обновить
        </button>
        <button className="button" onClick={runDeploy} disabled={deploy.isPending || project.status !== "ready"}>
          {deploy.isPending ? "Запускаю…" : "Задеплоить"}
        </button>
      </div>

      {project.status === "pending" && (
        <div className="note">
          Создание ресурсов ещё не запущено.{" "}
          <button className="link-button" onClick={() => provision.mutate()} disabled={provision.isPending}>
            Запустить
          </button>
        </div>
      )}
      {project.status === "provisioning" && (
        <div className="note">Создаю ресурсы у провайдеров — прогресс в журнале ниже.</div>
      )}
      <ErrorNote message={project.error} />
      {alerts.length > 0 && (
        <div className="note note-warn">
          <strong>Проблемы, найденные мониторингом</strong>
          <ul>
            {alerts.map((a) => (
              <li key={a.key}>
                {a.message} <span className="muted small">· {timeAgo(a.createdAt)}</span>
                {a.url && (
                  <>
                    {" "}
                    <ExternalLink url={a.url}>Открыть</ExternalLink>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNote message={actionError} />
      {statusError !== project.error && <ErrorNote message={statusError} />}

      <section>
        <h2 className="section-title">Ресурсы</h2>
        <ul className="resource-list">
          {resources.map((r) => {
            const h = health.get(r.id);
            return (
              <li key={r.id} className="resource">
                <StatusDot state={h?.state ?? "unknown"} />
                <div className="resource-main">
                  <div className="resource-title">
                    <span className="kind">{KIND_LABEL[r.kind]}</span>
                    <strong>{r.name}</strong>
                    {r.origin !== "created" && <span className="tag">{ORIGIN_LABEL[r.origin]}</span>}
                    {accountLabel(r.connectionId) && <span className="muted small">{accountLabel(r.connectionId)}</span>}
                  </div>
                  <div className="muted small">{h?.summary ?? (!settled ? "Создаётся…" : status.isPending ? "Проверяю…" : "—")}</div>
                </div>
                <div className="links">
                  {h?.action && (
                    <button
                      className="link-button"
                      onClick={() => runAction(r, h.action!.id)}
                      disabled={action.isPending && action.variables?.resourceId === r.id}
                    >
                      {action.isPending && action.variables?.resourceId === r.id ? "…" : h.action.label}
                    </button>
                  )}
                  {r.url && <ExternalLink url={r.url}>Открыть</ExternalLink>}
                  {r.consoleUrl && <ExternalLink url={r.consoleUrl}>Консоль</ExternalLink>}
                  <button
                    className="link-button link-muted"
                    onClick={() => unbindResource(r)}
                    disabled={unbind.isPending}
                    title="Убрать ресурс из проекта; в каталоге и у провайдера он останется"
                  >
                    Отвязать
                  </button>
                </div>
              </li>
            );
          })}
          {resources.length === 0 && <li className="resource muted">Ресурсов нет</li>}
        </ul>
        {project.status === "ready" && (
          <AddResource
            projectId={id}
            resources={resources}
            onBackground={() => setTaskBoostUntil(Date.now() + 6 * 60_000)}
          />
        )}
      </section>

      <WiresSection projectId={id} details={details.data} />

      {status.data && status.data.runs.length > 0 && (
        <section>
          <h2 className="section-title">Сборки и деплои</h2>
          <ul className="resource-list">
            {status.data.runs.map((run) => (
              <li key={`${run.source}:${run.id}`} className="resource">
                <StatusDot state={RUN_STATE(run.status, run.conclusion)} />
                <div className="resource-main">
                  <div className="resource-title">
                    <strong>{run.source === "github" ? `GitHub Actions · ${run.name}` : run.name}</strong>
                    <span className="muted small">
                      {run.event} · {timeAgo(run.createdAt)}
                    </span>
                  </div>
                  {run.commitMessage && <div className="muted small">{run.commitMessage}</div>}
                </div>
                <div className="links">
                  <ExternalLink url={run.url}>Лог</ExternalLink>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="section-title">Журнал</h2>
        <ol className="log">
          {events.map((e) => (
            <li key={e.id} className={e.level === "error" ? "log-error" : undefined}>
              <time>{new Date(e.createdAt).toLocaleString("ru-RU")}</time>
              <span>{e.message}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="danger">
        {destroyFailures.length > 0 && (
          <div className="note note-error">
            Не всё удалось удалить:
            <ul>
              {destroyFailures.map((f) => (
                <li key={f.resource}>
                  {f.resource}: {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="row">
          <button className="button button-danger" onClick={destroyProject} disabled={destroy.isPending}>
            {destroy.isPending ? "Удаляю ресурсы…" : "Удалить проект и ресурсы"}
          </button>
          <button className="button button-quiet" onClick={removeProject} disabled={remove.isPending || destroy.isPending}>
            Убрать из apphub
          </button>
        </div>
        <p className="muted small">
          «Удалить» стирает репозиторий, сервисы и базы у провайдеров. «Убрать» — только из apphub, всё у провайдеров
          останется.
        </p>
      </section>
    </>
  );
}

type AddMode = "closed" | "new" | "catalog";

const NEW_KINDS: { kind: NewResourceKind; label: string; hint: string }[] = [
  { kind: "github-repo", label: "Репозиторий GitHub", hint: "Пустой репозиторий с README" },
  { kind: "supabase-db", label: "База Supabase (Postgres)", hint: "Поднимается 1–3 минуты, в фоне" },
  { kind: "d1-db", label: "База Cloudflare D1 (SQLite)", hint: "Создаётся сразу" },
  { kind: "render-service", label: "Сервис Render из репозитория", hint: "Нужен Dockerfile в корне репозитория" },
  { kind: "telegram-bot", label: "Telegram-бот", hint: "Токен от @BotFather — apphub будет следить, что бот жив" },
];

/** Добавить ресурс в проект: создать новый или привязать существующий из каталога. */
function AddResource({
  projectId,
  resources,
  onBackground,
}: {
  projectId: string;
  resources: BoundResource[];
  onBackground: () => void;
}) {
  const [mode, setMode] = useState<AddMode>("closed");
  const [kind, setKind] = useState<NewResourceKind>("github-repo");
  const [params, setParams] = useState<Record<string, string>>({});
  const create = useNewResource();
  const repos = resources.filter((r) => r.type === "github.repo");
  const set = (key: string, value: string) => setParams({ ...params, [key]: value });

  if (mode === "closed") {
    return (
      <div className="row add-resource-actions">
        <button className="button button-quiet" onClick={() => setMode("new")}>
          Создать ресурс
        </button>
        <button className="button button-quiet" onClick={() => setMode("catalog")}>
          Привязать из каталога
        </button>
      </div>
    );
  }
  if (mode === "catalog") {
    return <BindFromCatalog projectId={projectId} bound={resources.map((r) => r.id)} onDone={() => setMode("closed")} />;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const defaults: Record<string, string> =
      kind === "supabase-db" ? { region: "emea" } : kind === "render-service" ? { region: "frankfurt" } : {};
    create.mutate(
      { projectId, kind, params: { ...defaults, ...params } },
      {
        onSuccess: (result) => {
          if (result.background) onBackground();
          setParams({});
          setMode("closed");
        },
      },
    );
  }

  return (
    <form className="card panel form" onSubmit={submit}>
      <h2>Создать ресурс в проекте</h2>
      <label className="field">
        <span>Что создать</span>
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as NewResourceKind);
            setParams({});
          }}
        >
          {NEW_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <small className="muted">{NEW_KINDS.find((k) => k.kind === kind)?.hint}</small>
      </label>

      {(kind === "github-repo" || kind === "d1-db") && (
        <label className="field">
          <span>Имя</span>
          <input
            value={params.name ?? ""}
            onChange={(e) => set("name", e.target.value.toLowerCase())}
            placeholder={kind === "d1-db" ? "my-db" : "my-repo"}
            required
          />
        </label>
      )}
      {kind === "github-repo" && (
        <label className="field">
          <span>Видимость</span>
          <select value={params.visibility ?? "private"} onChange={(e) => set("visibility", e.target.value)}>
            <option value="private">Приватный</option>
            <option value="public">Публичный</option>
          </select>
        </label>
      )}
      {kind === "supabase-db" && (
        <label className="field">
          <span>Регион</span>
          <select value={params.region ?? "emea"} onChange={(e) => set("region", e.target.value)}>
            <option value="emea">Европа</option>
            <option value="americas">Америка</option>
            <option value="apac">Азия и Океания</option>
          </select>
        </label>
      )}
      {kind === "render-service" && (
        <>
          <label className="field">
            <span>Репозиторий проекта</span>
            {repos.length === 0 ? (
              <div className="note">Сначала добавьте в проект репозиторий с Dockerfile.</div>
            ) : (
              <select value={params.repo ?? ""} onChange={(e) => set("repo", e.target.value)} required>
                <option value="">— выберите —</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="field">
            <span>Регион</span>
            <select value={params.region ?? "frankfurt"} onChange={(e) => set("region", e.target.value)}>
              <option value="frankfurt">Европа (Франкфурт)</option>
              <option value="virginia">США, восток</option>
              <option value="oregon">США, запад</option>
              <option value="singapore">Азия (Сингапур)</option>
            </select>
          </label>
          <label className="field">
            <span>Путь проверки здоровья</span>
            <input
              value={params.healthCheckPath ?? ""}
              onChange={(e) => set("healthCheckPath", e.target.value)}
              placeholder="/"
            />
          </label>
        </>
      )}
      {kind === "telegram-bot" && (
        <label className="field">
          <span>Токен бота</span>
          <input
            type="password"
            value={params.token ?? ""}
            onChange={(e) => set("token", e.target.value)}
            placeholder="123456:ABC-DEF…"
            autoComplete="off"
            required
          />
          <small className="muted">В @BotFather: /newbot — или /token для существующего бота.</small>
        </label>
      )}

      <ErrorNote message={errorMessage(create.error)} />
      <div className="row">
        <button className="button" type="submit" disabled={create.isPending}>
          {create.isPending ? "Создаю…" : "Создать"}
        </button>
        <button className="button button-quiet" type="button" onClick={() => setMode("closed")}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/** Привязать к проекту ресурс из каталога — например, общую базу или импортированный репозиторий. */
function BindFromCatalog({ projectId, bound, onDone }: { projectId: string; bound: string[]; onDone: () => void }) {
  const resources = useResources();
  const bind = useBindResource();
  const [choice, setChoice] = useState("");
  const free = (resources.data ?? []).filter((r) => !bound.includes(r.id));

  return (
    <div className="card panel">
      <h2>Привязать из каталога</h2>
      {resources.isPending ? (
        <Loading />
      ) : free.length === 0 ? (
        <p className="muted">
          В каталоге нет непривязанных к проекту ресурсов. <a href={href.resources}>Каталог</a>
        </p>
      ) : (
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">— выберите ресурс —</option>
          {free.map((r) => (
            <option key={r.id} value={r.id}>
              {KIND_LABEL[r.kind]}: {r.name}
              {r.projects.length > 0 ? ` (уже в: ${r.projects.map((p) => p.name).join(", ")})` : ""}
            </option>
          ))}
        </select>
      )}
      <ErrorNote message={errorMessage(bind.error)} />
      <div className="row">
        <button
          className="button"
          disabled={!choice || bind.isPending}
          onClick={() => bind.mutate({ projectId, resourceId: choice }, { onSuccess: onDone })}
        >
          Привязать
        </button>
        <button className="button button-quiet" onClick={onDone}>
          Отмена
        </button>
      </div>
    </div>
  );
}

/** Связи: какой выход какого ресурса записан в какую переменную. */
function WiresSection({ projectId, details }: { projectId: string; details: ProjectDetails }) {
  const { resources, wires, outputs, consumers } = details;
  const add = useAddWire();
  const remove = useRemoveWire();
  const reapply = useReapplyWires();
  const byId = new Map(resources.map((r) => [r.id, r]));
  const sources = resources.filter((r) => (outputs[r.id] ?? []).length > 0);
  const targets = resources.filter((r) => consumers.includes(r.id));

  const [sourceId, setSourceId] = useState("");
  const [output, setOutput] = useState("");
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState("");
  const sourceOutputs = outputs[sourceId] ?? [];
  const chosenOutput = sourceOutputs.find((o) => o.key === output);

  if (sources.length === 0 || targets.length === 0) {
    if (wires.length === 0) return null;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    add.mutate(
      { projectId, wire: { sourceId, output, targetId, name: name || output } },
      {
        onSuccess: () => {
          setSourceId("");
          setOutput("");
          setTargetId("");
          setName("");
        },
      },
    );
  }

  return (
    <section>
      <div className="section-head">
        <h2 className="section-title">Связи</h2>
        {wires.length > 0 && (
          <button className="link-button" onClick={() => reapply.mutate(projectId)} disabled={reapply.isPending}>
            {reapply.isPending ? "Передаю…" : "Передать заново"}
          </button>
        )}
      </div>
      {wires.length > 0 && (
        <ul className="resource-list">
          {wires.map((w) => (
            <li key={`${w.targetId}:${w.name}`} className="resource">
              <StatusDot state={w.error ? "error" : w.appliedAt ? "ok" : "pending"} />
              <div className="resource-main">
                <div className="resource-title">
                  <strong>{byId.get(w.sourceId)?.name ?? "?"}</strong>
                  <span className="muted small">{w.output}</span>
                  <span className="muted">→</span>
                  <strong>{byId.get(w.targetId)?.name ?? "?"}</strong>
                  <code className="small">{w.name}</code>
                </div>
                <div className={`small ${w.error ? "log-error" : "muted"}`}>
                  {w.error ?? (w.appliedAt ? `Передано ${timeAgo(w.appliedAt)}` : "Ещё не передано")}
                </div>
              </div>
              <div className="links">
                <button
                  className="link-button link-muted"
                  onClick={() => {
                    if (confirm(`Убрать связь и переменную ${w.name} у «${byId.get(w.targetId)?.name}»?`)) {
                      remove.mutate({ projectId, targetId: w.targetId, name: w.name });
                    }
                  }}
                >
                  Убрать
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {sources.length > 0 && targets.length > 0 && (
        <form className="wire-form" onSubmit={submit}>
          <select
            value={sourceId}
            onChange={(e) => {
              setSourceId(e.target.value);
              setOutput("");
            }}
            required
          >
            <option value="">Откуда…</option>
            {sources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select value={output} onChange={(e) => setOutput(e.target.value)} required disabled={!sourceId}>
            <option value="">Значение…</option>
            {sourceOutputs.map((o) => (
              <option key={o.key} value={o.key} disabled={!o.available}>
                {o.label}
                {o.available ? "" : " — не задано"}
              </option>
            ))}
          </select>
          <span className="muted">→</span>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
            <option value="">Куда…</option>
            {targets
              .filter((r) => r.id !== sourceId)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder={output || "ПЕРЕМЕННАЯ"}
            pattern="[A-Z_][A-Z0-9_]*"
          />
          <button className="button" type="submit" disabled={add.isPending}>
            {add.isPending ? "Передаю…" : "Связать"}
          </button>
        </form>
      )}
      {chosenOutput && !chosenOutput.available && (
        <p className="muted small">
          Значение не задано — для базы Supabase строку подключения можно задать в <a href={href.resources}>каталоге</a>.
        </p>
      )}
      <ErrorNote message={errorMessage(add.error ?? remove.error ?? reapply.error)} />
    </section>
  );
}
