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
  createHash,
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
/** Canonical admission-verify key: HMAC-SHA256(channelKey, "verify"), base64.
 *  Single source of truth — the bridge, mint and CLI all share this. */
export function deriveVerifyKeyB64(channelKey: Uint8Array): string {
  assertKey(channelKey);
  return Buffer.from(createHmac("sha256", Buffer.from(channelKey)).update("verify").digest()).toString("base64");
}

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

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function b32(buf: Uint8Array): string {
  const alphabet = B32_ALPHABET;
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
  const alphabet = B32_ALPHABET;
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
interface WrappedBlob {
  ws: Uint8Array;
  nonce: Uint8Array;
  ct: Uint8Array;
}

function wrapWith(ws: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const wrapKey = new Uint8Array(hkdfSync("sha256", ws, new Uint8Array(0), Buffer.from(CRED_WRAP_INFO), KEY_LEN));
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
  // nonce IS the blob prefix — unwrapWith reads it from there.
  return Buffer.concat([nonce, cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
}

function unwrapWith(ws: Uint8Array, blob: Uint8Array): Uint8Array {
  const wrapKey = new Uint8Array(hkdfSync("sha256", ws, new Uint8Array(0), Buffer.from(CRED_WRAP_INFO), KEY_LEN));
  const nonce = blob.slice(0, NONCE_LEN);
  const data = blob.slice(NONCE_LEN);
  const ct = data.slice(0, data.length - AUTH_TAG_LEN);
  const tag = data.slice(data.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, nonce);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]));
}

export function mintAdmissionCredential(channelKey: Uint8Array): { credential: string; verifyKeyB64: string } {
  assertKey(channelKey);
  const ws = randomBytes(32);
  const blob = wrapWith(ws, channelKey);
  const credential = `${CREDENTIAL_PREFIX}-${b32(Buffer.concat([ws, blob]))}`
    .replace(/(.{5})/g, "$1-")
    .replace(/-$/, "");
  return { credential, verifyKeyB64: deriveVerifyKeyB64(channelKey) };
}

/** Parse + unwrap: channel key from a minted admission credential. */
export function parseAdmissionCredential(credential: string): Uint8Array {
  const raw = b32decode(credential.replace(new RegExp(`^${CREDENTIAL_PREFIX}-`), "").replace(/-/g, ""));
  if (raw.length < 32 + NONCE_LEN) throw new Error("credential: too short");
  const ws = raw.slice(0, 32);
  return unwrapWith(ws, raw.slice(32));
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
  assertKey(channelKey);
  const idBytes = Buffer.from(codeId, "utf8");
  if (idBytes.length === 0 || idBytes.length > 16) {
    throw new Error("invite code: codeId must be 1..16 bytes");
  }
  const expiresAt = Date.now() + ttlMs;
  const ws = randomBytes(32);
  const payload = Buffer.from(JSON.stringify({ key: Buffer.from(channelKey).toString("base64"), exp: expiresAt }), "utf8");
  const blob = wrapWith(ws, payload);
  // codeId is fixed-width (16 bytes, NUL-padded) so the round trip is exact
  // for arbitrary ids ≤ 16 chars.
  const idBuf = Buffer.alloc(16);
  idBytes.copy(idBuf);
  const code = `${CREDENTIAL_PREFIX}-${b32(Buffer.concat([idBuf, ws, blob]))}`;
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
  let payload: { key?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct)), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("invite code: malformed payload");
  }
  if (typeof payload.key !== "string") throw new Error("invite code: malformed payload");
  const channelKey = new Uint8Array(Buffer.from(payload.key, "base64"));
  assertKey(channelKey);
  const expiresAt = typeof payload.exp === "number" ? payload.exp : null;
  return { codeId, channelKey, expiresAt };
}

// ---- scmc2 blob envelope (spec §4.1, v3) ----
//
// A unified, tamper-evident, optionally time-limited blob envelope:
//   scmc2-<base32(JSON { v, type, exp?, max?, payload, sum })>
// `sum` is SHA-256 over the canonical body JSON — changing ANY character of
// the base32 body either breaks the decode/parse or the checksum. GCM
// sealing is reserved for relay-executable blobs (protocol-reserved); v1
// client-executable blobs rely on the checksum wall plus relay registry
// backing (invite codes, sealed keys).

export type BLOB_TYPES = "join_password" | "join_invite" | "join_key" | "key_update";

export const BLOB_TYPES: readonly BLOB_TYPES[] = ["join_password", "join_invite", "join_key", "key_update"];

const BLOB_PREFIX = "scmc2-";
const BLOB_VERSION = 1;
/** Hard size bound on the envelope string — parse AND encode both enforce it. */
export const BLOB_MAX_CHARS = 8192;

/** Encoded blob shape: the body string plus its checksum. */
interface BlobEnvelopeInner {
  v: number;
  type: string;
  exp?: number;
  max?: number;
  payload: Record<string, unknown>;
  sum: string;
}

/** True when the envelope's expiry has passed. No expiresAt → never expires. */
export function isBlobExpired(env: { expiresAt?: number }, now: number = Date.now()): boolean {
  return typeof env.expiresAt === "number" && env.expiresAt <= now;
}

/** Blob type names (open-ended registry — v1 ships the four share types). */
export type BlobTypes = BLOB_TYPES;

/** Encode a blob envelope. Throws `invalid blob:` errors on bad input or size overflow. */
export function encodeBlobEnvelope(params: {
  type: string;
  payload: Record<string, unknown>;
  expiresAt?: number;
  maxUses?: number;
}): string {
  if (typeof params.type !== "string" || params.type.length === 0 || params.type.length > 32) {
    throw new Error("invalid blob: type must be a string of 1..32 characters");
  }
  if (typeof params.payload !== "object" || params.payload === null || Array.isArray(params.payload)) {
    throw new Error("invalid blob: payload must be a JSON object");
  }
  if (params.expiresAt !== undefined && (!Number.isFinite(params.expiresAt) || !Number.isInteger(params.expiresAt))) {
    throw new Error("invalid blob: expiresAt must be an integer epoch ms value");
  }
  if (params.maxUses !== undefined && (!Number.isFinite(params.maxUses) || !Number.isInteger(params.maxUses) || params.maxUses < 1)) {
    throw new Error("invalid blob: maxUses must be an integer >= 1");
  }
  const inner: BlobEnvelopeInner = {
    v: BLOB_VERSION,
    type: params.type,
    ...(params.expiresAt !== undefined ? { exp: params.expiresAt } : {}),
    ...(params.maxUses !== undefined ? { max: params.maxUses } : {}),
    payload: params.payload,
    sum: "",
  };
  // Checksum covers EVERY meaningful field (type/exp/max/payload + version):
  // a mutated type or expiry must fail the parse just like a mutated payload.
  const body = JSON.stringify({ ...inner, sum: undefined });
  inner.sum = createHash("sha256").update(body, "utf8").digest("hex");
  const blob = BLOB_PREFIX + b32(Buffer.from(JSON.stringify(inner), "utf8"));
  if (blob.length > BLOB_MAX_CHARS) {
    throw new Error(`invalid blob: encoded size ${blob.length} exceeds the ${BLOB_MAX_CHARS}-character limit`);
  }
  return blob;
}

/** Parse + verify a blob envelope. Throws `invalid blob:` errors on any failure. */
export function parseBlobEnvelope(blob: string): {
  type: string;
  payload: Record<string, unknown>;
  expiresAt?: number;
  maxUses?: number;
} {
  if (typeof blob !== "string" || blob.length === 0) {
    throw new Error("invalid blob: expected a non-empty string");
  }
  const trimmed = blob.trim();
  if (trimmed.length > BLOB_MAX_CHARS) {
    throw new Error(`invalid blob: exceeds the ${BLOB_MAX_CHARS}-character limit`);
  }
  if (!trimmed.startsWith(BLOB_PREFIX)) {
    throw new Error("invalid blob: missing scmc2- prefix");
  }
  let inner: BlobEnvelopeInner;
  try {
    inner = JSON.parse(Buffer.from(b32decode(trimmed.slice(BLOB_PREFIX.length))).toString("utf8")) as BlobEnvelopeInner;
  } catch {
    throw new Error("invalid blob: body is not a decodable envelope");
  }
  if (typeof inner !== "object" || inner === null) throw new Error("invalid blob: body is not a JSON object");
  if (inner.v !== BLOB_VERSION) throw new Error(`invalid blob: unsupported version ${String(inner.v)}`);
  if (typeof inner.type !== "string" || inner.type.length === 0) throw new Error("invalid blob: type missing");
  if (typeof inner.payload !== "object" || inner.payload === null || Array.isArray(inner.payload)) {
    throw new Error("invalid blob: payload must be a JSON object");
  }
  if (typeof inner.sum !== "string" || inner.sum.length !== 64) throw new Error("invalid blob: checksum missing");
  if (
    (inner.exp !== undefined && (!Number.isInteger(inner.exp) || !Number.isFinite(inner.exp))) ||
    (inner.max !== undefined && (!Number.isInteger(inner.max) || !Number.isFinite(inner.max) || inner.max < 1))
  ) {
    throw new Error("invalid blob: malformed expiry or maxUses");
  }
  // Expiry is enforced here — the protocol layer is the one chokepoint every
  // consumer (MCP join, CLI join, future relay-executed blobs) passes through.
  // The relay's invite-code ledger remains as the authoritative backstop.
  if (isBlobExpired({ expiresAt: inner.exp })) {
    throw new Error("invalid blob: envelope expired");
  }
  const body = JSON.stringify({
    v: inner.v,
    type: inner.type,
    ...(inner.exp !== undefined ? { exp: inner.exp } : {}),
    ...(inner.max !== undefined ? { max: inner.max } : {}),
    payload: inner.payload,
    sum: undefined,
  });
  const expected = createHash("sha256").update(body, "utf8").digest("hex");
  if (expected !== inner.sum) throw new Error("invalid blob: checksum mismatch");
  return {
    type: inner.type,
    payload: inner.payload,
    ...(inner.exp !== undefined ? { expiresAt: inner.exp } : {}),
    ...(inner.max !== undefined ? { maxUses: inner.max } : {}),
  };
}

// ---- join blob (spec §14: copy-paste onboarding) ----
//
// A join blob carries everything an agent needs to join in one pasteable
// string: base64(JSON) — compact, no line breaks, safe to wrap in quotes.
// The credential/inviteCode travel INSIDE the blob exactly as the human
// received them; the blob adds no secrecy of its own.

export { idempotencyKey } from "./schema";
export type { ClaimKind, ClaimMessage, ClaimProvenance, ClaimSource } from "./schema";
