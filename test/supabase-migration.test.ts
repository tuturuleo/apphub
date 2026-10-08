// Миграции шаблона supabase-site на настоящем Postgres (PGlite) со стабом схемы auth, как в Supabase.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = new URL("../templates/supabase-site/supabase/migrations/", import.meta.url);
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";

let db: PGlite;

async function as<T>(role: "anon" | "authenticated", sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ""}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const texts = async (sub: string) =>
  (await as("authenticated", sub, () => db.query<{ text: string }>("select text from public.notes"))).rows.map(
    (r) => r.text,
  );

describe("supabase-site: миграции и RLS", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable
        as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
      grant usage on schema public to authenticated, anon;
      insert into auth.users values ('${U1}'), ('${U2}');
    `);
    for (const file of readdirSync(MIGRATIONS).sort()) {
      await db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
    }
    await as("authenticated", U1, () => db.query("insert into public.notes (text) values ('первого')"));
    await as("authenticated", U2, () => db.query("insert into public.notes (text) values ('второго')"));
  }, 30_000);

  it("каждый видит только свои заметки", async () => {
    expect(await texts(U1)).toEqual(["первого"]);
    expect(await texts(U2)).toEqual(["второго"]);
  });

  it("чужую заметку удалить нельзя", async () => {
    const res = await as("authenticated", U2, () => db.query("delete from public.notes where text = 'первого'"));
    expect(res.affectedRows).toBe(0);
    expect(await texts(U1)).toEqual(["первого"]);
  });

  it("нельзя записать заметку от чужого имени или пустую", async () => {
    await expect(
      as("authenticated", U2, () => db.query(`insert into public.notes (user_id, text) values ('${U1}', 'x')`)),
    ).rejects.toThrow(/row-level security/);
    await expect(as("authenticated", U2, () => db.query("insert into public.notes (text) values ('')"))).rejects.toThrow(
      /check constraint/,
    );
  });

  it("без входа доступа нет", async () => {
    await expect(as("anon", null, () => db.query("select * from public.notes"))).rejects.toThrow(/permission denied/);
  });
});
