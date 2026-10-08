// libsodium crypto_box_seal — формат, в котором GitHub принимает секреты Actions.
// X25519 считается нативно через WebCrypto (дёшево по CPU на бесплатном тарифе Workers),
// HSalsa20 + XSalsa20-Poly1305 — через tweetnacl, nonce — blake2b(epk || pk).
import nacl from "tweetnacl";
import { blake2b } from "@noble/hashes/blake2.js";

type HSalsa20 = (out: Uint8Array, inp: Uint8Array, k: Uint8Array, c: Uint8Array) => number;
const hsalsa20 = (nacl as unknown as { lowlevel: { crypto_core_hsalsa20: HSalsa20 } }).lowlevel
  .crypto_core_hsalsa20;

// "expand 32-byte k"
const SIGMA = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export async function sealedBox(message: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array> {
  if (recipientPublicKey.length !== 32) throw new Error("Публичный ключ X25519 должен быть 32 байта");

  const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephPublic = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  const recipient = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(recipientPublicKey),
    { name: "X25519" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "X25519", public: recipient } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0], eph.privateKey, 256),
  );

  // crypto_box_beforenm: k = HSalsa20(shared, 0)
  const k = new Uint8Array(32);
  hsalsa20(k, new Uint8Array(16), shared, SIGMA);

  const nonce = blake2b(concat(ephPublic, recipientPublicKey), { dkLen: 24 });
  return concat(ephPublic, nacl.secretbox(message, nonce, k));
}
