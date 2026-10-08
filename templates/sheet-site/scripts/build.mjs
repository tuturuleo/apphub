// Скачивает опубликованную Google-таблицу в CSV и собирает статический сайт в dist/.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../site.config.json", import.meta.url), "utf8"));

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const res = await fetch(config.sheetCsvUrl, { redirect: "follow" });
if (!res.ok) throw new Error(`Не удалось скачать таблицу: ${res.status} ${res.statusText}`);
const [columns = [], ...rows] = parseCsv(await res.text());

const dist = new URL("../dist/", import.meta.url);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(new URL("../public/", import.meta.url), dist, { recursive: true });
await writeFile(
  new URL("data.json", dist),
  JSON.stringify({ title: config.title, updatedAt: new Date().toISOString(), columns, rows }),
);
console.log(`Собрано: ${rows.length} строк, ${columns.length} колонок`);
