import { useState } from "react";
import type { RecipeInfo } from "../../shared/types";
import { ErrorNote, Loading } from "../components";
import { errorMessage, useConnections, useCreateProject, useRecipes } from "../queries";
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

  if (recipes.error || connections.error) return <ErrorNote message={errorMessage(recipes.error ?? connections.error)} />;
  if (!recipes.data || !connections.data) return <Loading />;

  const connected = new Set(connections.data.map((c) => c.provider));
  const recipe = recipes.data.find((r) => r.id === recipeId);

  if (recipe) return <RecipeForm recipe={recipe} missing={recipe.requires.filter((p) => !connected.has(p))} />;

  return (
    <>
      <div className="page-head">
        <h1>Новый проект</h1>
      </div>
      <p className="muted lead">Рецепт — проверенная связка бесплатных сервисов с готовым шаблоном кода.</p>
      <ul className="card-list">
        {recipes.data.map((r) => {
          const missing = r.requires.filter((p) => !connected.has(p));
          return (
            <li key={r.id} className="card card-link">
              <a className="card-cover" href={href.newProject(r.id)} aria-label={r.name} />
              <h2>{r.name}</h2>
              <p>{r.summary}</p>
              <div className="tags">
                {r.stack.map((s) => (
                  <span key={s} className="tag">
                    {s}
                  </span>
                ))}
              </div>
              {missing.length > 0 && (
                <p className="muted small">Нужно подключить: {missing.map((p) => PROVIDER_NAMES[p] ?? p).join(", ")}</p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function RecipeForm({ recipe, missing }: { recipe: RecipeInfo; missing: string[] }) {
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

          {recipe.fields.map((f) => (
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
            <button className="button" type="submit" disabled={create.isPending || create.isSuccess}>
              {create.isPending || create.isSuccess ? "Создаю…" : "Создать проект"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
