// Изоляция проекта на настоящем Postgres: PGlite в режиме сервера, postgres.js ходит к нему по TCP.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolation, dropIsolation, slug } from "../src/worker/isolation";

const PORT = 54391;
const ADMIN = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
let db: PGlite;
let server: PGLiteSocketServer;

const exists = async (sql: string, value: string) => (await db.query(sql, [value])).rows.length > 0;
const hasSchema = (name: string) => exists("SELECT 1 FROM pg_namespace WHERE nspname = $1", name);
const hasRole = (name: string) => exists("SELECT 1 FROM pg_roles WHERE rolname = $1", name);

describe("изоляция проекта в общей базе", () => {
  beforeAll(async () => {
    db = new PGlite();
    server = new PGLiteSocketServer({ db, port: PORT, maxConnections: 4 });
    await server.start();
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    await db.close();
  });

  it("создаёт схему и пользователя с правами на неё и search_path", async () => {
    const iso = await createIsolation(ADMIN, "My Shop-API");
    expect(iso.schema).toBe("p_my_shop_api");
    expect(iso.role).toMatch(/^app_my_shop_api_[a-z0-9]{6}$/);
    expect(await hasSchema(iso.schema)).toBe(true);
    expect(await hasRole(iso.role)).toBe(true);

    const url = new URL(iso.url);
    expect(url.username).toBe(iso.role);
    expect(url.password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(url.host).toBe(`127.0.0.1:${PORT}`);

    const grants = await db.query<{ ok: boolean }>(
      "SELECT has_schema_privilege($1, $2, 'USAGE') AND has_schema_privilege($1, $2, 'CREATE') AS ok",
      [iso.role, iso.schema],
    );
    expect(grants.rows[0].ok).toBe(true);
    const config = await db.query<{ rolconfig: string[] }>("SELECT rolconfig FROM pg_roles WHERE rolname = $1", [
      iso.role,
    ]);
    expect(config.rows[0].rolconfig.join()).toContain(`search_path=${iso.schema}`);
  });

  it("занятое имя схемы не переиспользует — чужие старые данные не достанутся новому проекту", async () => {
    const second = await createIsolation(ADMIN, "my shop api");
    expect(second.schema).toMatch(/^p_my_shop_api_[a-z0-9]{4}$/);
  });

  it("для пулера Supabase пользователь пишется как роль.ref", async () => {
    const iso = await createIsolation(ADMIN, "supa", { supabaseRef: "abcdefghijklmnopqrst" });
    expect(new URL(iso.url).username).toBe(`${iso.role}.abcdefghijklmnopqrst`);
  });

  it("удаление снимает схему вместе с таблицами и пользователя, не трогая остальное", async () => {
    const keep = await createIsolation(ADMIN, "keep me");
    const gone = await createIsolation(ADMIN, "drop me");
    await db.exec(`CREATE TABLE "${gone.schema}".notes (id int); INSERT INTO "${gone.schema}".notes VALUES (1);`);
    await dropIsolation(ADMIN, gone.schema, gone.role);
    expect(await hasSchema(gone.schema)).toBe(false);
    expect(await hasRole(gone.role)).toBe(false);
    expect(await hasSchema(keep.schema)).toBe(true);
  });

  it("slug", () => {
    expect(slug("Todo Clock!")).toBe("todo_clock");
    expect(slug("---")).toBe("project");
  });
});
