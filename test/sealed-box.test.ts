import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import { sealedBox } from "../src/worker/sealed-box";

describe("sealedBox", () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  it("совместим с libsodium crypto_box_seal_open (так GitHub расшифровывает секреты)", async () => {
    const { publicKey, privateKey } = sodium.crypto_box_keypair();
    const message = new TextEncoder().encode("cf-token-🔑-значение");

    const sealed = await sealedBox(message, publicKey);
    const opened = sodium.crypto_box_seal_open(sealed, publicKey, privateKey);

    expect(new TextDecoder().decode(opened)).toBe("cf-token-🔑-значение");
  });

  it("каждый раз использует новый эфемерный ключ", async () => {
    const { publicKey } = sodium.crypto_box_keypair();
    const message = new TextEncoder().encode("same");
    const a = await sealedBox(message, publicKey);
    const b = await sealedBox(message, publicKey);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
