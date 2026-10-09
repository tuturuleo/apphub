import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServiceAccountKey, signServiceAccountJwt } from "../src/worker/providers/google";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keyJson = JSON.stringify({ type: "service_account", client_email: "apphub@proj.iam.gserviceaccount.com", private_key: pem });

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("Google service account", () => {
  it("JWT подписан RS256 и проверяется открытым ключом", async () => {
    const jwt = await signServiceAccountJwt(parseServiceAccountKey(keyJson), 1_800_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toMatchObject({
      iss: "apphub@proj.iam.gserviceaccount.com",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("понятно ругается на не тот JSON", () => {
    expect(() => parseServiceAccountKey("hello")).toThrow(/не JSON/);
    expect(() => parseServiceAccountKey('{"type":"authorized_user"}')).toThrow(/сервисного аккаунта/);
  });
});
