// Скачивает Google-таблицу в CSV и собирает статический сайт в dist/.
// Источник: опубликованная таблица (sheetCsvUrl) или приватная из Drive (googleSheetId + секрет GOOGLE_SA_KEY).
import { createSign } from "node:crypto";
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

const base64url = (value) => Buffer.from(value).toString("base64url");

/** Токен Google по ключу сервисного аккаунта (JWT, RS256). */
async function googleToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 600,
    }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google: не удалось получить токен: ${data.error_description ?? res.status}`);
  return data.access_token;
}

async function downloadCsv() {
  if (config.googleSheetId) {
    if (!process.env.GOOGLE_SA_KEY) throw new Error("Нет секрета GOOGLE_SA_KEY с ключом сервисного аккаунта");
    const key = JSON.parse(process.env.GOOGLE_SA_KEY);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${config.googleSheetId}/export?mimeType=text/csv`,
      { headers: { Authorization: `Bearer ${await googleToken(key)}` } },
    );
    if (res.status === 404) throw new Error(`Нет доступа к таблице: поделитесь ею с ${key.client_email}`);
    if (!res.ok) throw new Error(`Не удалось скачать таблицу из Drive: ${res.status} ${await res.text()}`);
    return res.text();
  }
  const res = await fetch(config.sheetCsvUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Не удалось скачать таблицу: ${res.status} ${res.statusText}`);
  return res.text();
}

const [columns = [], ...rows] = parseCsv(await downloadCsv());

const dist = new URL("../dist/", import.meta.url);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(new URL("../public/", import.meta.url), dist, { recursive: true });
await writeFile(
  new URL("data.json", dist),
  JSON.stringify({ title: config.title, updatedAt: new Date().toISOString(), columns, rows }),
);
console.log(`Собрано: ${rows.length} строк, ${columns.length} колонок`);
