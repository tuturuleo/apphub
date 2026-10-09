// Клиент Google Drive через сервисный аккаунт: JWT подписывается ключом аккаунта (WebCrypto, RS256)
// и обменивается на access token. Аккаунт видит только файлы, которыми с ним поделились.
import { fromBase64 } from "../crypto";
import { ProviderError } from "./errors";
import { providerFetch } from "./http";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink: string;
}

/** Разбирает JSON-ключ сервисного аккаунта; понятная ошибка, если вставили не то. */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let key: Partial<ServiceAccountKey> & { type?: string };
  try {
    key = JSON.parse(raw.trim());
  } catch {
    throw new Error("Это не JSON. Вставьте содержимое файла ключа сервисного аккаунта целиком.");
  }
  if (key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new Error("Нужен JSON-ключ сервисного аккаунта (в нём есть type: service_account, client_email, private_key).");
  }
  return key as ServiceAccountKey;
}

const base64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** JWT для обмена на токен Google (RFC 7523): подпись RS256 закрытым ключом сервисного аккаунта. */
export async function signServiceAccountJwt(key: ServiceAccountKey, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const pem = key.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

export class GoogleDrive {
  private accessToken: string | null = null;
  readonly key: ServiceAccountKey;

  constructor(rawKey: string) {
    this.key = parseServiceAccountKey(rawKey);
  }

  get email(): string {
    return this.key.client_email;
  }

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const res = await providerFetch("Google", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: await signServiceAccountJwt(this.key),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      throw new ProviderError(`Google: не удалось получить токен: ${data.error_description ?? res.status}`, res.status);
    }
    this.accessToken = data.access_token;
    return data.access_token;
  }

  private async request<T>(path: string): Promise<T> {
    const res = await providerFetch("Google", `https://www.googleapis.com/drive/v3${path}`, {
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new ProviderError(`Google Drive ${path.split("?")[0]}: ${res.status} ${data.error?.message ?? ""}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** Таблицы, которыми поделились с сервисным аккаунтом, — свежие первыми. */
  async listSpreadsheets(): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      q: `mimeType='${SPREADSHEET_MIME}' and trashed=false`,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      orderBy: "modifiedTime desc",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    return (await this.request<{ files: DriveFile[] }>(`/files?${params}`)).files;
  }

  async getFile(id: string): Promise<DriveFile> {
    return this.request(`/files/${id}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`);
  }
}
