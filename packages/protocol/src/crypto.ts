/**
 * E2E crypto for share-context-mcp v1 (spec §5.5/§5.6/§5.9):
 * - channel key: HKDF-SHA256(password, salt=channelId, info="share-context-mcp/v1", 32 bytes)
 * - message sealing: AES-256-GCM, random 12-byte nonce, base64 output
 * - member auth: HMAC-SHA256 challenge-response proof
 * Only node:crypto; no external dependencies.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { ClaimMessage } from "./schema";

const HKDF_INFO = "share-context-mcp/v1";
const KEY_LEN = 32;
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16;

/** Derive the 32-byte channel key from a human-shareable password. */
export function deriveChannelKey(password: string, channelId: string): Uint8Array {
  const ikm = Buffer.from(password, "utf8");
  const salt = Buffer.from(channelId, "utf8");
  const info = Buffer.from(HKDF_INFO, "utf8");
  const derived = hkdfSync("sha256", ikm, salt, info, KEY_LEN);
  return new Uint8Array(derived);
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_LEN) {
    throw new Error(`channel key must be ${KEY_LEN} bytes (got ${key.length})`);
  }
}

/**
 * Sealed envelope — WIRE FORMAT LOCKED (controller ruling on F-5):
 * field names are `nonce` and `ciphertext`, both base64. Do not rename.
 */
export interface SealedEnvelope {
  /** base64 of the 12-byte AES-GCM nonce */
  nonce: string;
  /** base64 of ciphertext || 16-byte auth tag */
  ciphertext: string;
}

/** Seal a claim message: JSON-serialize, AES-256-GCM encrypt, base64 output. */
export function seal(msg: ClaimMessage, key: Uint8Array): SealedEnvelope {
  assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  const plaintext = Buffer.from(JSON.stringify(msg), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([ciphertext, tag]).toString("base64"),
  };
}

/**
 * Open a sealed envelope back into a ClaimMessage. Envelope fields are the
 * locked wire format: `nonce` and `ciphertext`, both base64 (see SealedEnvelope).
 * Throws Error("decrypt failed") on auth-tag failure or malformed payload —
 * never leak why (tampered key/ciphertext vs. garbage are indistinguishable).
 */
export function open(env: { nonce: string; ciphertext: string }, key: Uint8Array): ClaimMessage {
  assertKey(key);
  try {
    const nonce = Buffer.from(env.nonce, "base64");
    const blob = Buffer.from(env.ciphertext, "base64");
    if (nonce.length !== NONCE_LEN || blob.length < AUTH_TAG_LEN) {
      throw new Error("bad envelope");
    }
    const tag = blob.subarray(blob.length - AUTH_TAG_LEN);
    const ciphertext = blob.subarray(0, blob.length - AUTH_TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as ClaimMessage;
  } catch {
    throw new Error("decrypt failed");
  }
}

/**
 * Challenge-response proof of key possession without revealing the key:
 * base64(HMAC-SHA256(key, raw nonce bytes decoded from nonceB64)).
 */
export function hmacProof(key: Uint8Array, nonceB64: string): string {
  assertKey(key);
  return createHmac("sha256", Buffer.from(key))
    .update(Buffer.from(nonceB64, "base64"))
    .digest("base64");
}

export { idempotencyKey } from "./schema";
export type { ClaimKind, ClaimMessage, ClaimProvenance, ClaimSource } from "./schema";
