/**
 * RelayMailbox — Mailbox implementation over the blind relay's HTTP API
 * (spec §5.5). Owns the E2E side: validates claims locally, seals/open with
 * the password-derived channel key, and keeps tokens in memory only.
 *
 * Poll delivery order (task-4 brief Step 3): fetch → decrypt → cacheMessages →
 * advance cursor. A crash between steps can re-deliver; downstream dedupe by
 * (channel_id, seq) cache upsert + monotonic cursor absorbs it.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  deriveChannelKey,
  hmacProof,
  open,
  seal,
  validateClaim,
  type ClaimMessage,
  type SealedEnvelope,
} from "@share-context-mcp/protocol";
import type { Store } from "../store";
import type { Mailbox, MailboxMember, MailboxMeta } from "./types";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const PASSWORD_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CHANNEL_ID_LEN = 12;
const PASSWORD_CHARS = 20; // 5 groups of 4 → "xxxx-xxxx-xxxx-xxxx-xxxx"

function randomString(alphabet: string, len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function generateChannelId(): string {
  return randomString(ID_ALPHABET, CHANNEL_ID_LEN);
}

/** Human-copyable grouped password: 20 chars of [a-z0-9] in 4-char dash groups. */
export function generateGroupedPassword(): string {
  const raw = randomString(PASSWORD_ALPHABET, PASSWORD_CHARS);
  return raw.match(/.{4}/g)!.join("-");
}

/**
 * Verification key sent to the relay: HMAC-SHA256(channelKey, "verify").
 * Proves password possession at create/rotate time without ever transmitting
 * the channel key (the relay stays blind).
 */
function deriveVerifyKeyB64(channelKey: Uint8Array): string {
  return createHmac("sha256", Buffer.from(channelKey)).update("verify", "utf8").digest("base64");
}

interface EnvelopeRow {
  seq: number;
  nonce: string;
  ciphertext: string;
}

export class RelayMailbox implements Mailbox {
  private readonly baseUrl: string;
  private readonly store: Store;
  /** Session tokens per channel — memory first, encrypted fallback in the store. */
  private readonly tokens = new Map<string, string>();
  /** Default channel for the brief's `send(msg)` form; set on create/join. */
  private defaultChannelId: string | null = null;

  constructor(opts: { baseUrl: string; store: Store }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.store = opts.store;
  }

  // ---- helpers ----

  private async request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      // The relay's fixed error strings are the contract ("auth failed: wrong
      // password", "member name already taken", "unauthorized") — pass through.
      throw new Error(typeof body?.error === "string" ? body.error : `relay request failed: ${res.status}`);
    }
    return body ?? {};
  }

  private authHeaders(channelId: string): Record<string, string> {
    const token = this.loadToken(channelId);
    if (!token) throw new Error(`not joined: ${channelId}`);
    return { authorization: `Bearer ${token}` };
  }

  /**
   * Token lookup: memory first, then the encrypted store slot written at
   * join time. Lets a restarted (or second, SQLite-sharing) process adopt
   * the session of the member name it holds without re-challenging.
   */
  private loadToken(channelId: string): string | null {
    const mem = this.tokens.get(channelId);
    if (mem) return mem;
    const saved = this.store.getSecret(`token:${channelId}`);
    if (saved) this.tokens.set(channelId, saved);
    return saved;
  }

  /**
   * Adopt the persisted session token for a channel, if any. Returns true
   * when a token was loaded (the caller must verify it with an authed call).
   */
  private adoptStoredToken(channelId: string): boolean {
    return this.loadToken(channelId) !== null;
  }

  private forgetToken(channelId: string): void {
    this.tokens.delete(channelId);
    this.store.deleteKv(`token:${channelId}`);
  }

  private channelIdFor(msg: ClaimMessage, channelId?: string): string {
    const ch = channelId ?? this.defaultChannelId;
    if (!ch) throw new Error("no channel: create or join a channel first");
    return ch;
  }

  private channelKey(channelId: string): Uint8Array {
    const secret = this.store.getChannelSecret(channelId);
    if (!secret) throw new Error(`unknown channel: ${channelId}`);
    return deriveChannelKey(secret.password, channelId);
  }

  /** Challenge → proof → join; stores the session token. Relay errors propagate. */
  private async challengeJoin(channelId: string, channelKey: Uint8Array, memberName: string): Promise<void> {
    // The relay verifies the proof against the STORED VERIFY KEY
    // (HMAC(verifyKey, nonce)) — so the proof must be computed from the verify
    // key, not the channel key (matches relay's join route + its tests).
    const verifyKeyB64 = deriveVerifyKeyB64(channelKey);
    const verifyKey = new Uint8Array(Buffer.from(verifyKeyB64, "base64"));
    const { nonceB64 } = (await this.request(`/channels/${channelId}/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberName }),
    })) as { nonceB64?: string };
    if (typeof nonceB64 !== "string") throw new Error("relay did not issue a challenge nonce");
    const proof = hmacProof(verifyKey, nonceB64);
    const joined = (await this.request(`/channels/${channelId}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberName, proof }),
    })) as { token?: string; epoch?: number };
    if (typeof joined.token !== "string") throw new Error("relay did not issue a session token");
    this.tokens.set(channelId, joined.token);
    // Persist (encrypted) so a restart or a second process sharing the SQLite
    // can adopt this session instead of failing the 409 live-name check.
    try {
      this.store.putSecret(`token:${channelId}`, joined.token);
    } catch {
      // token persistence is best-effort; memory still works this session
    }
  }

  // ---- Mailbox ----

  async createChannel(opts: { name?: string; memberName: string }): Promise<{ channelId: string; password: string }> {
    // `name` is a local display label in v1; the blind relay stores no title.
    void opts.name;
    const channelId = generateChannelId();
    const password = generateGroupedPassword();
    const key = deriveChannelKey(password, channelId);
    const created = await this.request("/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelId,
        memberName: opts.memberName,
        verifyKeyB64: deriveVerifyKeyB64(key),
      }),
    });
    await this.challengeJoin(channelId, key, opts.memberName);
    this.store.upsertChannel({
      channelId,
      password,
      memberName: opts.memberName,
      epoch: typeof created.epoch === "number" ? created.epoch : 1,
    });
    this.defaultChannelId = channelId;
    return { channelId, password };
  }

  async join(channelId: string, password: string, memberName: string): Promise<void> {
    const key = deriveChannelKey(password, channelId);
    // On 401 the relay's error propagates verbatim BEFORE anything is persisted.
    try {
      await this.challengeJoin(channelId, key, memberName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A live session already holds this member name (restart within the
      // token TTL, or a concurrent instance sharing the store). Adopt its
      // persisted token; the meta verification below proves it still works.
      if (!msg.includes("member name already taken") || !this.adoptStoredToken(channelId)) {
        throw err;
      }
    }
    // Verify the session actually works before recording the channel locally.
    const meta = await this.request(`/channels/${channelId}/meta`, {
      method: "GET",
      headers: this.authHeaders(channelId),
    });
    this.store.upsertChannel({
      channelId,
      password,
      memberName,
      epoch: typeof meta.epoch === "number" ? meta.epoch : 1,
    });
    this.defaultChannelId = channelId;
  }

  async send(msg: ClaimMessage, channelId?: string): Promise<{ seq: number; deduped: boolean }> {
    const ch = this.channelIdFor(msg, channelId);
    const validated = validateClaim(msg);
    if (!validated.ok) throw new Error(validated.reason);
    const envelope: SealedEnvelope = seal(validated.msg, this.channelKey(ch));
    const res = await this.request(`/channels/${ch}/messages`, {
      method: "POST",
      headers: { ...this.authHeaders(ch), "content-type": "application/json" },
      body: JSON.stringify({
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        idemKey: validated.msg.idempotencyKey,
      }),
    });
    return { seq: res.seq as number, deduped: res.deduped === true };
  }

  async poll(channelId: string, since: number): Promise<ClaimMessage[]> {
    const data = (await this.request(`/channels/${channelId}/messages?since=${since}`, {
      method: "GET",
      headers: this.authHeaders(channelId),
    })) as { messages?: EnvelopeRow[] };
    const key = this.channelKey(channelId);
    const out: ClaimMessage[] = [];
    for (const env of data.messages ?? []) {
      try {
        // v1: envelopes from another epoch (undecryptable with the current key)
        // are skipped silently; they stay readable to whoever held the old key.
        const msg = open({ nonce: env.nonce, ciphertext: env.ciphertext }, key);
        out.push({ ...msg, seq: env.seq });
      } catch {
        // skip undecryptable envelope
      }
    }
    if (out.length > 0) this.store.cacheMessages(channelId, out);
    this.store.recordCursorFromMessages(channelId, out);
    return out;
  }

  async meta(channelId: string): Promise<MailboxMeta> {
    const data = await this.request(`/channels/${channelId}/meta`, {
      method: "GET",
      headers: this.authHeaders(channelId),
    });
    return {
      members: (data.members as MailboxMember[]) ?? [],
      nextSeq: data.nextSeq as number,
    };
  }

  async rotate(channelId: string, newPassword: string): Promise<void> {
    const newKey = deriveChannelKey(newPassword, channelId);
    const res = await this.request(`/channels/${channelId}/rotate`, {
      method: "POST",
      headers: { ...this.authHeaders(channelId), "content-type": "application/json" },
      body: JSON.stringify({ verifyKeyB64: deriveVerifyKeyB64(newKey) }),
    });
    const secret = this.store.getChannelSecret(channelId);
    if (!secret) throw new Error(`unknown channel: ${channelId}`);
    this.store.upsertChannel({
      channelId,
      password: newPassword,
      memberName: secret.memberName,
      epoch: typeof res.epoch === "number" ? res.epoch : secret.epoch + 1,
    });
    // All tokens (including ours) are dead after rotate; re-join to continue.
    this.forgetToken(channelId);
    if (this.defaultChannelId === channelId) this.defaultChannelId = null;
  }

  async leave(channelId: string): Promise<void> {
    this.store.removeChannel(channelId);
    this.forgetToken(channelId);
    if (this.defaultChannelId === channelId) this.defaultChannelId = null;
  }
}
