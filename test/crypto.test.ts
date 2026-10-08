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
    await expect(encrypt("x", randomBytes(16).toString("base64"))).rejects.toThrow(/32 байта/);
  });
});
