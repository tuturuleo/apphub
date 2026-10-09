// Изоляция проекта в общей базе Postgres: своя схема и свой пользователь с правами только на неё.
// SQL выполняется прямо из Worker по TCP (postgres.js) админской строкой подключения базы.
import postgres from "postgres";

export interface Isolation {
  schema: string;
  role: string;
  /** Строка подключения проекта: пользователь проекта, по умолчанию его схема. */
  url: string;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

function random(length: number, alphabet = "abcdefghijkmnopqrstuvwxyz23456789"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Имя проекта → безопасная часть идентификатора Postgres. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "project"
  );
}

function connect(url: string) {
  // Одно соединение на операцию; без prepared statements — работает и через пулеры Supabase
  return postgres(url, { max: 1, prepare: false, connect_timeout: 15, idle_timeout: 5, ssl: "prefer" });
}

/**
 * Создаёт схему и пользователя проекта. supabaseRef — для пулера Supabase: там пользователь пишется как роль.ref.
 * Схема с таким именем уже есть (например, от прошлого проекта) — берём другое имя, а не подключаемся к чужим данным.
 */
export async function createIsolation(
  adminUrl: string,
  projectName: string,
  opts: { supabaseRef?: string } = {},
): Promise<Isolation> {
  const base = slug(projectName);
  const role = `app_${base}_${random(6)}`;
  const password = random(32, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789");
  const sql = connect(adminUrl);
  let schema = `p_${base}`;
  try {
    await sql.begin(async (tx) => {
      const taken = await tx`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`;
      if (taken.length > 0) schema = `p_${base}_${random(4)}`;
      await tx.unsafe(`CREATE SCHEMA ${ident(schema)}`);
      // Пароль — только буквы и цифры, поэтому безопасно подставлять в литерал
      await tx.unsafe(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}'`);
      await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA ${ident(schema)} TO ${ident(role)}`);
      await tx.unsafe(`ALTER ROLE ${ident(role)} SET search_path = ${ident(schema)}`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  const url = new URL(adminUrl);
  url.username = opts.supabaseRef ? `${role}.${opts.supabaseRef}` : role;
  url.password = password;
  return { schema, role, url: url.toString() };
}

/** Удаляет схему проекта со всеми его таблицами и его пользователя. Остальные данные базы не затрагиваются. */
export async function dropIsolation(adminUrl: string, schema: string, role: string): Promise<void> {
  const sql = connect(adminUrl);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
      await tx.unsafe(`DROP ROLE IF EXISTS ${ident(role)}`);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
