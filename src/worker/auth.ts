// Доступ к apphub закрывается Cloudflare Access: проверяем JWT из заголовка Cf-Access-Jwt-Assertion.
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppEnv } from "./env";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const requireAccess = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;

  if (!team || !aud) {
    if (c.env.DEV_ALLOW_NO_AUTH === "true") return next();
    return c.json(
      { error: "Доступ не настроен: задайте ACCESS_TEAM_DOMAIN и ACCESS_AUD (или DEV_ALLOW_NO_AUTH=true локально)" },
      503,
    );
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "Нет токена Cloudflare Access" }, 401);

  let jwks = jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, jwks);
  }
  try {
    await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud });
  } catch {
    return c.json({ error: "Недействительный токен Cloudflare Access" }, 401);
  }
  return next();
});
