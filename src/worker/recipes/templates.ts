// Шаблоны проектов лежат в /templates и встраиваются в бандл worker'а при сборке.
// Файлы, которые должны начинаться с точки, хранятся с подчёркиванием: _github → .github, _gitignore → .gitignore.
import type { RepoFile } from "../providers/github";

const sources = import.meta.glob<string>("../../../templates/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
});

const ROOT = "../../../templates/";

function outputPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === "_github" || segment === "_gitignore" ? `.${segment.slice(1)}` : segment))
    .join("/");
}

export function templateExists(id: string): boolean {
  return Object.keys(sources).some((p) => p.startsWith(`${ROOT}${id}/`));
}

/** Подставляет %%VAR%% во все файлы шаблона. Неизвестная переменная — ошибка, чтобы не закоммитить мусор. */
export function renderTemplate(id: string, vars: Record<string, string>): RepoFile[] {
  const prefix = `${ROOT}${id}/`;
  const files = Object.entries(sources)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, content]) => ({
      path: outputPath(path.slice(prefix.length)),
      content: content.replace(/%%([A-Z0-9_]+)%%/g, (_, name: string) => {
        const value = vars[name];
        if (value === undefined) throw new Error(`Шаблон ${id}: не задана переменная ${name}`);
        return value;
      }),
    }));
  if (files.length === 0) throw new Error(`Шаблон ${id} не найден`);
  return files;
}
