import { useState } from "react";
import type { LimitItem, RecipeInfo } from "../../shared/types";
import { ErrorNote, Loading } from "../components";
import { formatAmount } from "../limits";
import {
  errorMessage,
  useConnections,
  useCreateProject,
  useGoogleSheets,
  useLimits,
  useRecipes,
  useSaveSettings,
  useSettings,
} from "../queries";
import { href, navigate } from "../router";

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  cloudflare: "Cloudflare",
  supabase: "Supabase",
  render: "Render",
};

export function NewProjectPage({ recipeId }: { recipeId?: string }) {
  const recipes = useRecipes();
  const connections = useConnections();
  const limits = useLimits();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const audienceRussia = settings.data?.audienceRussia ?? false;

  if (recipes.error || connections.error)
    return <ErrorNote message={errorMessage(recipes.error ?? connections.error)} />;
  if (!recipes.data || !connections.data) return <Loading />;

  const connected = new Set(connections.data.map((c) => c.provider));
  const recipe = recipes.data.find((r) => r.id === recipeId);

  // Лимиты подгружаются дольше остального — до их прихода просто не показываем предупреждения
  const exhausted = (r: RecipeInfo) => (limits.data ?? []).filter((l) => r.needs.includes(l.key) && l.state === "full");

  if (recipe) {
    return (
      <RecipeForm
        recipe={recipe}
        missing={recipe.requires.filter((p) => !connected.has(p))}
        exhausted={exhausted(recipe)}
      />
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Новый проект</h1>
        <label className="toggle">
          <input
            type="checkbox"
            checked={audienceRussia}
            disabled={!settings.data || saveSettings.isPending}
            onChange={(e) => saveSettings.mutate({ audienceRussia: e.target.checked })}
          />
          Пользователи в России
        </label>
      </div>
      <p className="muted lead">Рецепт — проверенная связка бесплатных сервисов с готовым шаблоном кода.</p>
      <ul className="card-list">
        {[...recipes.data]
          // С учётом аудитории: доступные из России без VPN — первыми (сортировка устойчивая)
          .sort((a, b) => (audienceRussia ? Number(b.russia.ok) - Number(a.russia.ok) : 0))
          .map((r) => {
            const missing = r.requires.filter((p) => !connected.has(p));
            return (
              <li key={r.id} className="card card-link">
                <a className="card-cover" href={href.newProject(r.id)} aria-label={r.name} />
                <div className="card-row">
                  <h2>{r.name}</h2>
                  {audienceRussia && r.russia.ok && <span className="badge badge-ok">Рекомендуется</span>}
                </div>
                <p>{r.summary}</p>
                <div className="tags">
                  {r.stack.map((s) => (
                    <span key={s} className="tag">
                      {s}
                    </span>
                  ))}
                </div>
                {missing.length > 0 && (
                  <p className="muted small">
                    Нужно подключить: {missing.map((p) => PROVIDER_NAMES[p] ?? p).join(", ")}
                  </p>
                )}
                {!r.russia.ok && <p className="small limit-warn">Из России без VPN может не открываться</p>}
                {exhausted(r).map((l) => (
                  <p key={l.key} className="small limit-full">
                    Лимит исчерпан: {l.label}
                  </p>
                ))}
              </li>
            );
          })}
      </ul>
    </>
  );
}

function limitText(l: LimitItem): string {
  const amount = l.used === null ? "" : ` — ${formatAmount(l.used, l.unit)} из ${formatAmount(l.limit, l.unit)}`;
  const holders = l.holders.length > 0 ? ` (${l.holders.join(", ")})` : "";
  return `${l.label}${amount}${holders}`;
}

function RecipeForm({ recipe, missing, exhausted }: { recipe: RecipeInfo; missing: string[]; exhausted: LimitItem[] }) {
  const [name, setName] = useState("");
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(recipe.fields.map((f) => [f.key, f.default ?? ""])),
  );
  const create = useCreateProject();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    create.mutate({ recipeId: recipe.id, name, params }, { onSuccess: (id) => navigate(href.project(id)) });
  }

  return (
    <>
      <a className="back" href={href.newProject()}>
        ← Все рецепты
      </a>
      <div className="page-head">
        <h1>{recipe.name}</h1>
      </div>
      <p className="muted lead">{recipe.summary}</p>

      {recipe.russia.note && <div className="note note-warn">{recipe.russia.note}</div>}
      {exhausted.length > 0 && missing.length === 0 && (
        <div className="note note-error">
          Не хватает бесплатного лимита — проект не создастся:
          <ul>
            {exhausted.map((l) => (
              <li key={l.key}>
                {limitText(l)}
                {l.note && <div className="small">{l.note}</div>}
              </li>
            ))}
          </ul>
          <a href={href.limits}>Все лимиты</a>
        </div>
      )}
      {missing.length > 0 ? (
        <div className="note">
          Для этого рецепта нужно подключить: {missing.map((p) => PROVIDER_NAMES[p] ?? p).join(", ")}.{" "}
          <a href={href.connections}>Перейти к подключениям</a>
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <label className="field">
            <span>Имя проекта</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="my-prototype"
              pattern="[a-z][a-z0-9\-]{1,30}[a-z0-9]"
              required
              autoFocus
            />
            <small className="muted">Станет именем репозитория и сервисов. Латиница, цифры и дефис.</small>
          </label>

          {recipe.fields
            .filter((f) => !f.showIf || f.showIf.values.includes(params[f.showIf.field]))
            .map((f) => (
              <label key={f.key} className="field">
                <span>{f.label}</span>
                {f.type === "select" ? (
                  <select value={params[f.key]} onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.type === "google-sheet" ? (
                  <GoogleSheetSelect value={params[f.key]} onChange={(v) => setParams({ ...params, [f.key]: v })} />
                ) : (
                  <input
                    type={f.type}
                    value={params[f.key]}
                    onChange={(e) => setParams({ ...params, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                    required={f.required}
                  />
                )}
                {f.help && <small className="muted">{f.help}</small>}
              </label>
            ))}
          {recipe.notes.length > 0 && (
            <ul className="notes">
              {recipe.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          <ErrorNote message={errorMessage(create.error)} />
          <div>
            <button
              className="button"
              type="submit"
              disabled={create.isPending || create.isSuccess || exhausted.length > 0}
            >
              {create.isPending || create.isSuccess ? "Создаю…" : "Создать проект"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

/** Выбор из таблиц, которыми поделились с сервисным аккаунтом Google. */
function GoogleSheetSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const connections = useConnections();
  const connected = !!connections.data?.some((c) => c.provider === "google");
  const sheets = useGoogleSheets(connected);

  if (!connections.data) return <Loading />;
  if (!connected) {
    return (
      <div className="note">
        Подключите Google Drive. <a href={href.connections}>Перейти к подключениям</a>
      </div>
    );
  }
  if (sheets.error) return <ErrorNote message={errorMessage(sheets.error)} />;
  if (!sheets.data) return <Loading />;
  if (sheets.data.sheets.length === 0) {
    return (
      <div className="note">
        Сервисному аккаунту не доступна ни одна таблица. Поделитесь нужной с <b>{sheets.data.serviceAccount}</b> (права
        «Читатель») и{" "}
        <button type="button" className="link-button" onClick={() => void sheets.refetch()}>
          обновите список
        </button>
        .
      </div>
    );
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">— выберите таблицу —</option>
      {sheets.data.sheets.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
