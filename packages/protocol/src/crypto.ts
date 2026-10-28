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

// ---- self-contained admission credentials & invite codes (governance §) ----
//
// The message key NEVER derives from the admission credential: it is created
// random and travels WRAPPED inside the credential. Consequences:
// - credential rotation ("access" rotate) re-wraps the SAME message key —
//   existing members are unaffected (they already hold the key);
// - a kicked member's old credential is dead at the relay AND its unwrapped
//   knowledge cannot admit anyone.

const CREDENTIAL_PREFIX = "scmc1";
const CRED_WRAP_INFO = "share-context-mcp/admit-wrap";

function b32(buf: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(s: string): Uint8Array {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const clean = s.toLowerCase().replace(/-/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) throw new Error("credential: invalid character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/**
 * Mint an admission credential for a password-tier channel: a human-copyable
 * string whose only contents are a random wrap secret and the channel key
 * encrypted under it. The relay sees just HMAC(wrappedVerifyKey, nonce) —
 * the key itself stays opaque. Returns the credential and the verify key to
 * register at the relay.
 */
export function mintAdmissionCredential(channelKey: Uint8Array): { credential: string; verifyKeyB64: string } {
  assertKey(channelKey);
  const ws = randomBytes(32);
  const wrapKey = new Uint8Array(hkdfSync("sha256", ws, new Uint8Array(0), Buffer.from(CRED_WRAP_INFO), KEY_LEN));
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(channelKey)), cipher.final(), cipher.getAuthTag()]);
  const credential = `${CREDENTIAL_PREFIX}-${b32(Buffer.concat([ws, nonce, ct]))}`
    .replace(/(.{5})/g, "$1-")
    .replace(/-$/, "");
  const verifyKeyB64 = Buffer.from(createHmac("sha256", Buffer.from(channelKey)).update("verify").digest()).toString("base64");
  return { credential, verifyKeyB64 };
}

/** Parse + unwrap: channel key from a minted admission credential. */
export function parseAdmissionCredential(credential: string): Uint8Array {
  const raw = b32decode(credential.replace(new RegExp(`^${CREDENTIAL_PREFIX}-`), "").replace(/-/g, ""));
  if (raw.length < 32 + NONCE_LEN + AUTH_TAG_LEN) throw new Error("credential: too short");
  const ws = raw.slice(0, 32);
  const nonce = raw.slice(32, 32 + NONCE_LEN);
  const data = raw.slice(32 + NONCE_LEN);
  const ct = data.slice(0, data.length - AUTH_TAG_LEN);
  const tag = data.slice(data.length - AUTH_TAG_LEN);
  const wrapKey = new Uint8Array(hkdfSync("sha256", ws, new Uint8Array(0), Buffer.from(CRED_WRAP_INFO), KEY_LEN));
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, nonce);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]));
}

/**
 * Mint a single-use invite code (invite tier): same self-contained shape,
 * plus the code id and expiry so the relay ledger can gate admission.
 */
export function mintInviteCode(
  channelKey: Uint8Array,
  codeId: string,
  ttlMs: number,
): { code: string; codeId: string; expiresAt: number } {
  const ws = randomBytes(32);
  const wrapKey = new Uint8Array(hkdfSync("sha256", ws, new Uint8Array(0), Buffer.from(CRED_WRAP_INFO), KEY_LEN));
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
  const expiresAt = Date.now() + ttlMs;
  const payload = Buffer.from(JSON.stringify({ key: Buffer.from(channelKey).toString("base64"), exp: expiresAt }), "utf8");  const ct = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  // codeId is fixed-width (16 bytes, NUL-padded) so the round trip is exact
  // for arbitrary ids ≤ 16 chars.
  const idBuf = Buffer.alloc(16);
  idBuf.write(codeId, 0, "utf8");
  const code = `${CREDENTIAL_PREFIX}-${b32(Buffer.concat([idBuf, ws, nonce, ct]))}`;
  return { code, codeId, expiresAt };
}

/** Parse an invite code: code id (for the relay ledger) + unwrapped channel key. */
export function parseInviteCode(code: string): { codeId: string; channelKey: Uint8Array; expiresAt: number | null } {
  const raw = b32decode(code.replace(new RegExp(`^${CREDENTIAL_PREFIX}-`), ""));
  const idLen = 16;
  if (raw.length < idLen + 32 + NONCE_LEN + AUTH_TAG_LEN) throw new Error("invite code: too short");
  const codeId = Buffer.from(raw.slice(0, idLen)).toString("utf8").replace(/\0+$/, "");
  const ws = raw.slice(idLen, idLen + 32);
  const nonce = raw.slice(idLen + 32, idLen + 32 + NONCE_LEN);
  const data = raw.slice(idLen + 32 + NONCE_LEN);
  const ct = data.slice(0, data.length - AUTH_TAG_LEN);
  const tag = data.slice(data.length - AUTH_TAG_LEN);
  const wrapKey = new Uint8Array(hkdfSync("sha256", ws, new Uint8Array(0), Buffer.from(CRED_WRAP_INFO), KEY_LEN));
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, nonce);
  decipher.setAuthTag(tag);
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]).toString("utf8")) as {
    key: string;
    exp?: number;
  };
  return { codeId, channelKey: new Uint8Array(Buffer.from(payload.key, "base64")), expiresAt: payload.exp ?? null };
}

export { idempotencyKey } from "./schema";
export type { ClaimKind, ClaimMessage, ClaimProvenance, ClaimSource } from "./schema";
