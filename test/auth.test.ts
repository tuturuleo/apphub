import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import * as auth from "../src/worker/auth";
import type { AppEnv } from "../src/worker/env";

// Минимальная замена D1 поверх встроенного SQLite в Node — хватает для таблиц авторизации.
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0007_auth.sql", "utf8"));
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (db.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => db.prepare(sql).run(...(args as never[])),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: { run(): Promise<unknown> }[]) => Promise.all(list.map((s) => s.run())),
  } as unknown as D1Database;
}

let env: AppEnv;

function app() {
  const a = new Hono<{ Bindings: AppEnv; Variables: Record<string, never> }>().basePath("/api");
  a.use("*", auth.requireAuth);
  a.onError((err, c) =>
    err instanceof auth.AuthError ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500),
  );
  a.get("/auth/state", async (c) => c.json(await auth.authState(c)));
  a.post("/auth/register/options", async (c) =>
    c.json(await auth.registrationOptions(c, ((await c.req.json()) as { setupCode?: string }).setupCode)),
  );
  a.post("/auth/register/verify", async (c) => {
    const b = (await c.req.json()) as { challengeId: string; response: never };
    await auth.registrationVerify(c, b.challengeId, b.response, "test");
    return c.json({ ok: true });
  });
  a.post("/auth/login/options", async (c) => c.json(await auth.authenticationOptions(c)));
  a.post("/auth/login/verify", async (c) => {
    const b = (await c.req.json()) as { challengeId: string; response: never };
    await auth.authenticationVerify(c, b.challengeId, b.response);
    return c.json({ ok: true });
  });
  a.get("/projects", (c) => c.json([]));
  a.post("/projects", (c) => c.json({ ok: true }));
  return a;
}

const call = (path: string, init: RequestInit = {}) => app().request(`https://hub.example.com/api${path}`, init, env);

beforeEach(() => {
  env = { DB: fakeD1(), SETUP_CODE: "correct-horse", ENCRYPTION_KEY: "x" } as unknown as AppEnv;
});

describe("авторизация", () => {
  it("без входа API закрыт, состояние входа — открыто", async () => {
    expect((await call("/projects")).status).toBe(401);
    const state = (await (await call("/auth/state")).json()) as { configured: boolean; authenticated: boolean };
    expect(state).toMatchObject({ configured: false, authenticated: false });
  });

  it("первый passkey — только с кодом установки", async () => {
    const post = (setupCode: string) =>
      call("/auth/register/options", { method: "POST", body: JSON.stringify({ setupCode }) });
    expect((await post("wrong")).status).toBe(403);
    const ok = await post("correct-horse");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { challengeId: string; options: { rp: { id: string } } };
    expect(body.options.rp.id).toBe("hub.example.com");
  });

  it("без SETUP_CODE зарегистрироваться нельзя вовсе", async () => {
    env.SETUP_CODE = undefined;
    const res = await call("/auth/register/options", { method: "POST", body: JSON.stringify({ setupCode: "" }) });
    expect(res.status).toBe(403);
  });

  it("токен MCP открывает API, после удаления — нет; в базе только хеш", async () => {
    const { id, token } = await auth.createToken(env, "Claude Code");
    expect(token).toMatch(/^ah_/);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await call("/projects", { headers })).status).toBe(200);
    expect((await call("/projects", { method: "POST", headers })).status).toBe(200);
    const stored = await env.DB.prepare("SELECT token_hash FROM api_tokens").first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toContain(token);
    await auth.deleteToken(env, id);
    expect((await call("/projects", { headers })).status).toBe(401);
  });

  it("сессия: изменения только с нашего Origin", async () => {
    const token = "session-token";
    await env.DB.prepare("INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .bind(await auth.sha256(token), Date.now(), Date.now() + 60_000)
      .run();
    const cookie = `apphub_session=${token}`;
    expect((await call("/projects", { headers: { cookie } })).status).toBe(200);
    expect((await call("/projects", { method: "POST", headers: { cookie } })).status).toBe(403);
    expect(
      (await call("/projects", { method: "POST", headers: { cookie, Origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect(
      (await call("/projects", { method: "POST", headers: { cookie, Origin: "https://hub.example.com" } })).status,
    ).toBe(200);
  });

  it("истёкшая сессия не действует", async () => {
    await env.DB.prepare("INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .bind(await auth.sha256("old"), 0, Date.now() - 1)
      .run();
    expect((await call("/projects", { headers: { cookie: "apphub_session=old" } })).status).toBe(401);
  });

  it("адрес за прокси принимается только с секретом прокси", async () => {
    env.PROXY_SECRET = "proxy-secret";
    const options = async (headers: Record<string, string>) =>
      (
        (await (
          await call("/auth/register/options", {
            method: "POST",
            headers,
            body: JSON.stringify({ setupCode: "correct-horse" }),
          })
        ).json()) as { options: { rp: { id: string } } }
      ).options.rp.id;
    expect(await options({ "X-Forwarded-Host": "hub.onrender.com" })).toBe("hub.example.com");
    expect(await options({ "X-Forwarded-Host": "hub.onrender.com", "X-Apphub-Proxy": "nope" })).toBe("hub.example.com");
    expect(await options({ "X-Forwarded-Host": "hub.onrender.com", "X-Apphub-Proxy": "proxy-secret" })).toBe(
      "hub.onrender.com",
    );
  });

  it("последний passkey удалить нельзя", async () => {
    await env.DB.prepare(
      "INSERT INTO auth_passkeys (id, public_key, counter, rp_id, name, created_at) VALUES ('k1', 'pk', 0, 'x', 'n', 0)",
    ).run();
    await expect(auth.deletePasskey(env, "k1")).rejects.toThrow(/последний/);
  });
});

// Программный passkey (ключ P-256, аттестация none) — проверяем настоящую криптографию WebAuthn без браузера.
class SoftAuthenticator {
  private keys!: CryptoKeyPair;
  readonly id = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)));
  private count = 0;

  constructor(
    private rpID: string,
    private origin: string,
  ) {}

  private async authData(attested: boolean): Promise<Uint8Array<ArrayBuffer>> {
    const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.rpID)));
    const flags = attested ? 0x45 : 0x05; // UP + UV (+ AT)
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, ++this.count);
    const parts: Uint8Array[] = [rpHash, new Uint8Array([flags]), counter];
    if (attested) {
      const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, isoBase64URL.toBuffer(jwk.x!)],
          [-3, isoBase64URL.toBuffer(jwk.y!)],
        ]),
      );
      const credId = isoBase64URL.toBuffer(this.id);
      parts.push(new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cose);
    }
    return concat(parts);
  }

  private clientData(type: string, challenge: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  async create(challenge: string) {
    this.keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", await this.authData(true)],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(this.clientData("webauthn.create", challenge)),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
    };
  }

  async get(challenge: string) {
    const authData = await this.authData(false);
    const clientData = this.clientData("webauthn.get", challenge);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientData));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, concat([authData, hash])),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(derSignature(raw)),
      },
    };
  }
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** WebCrypto подписывает в формате r||s, WebAuthn ждёт DER. */
function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    return v[0] & 0x80 ? concat([new Uint8Array([0]), v]) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat([
    new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length]),
    r,
    new Uint8Array([0x02, s.length]),
    s,
  ]);
}

describe("passkey целиком", () => {
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const sessionCookie = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

  it("регистрация с кодом → вход → доступ к API; чужой адрес не принимается", async () => {
    const key = new SoftAuthenticator("hub.example.com", "https://hub.example.com");
    const reg = (await (await call("/auth/register/options", json({ setupCode: "correct-horse" }))).json()) as {
      challengeId: string;
      options: { challenge: string };
    };
    const created = await key.create(reg.options.challenge);
    const regRes = await call("/auth/register/verify", json({ challengeId: reg.challengeId, response: created }));
    expect(regRes.status).toBe(200);
    expect(sessionCookie(regRes)).toMatch(/^apphub_session=/);
    expect(regRes.headers.get("set-cookie")).toMatch(/HttpOnly/i);

    // тот же challenge второй раз не принимается
    const replay = await call("/auth/register/verify", json({ challengeId: reg.challengeId, response: created }));
    expect(replay.status).toBe(400);

    const login = (await (await call("/auth/login/options", json({}))).json()) as {
      challengeId: string;
      options: { challenge: string };
    };
    const loginRes = await call(
      "/auth/login/verify",
      json({ challengeId: login.challengeId, response: await key.get(login.options.challenge) }),
    );
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookie(loginRes);
    expect((await call("/projects", { headers: { cookie } })).status).toBe(200);

    // подпись для другого сайта (фишинговый адрес) — отказ
    const phish = new SoftAuthenticator("hub.example.com", "https://evil.example");
    Object.assign(phish, { keys: (key as unknown as { keys: CryptoKeyPair }).keys, id: key.id, count: 10 });
    const again = (await (await call("/auth/login/options", json({}))).json()) as {
      challengeId: string;
      options: { challenge: string };
    };
    const bad = await call(
      "/auth/login/verify",
      json({ challengeId: again.challengeId, response: await phish.get(again.options.challenge) }),
    );
    expect(bad.status).toBe(401);
  });
});
