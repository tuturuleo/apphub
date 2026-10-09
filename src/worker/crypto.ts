// Шифрование токенов провайдеров перед записью в D1 (AES-256-GCM).

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const keys = new Map<string, Promise<CryptoKey>>();

/**
 * Ключ: 32 байта в base64 (openssl rand -base64 32) — как есть; любая другая строка от 32 символов — фраза,
 * из неё ключ получается через SHA-256. Так ключ можно задать и в форме кнопки «Deploy to Cloudflare».
 */
function importKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = deriveKey(secret);
    keys.set(secret, key);
  }
  return key;
}

function base64Key(secret: string): Uint8Array<ArrayBuffer> | null {
  try {
    const decoded = fromBase64(secret.trim());
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null; // не base64 — значит, фраза
  }
}

/** Годится ли ключ: 32 байта в base64 или фраза от 32 символов — но не пример из .dev.vars.example. */
export function encryptionKeyOk(secret: string | undefined): boolean {
  if (!secret || /replace|change-me|example/i.test(secret)) return false;
  return !!base64Key(secret) || secret.length >= 32;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (!encryptionKeyOk(secret)) {
    throw new Error("ENCRYPTION_KEY не задан, остался примером или короче 32 символов — задайте случайный ключ");
  }
  const raw =
    base64Key(secret) ??
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`apphub:${secret}`)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(plaintext: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `v1.${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decrypt(payload: string, keyB64: string): Promise<string> {
  const [version, ivB64, ctB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !ctB64) throw new Error("Неизвестный формат шифротекста");
  const key = await importKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(ivB64) }, key, fromBase64(ctB64));
  return new TextDecoder().decode(pt);
}
