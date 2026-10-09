// Встроенная авторизация apphub: один владелец, вход по passkey (WebAuthn), сессия в cookie, токены для MCP.
// Первый passkey (и восстановление доступа) — только с кодом установки (секрет SETUP_CODE).
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { fromBase64, toBase64 } from "./crypto";
import type { AppEnv } from "./env";

const SESSION_COOKIE = "apphub_session";
const SESSION_DAYS = 30;
const CHALLENGE_MINUTES = 5;
// Пользователь один — фиксированный id для WebAuthn
const OWNER_ID = new Uint8Array(new TextEncoder().encode("apphub-owner"));

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 = 401,
  ) {
    super(message);
  }
}

// --- утилиты ---

function randomToken(bytes = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, (c) =>
    c === "+" ? "-" : c === "/" ? "_" : "",
  );
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64(new Uint8Array(digest));
}

/** Сравнение строк без утечки по времени — для кода установки. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = Context<{ Bindings: AppEnv; Variables: any }, any>;

/**
 * Адрес, на котором пользователь открыл apphub. За прокси (доступ без VPN через Render) настоящий адрес приходит
 * в X-Forwarded-Host — доверяем ему, только если прокси подтвердил себя секретом PROXY_SECRET.
 */
export function publicOrigin(c: Ctx): { origin: string; rpID: string } {
  const url = new URL(c.req.url);
  const secret = c.env.PROXY_SECRET;
  const forwarded = c.req.header("X-Forwarded-Host");
  if (secret && forwarded && safeEqual(c.req.header("X-Apphub-Proxy") ?? "", secret)) {
    return { origin: `https://${forwarded}`, rpID: forwarded.split(":")[0] };
  }
  return { origin: url.origin, rpID: url.hostname };
}

// --- состояние ---

async function passkeyCount(env: AppEnv): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_passkeys").first<{ n: number }>();
  return row?.n ?? 0;
}

async function sessionValid(env: AppEnv, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const row = await env.DB.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?")
    .bind(await sha256(token))
    .first<{ expires_at: number }>();
  return !!row && row.expires_at > Date.now();
}

async function tokenValid(env: AppEnv, token: string): Promise<boolean> {
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT id FROM api_tokens WHERE token_hash = ?").bind(hash).first<{ id: string }>();
  if (!row) return false;
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
  return true;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Дополнительный способ: Cloudflare Access перед apphub (если настроен). */
async function accessValid(c: Ctx): Promise<boolean> {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!team || !aud || !token) return false;
  let jwks = jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, jwks);
  }
  try {
    await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud });
    return true;
  } catch {
    return false;
  }
}

export async function authState(c: Ctx) {
  return {
    configured: (await passkeyCount(c.env)) > 0,
    authenticated: await isAuthenticated(c),
    devNoAuth: c.env.DEV_ALLOW_NO_AUTH === "true",
    setupCodeSet: !!c.env.SETUP_CODE,
  };
}

async function isAuthenticated(c: Ctx): Promise<boolean> {
  if (c.env.DEV_ALLOW_NO_AUTH === "true") return true;
  const bearer = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer && (await tokenValid(c.env, bearer.trim()))) return true;
  if (await sessionValid(c.env, getCookie(c, SESSION_COOKIE))) return true;
  return accessValid(c);
}

/** Вход и первичная настройка — доступны без сессии. */
const PUBLIC_PATHS = new Set([
  "/api/auth/state",
  "/api/auth/register/options",
  "/api/auth/register/verify",
  "/api/auth/login/options",
  "/api/auth/login/verify",
  "/api/auth/logout",
]);

/**
 * Доступ к API и MCP: токен (Bearer), сессия владельца или Cloudflare Access.
 * Для запросов с cookie, меняющих данные, — проверка Origin (защита от CSRF).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const requireAuth = createMiddleware<{ Bindings: AppEnv; Variables: any }>(async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();
  if (!(await isAuthenticated(c))) return c.json({ error: "Нужно войти", auth: true }, 401);

  const viaCookie =
    !c.req.header("Authorization") && c.env.DEV_ALLOW_NO_AUTH !== "true" && !!getCookie(c, SESSION_COOKIE);
  if (viaCookie && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (!origin || origin !== publicOrigin(c).origin) {
      return c.json({ error: "Запрос с чужого сайта отклонён" }, 403);
    }
  }
  return next();
});

// --- сессии ---

async function startSession(c: Ctx): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO auth_sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256(token), now, now + SESSION_DAYS * 86_400_000, c.req.header("User-Agent")?.slice(0, 200) ?? null)
    .run();
  const { origin } = publicOrigin(c);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: origin.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function logout(c: Ctx): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token)
    await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
      .bind(await sha256(token))
      .run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

// --- WebAuthn ---

/** Библиотека бросает обычные ошибки (чужой адрес, неверная подпись) — отдаём их как отказ во входе. */
async function rejectAs<T>(status: 400 | 401, message: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    console.warn("WebAuthn:", e instanceof Error ? e.message : e);
    throw new AuthError(message, status);
  }
}

async function saveChallenge(env: AppEnv, challenge: string, kind: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO auth_challenges (id, challenge, kind, expires_at) VALUES (?, ?, ?, ?)").bind(
      id,
      challenge,
      kind,
      Date.now() + CHALLENGE_MINUTES * 60_000,
    ),
  ]);
  return id;
}

/** Одноразовый: вызов challenge удаляет его. */
async function takeChallenge(env: AppEnv, id: string, kind: string): Promise<string> {
  const row = await env.DB.prepare("SELECT challenge, kind, expires_at FROM auth_challenges WHERE id = ?")
    .bind(id)
    .first<{ challenge: string; kind: string; expires_at: number }>();
  await env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(id).run();
  if (!row || row.kind !== kind || row.expires_at < Date.now())
    throw new AuthError("Попытка устарела — начните заново", 400);
  return row.challenge;
}

/**
 * Регистрация passkey. Первый — и восстановление на новом адресе или после потери — только с кодом установки;
 * дополнительный при уже открытой сессии — без кода.
 */
export async function registrationOptions(c: Ctx, setupCode: string | undefined) {
  const hasPasskeys = (await passkeyCount(c.env)) > 0;
  const loggedIn = hasPasskeys && (await isAuthenticated(c)) && c.env.DEV_ALLOW_NO_AUTH !== "true";
  if (!loggedIn) {
    if (!c.env.SETUP_CODE) throw new AuthError("Не задан код установки (секрет SETUP_CODE)", 403);
    if (!setupCode || !safeEqual(setupCode.trim(), c.env.SETUP_CODE))
      throw new AuthError("Неверный код установки", 403);
  }
  const { rpID } = publicOrigin(c);
  const existing = await c.env.DB.prepare("SELECT id, transports FROM auth_passkeys WHERE rp_id = ?")
    .bind(rpID)
    .all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: "apphub",
    rpID,
    userName: "owner",
    userDisplayName: "Владелец apphub",
    userID: OWNER_ID,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    excludeCredentials: existing.results.map((p) => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
  });
  return { challengeId: await saveChallenge(c.env, options.challenge, "register"), options };
}

export async function registrationVerify(
  c: Ctx,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string,
) {
  const expectedChallenge = await takeChallenge(c.env, challengeId, "register");
  const { origin, rpID } = publicOrigin(c);
  const result = await rejectAs(
    400,
    "Passkey не подтверждён",
    verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    }),
  );
  if (!result.verified) throw new AuthError("Passkey не подтверждён", 400);
  const { credential } = result.registrationInfo;
  await c.env.DB.prepare(
    "INSERT INTO auth_passkeys (id, public_key, counter, transports, rp_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      credential.id,
      toBase64(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      rpID,
      name.trim().slice(0, 60) || "Passkey",
      Date.now(),
    )
    .run();
  await startSession(c);
}

export async function authenticationOptions(c: Ctx) {
  const { rpID } = publicOrigin(c);
  // Пустой allowCredentials: браузер сам предложит подходящий passkey (discoverable credentials)
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  return { challengeId: await saveChallenge(c.env, options.challenge, "login"), options };
}

export async function authenticationVerify(c: Ctx, challengeId: string, response: AuthenticationResponseJSON) {
  const expectedChallenge = await takeChallenge(c.env, challengeId, "login");
  const passkey = await c.env.DB.prepare("SELECT * FROM auth_passkeys WHERE id = ?")
    .bind(response.id)
    .first<{ id: string; public_key: string; counter: number; transports: string | null; rp_id: string }>();
  if (!passkey) throw new AuthError("Этот passkey не зарегистрирован в apphub", 401);
  const { origin, rpID } = publicOrigin(c);
  const result = await rejectAs(
    401,
    "Вход не подтверждён",
    verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: fromBase64(passkey.public_key),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
      requireUserVerification: false,
    }),
  );
  if (!result.verified) throw new AuthError("Вход не подтверждён", 401);
  await c.env.DB.prepare("UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(result.authenticationInfo.newCounter, Date.now(), passkey.id)
    .run();
  await startSession(c);
}

// --- управление: passkeys и токены MCP ---

export async function listPasskeys(env: AppEnv) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, rp_id, created_at, last_used_at FROM auth_passkeys ORDER BY created_at",
  ).all<{ id: string; name: string; rp_id: string; created_at: number; last_used_at: number | null }>();
  return results.map((p) => ({
    id: p.id,
    name: p.name,
    rpId: p.rp_id,
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
  }));
}

export async function deletePasskey(env: AppEnv, id: string): Promise<void> {
  if ((await passkeyCount(env)) <= 1)
    throw new AuthError("Нельзя удалить последний passkey — иначе войти будет нечем", 400);
  await env.DB.prepare("DELETE FROM auth_passkeys WHERE id = ?").bind(id).run();
}

export async function listTokens(env: AppEnv) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC",
  ).all<{ id: string; name: string; created_at: number; last_used_at: number | null }>();
  return results.map((t) => ({ id: t.id, name: t.name, createdAt: t.created_at, lastUsedAt: t.last_used_at }));
}

/** Токен показывается один раз; в базе — только хеш. */
export async function createToken(env: AppEnv, name: string): Promise<{ id: string; token: string }> {
  const token = `ah_${randomToken()}`;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, name.trim().slice(0, 60) || "MCP", await sha256(token), Date.now())
    .run();
  return { id, token };
}

export async function deleteToken(env: AppEnv, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM api_tokens WHERE id = ?").bind(id).run();
}
