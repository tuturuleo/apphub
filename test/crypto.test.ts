import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/worker/crypto";

const key = randomBytes(32).toString("base64");

describe("encrypt/decrypt", () => {
  it("расшифровывает то, что зашифровал", async () => {
    const payload = await encrypt("ghp_secret", key);
    expect(payload).not.toContain("ghp_secret");
    expect(await decrypt(payload, key)).toBe("ghp_secret");
  });

  it("не расшифровывает чужим ключом", async () => {
    const payload = await encrypt("ghp_secret", key);
    await expect(decrypt(payload, randomBytes(32).toString("base64"))).rejects.toThrow();
  });

  it("отклоняет ключ неправильной длины", async () => {
    await expect(encrypt("x", randomBytes(16).toString("base64"))).rejects.toThrow(/ENCRYPTION_KEY/);
  });
});

describe("ключ-фраза", () => {
  it("шифрует фразой от 32 символов и не принимает короткую", async () => {
    const { encrypt, decrypt } = await import("../src/worker/crypto");
    const phrase = "correct horse battery staple and more words";
    expect(await decrypt(await encrypt("token", phrase), phrase)).toBe("token");
    await expect(encrypt("token", "short")).rejects.toThrow(/32/);
  });
});

describe("примеры вместо секретов", () => {
  it("ключ-пример и пустой ключ не принимаются", async () => {
    const { encrypt, encryptionKeyOk } = await import("../src/worker/crypto");
    expect(encryptionKeyOk("replace-with-openssl-rand-base64-32")).toBe(false);
    expect(encryptionKeyOk("")).toBe(false);
    expect(encryptionKeyOk(randomBytes(32).toString("base64"))).toBe(true);
    await expect(encrypt("x", "replace-with-openssl-rand-base64-32")).rejects.toThrow(/примером/);
  });
});
