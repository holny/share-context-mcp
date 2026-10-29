/**
 * RelayBridge — ChannelBridge implementation over the blind relay's HTTP API
 * (spec §5.5). Owns the E2E side: validates claims locally, seals/open with
 * the password-derived channel key, and keeps tokens in memory only.
 *
 * Poll delivery order: fetch → decrypt with the best held key (current epoch
 * first, then retained old-epoch keys) → cacheMessages → advance the cursor
 * over the whole RETURNED window (high-water, C-1: undecryptable envelopes
 * must never re-fetch forever). A crash between steps can re-deliver;
 * downstream dedupe by (channel_id, seq) cache upsert + monotonic cursor
 * absorbs it.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  LIMITS,
  deriveChannelKey,
  hmacProof,
  open,
  parseAdmissionCredential,
  parseInviteCode,
  seal,
  validateClaim,
  type SealedEnvelope,
} from "@share-context-mcp/protocol";
import type { ClaimMessage } from "@share-context-mcp/protocol";
import type { Store } from "../store";
import { ChannelTransport } from "../transport";
import type { TransportTuning } from "../transport";
import type { ClaimInput, ChannelBridge, BridgeListener, ChannelMember, ChannelMeta, PollResult } from "./types";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const PASSWORD_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Client-side rate limit for presence receipts (presence is 5-minute buckets downstream). */
const ACTIVITY_POST_INTERVAL_MS = 30_000;
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

export class RelayBridge implements ChannelBridge {
  private readonly baseUrl: string;
  private readonly store: Store;
  /** Session tokens per channel — memory first, encrypted fallback in the store. */
  private readonly tokens = new Map<string, string>();
  /** Default channel for the brief's `send(msg)` form; set on create/join. */
  private defaultChannelId: string | null = null;
  /** Live listeners per channel, marked active by send/poll (spec §5.8). */
  private readonly listeners = new Map<string, Set<ChannelTransport>>();

  /** Last activity POST time per channel — 30s client-side rate limit (presence receipts). */
  private readonly lastActivityPost = new Map<string, number>();

  readonly governance = true;

  /** Consumer id bound into every request (X-SCM-Consumer); registered at join. */
  consumerId = `p/${process.pid}`;

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

  authHeaders(channelId: string): Record<string, string> {
    const token = this.loadToken(channelId);
    if (!token) throw new Error(`not joined: ${channelId}`);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (this.consumerId) headers["x-scm-consumer"] = this.consumerId;
    return headers;
  }

  /**
   * Bind this process's consumer id: sent as a header on every request and
   * registered at the relay (per-member consumer ledger). If the relay
   * answers `consumer not registered` (e.g. a NEW session joined by another
   * consumer of the same member), requests self-heal via POST /consumers.
   */
  setConsumer(consumerId: string): void {
    this.consumerId = consumerId;
  }

  /**
   * Token lookup: memory first, then the encrypted store slot written at
   * join time. Lets a restarted (or second, SQLite-sharing) process adopt
   * the session of the member name it holds without re-challenging.
   */
  private loadToken(channelId: string): string | null {
    const mem = this.tokens.get(channelId);
    if (mem) return mem;
    const session = this.loadStoredSession(channelId);
    if (session) {
      this.tokens.set(channelId, session.token);
      return session.token;
    }
    return null;
  }

  /** Rotate the member token (CLI token refresh): new token replaces old atomically. */
  async refreshToken(channelId: string): Promise<void> {
    const data = await this.request(`/channels/${channelId}/token-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders(channelId) },
      body: JSON.stringify({}),
    });
    if (typeof data.token !== "string") throw new Error("relay did not issue a refreshed token");
    this.tokens.set(channelId, data.token);
    this.store.putSecret(`token:${channelId}`, JSON.stringify({ token: data.token, memberName: this.loadStoredSession(channelId)?.memberName ?? "" }));
  }

  /**
   * The persisted session: token AND the memberName it was issued for.
   * The name rides with the token so adoption can never cross identities
   * (a 409 for a DIFFERENT live member name must surface, not adopt).
   */
  private loadStoredSession(channelId: string): { token: string; memberName: string } | null {
    const raw = this.store.getSecret(`token:${channelId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { token?: unknown; memberName?: unknown };
      if (typeof parsed.token === "string" && typeof parsed.memberName === "string") {
        return { token: parsed.token, memberName: parsed.memberName };
      }
    } catch {
      // corrupt/foreign entry — treat as no stored session
    }
    return null;
  }

  /**
   * Adopt the persisted session for a channel ONLY when it was issued for
   * the requested memberName. Returns true when a matching session was
   * loaded (the caller must verify it with an authed call).
   */
  private adoptStoredSession(channelId: string, memberName: string): boolean {
    const session = this.loadStoredSession(channelId);
    if (!session || session.memberName !== memberName) return false;
    this.tokens.set(channelId, session.token);
    return true;
  }

  private forgetToken(channelId: string): void {
    this.tokens.delete(channelId);
    this.store.deleteKv(`token:${channelId}`);
  }

  private channelIdFor(msg: ClaimInput, channelId?: string): string {
    const ch = channelId ?? this.defaultChannelId;
    if (!ch) throw new Error("no channel: create or join a channel first");
    return ch;
  }

  /**
   * The channel's message key: unwrapped from a self-contained credential
   * (scmc1- admission credential, or an invite code) or derived from the
   * password via HKDF (legacy).
   */
  channelKey(channelId: string): Uint8Array {
    const secret = this.store.getChannelSecret(channelId);
    if (!secret) throw new Error(`unknown channel: ${channelId}`);
    if (secret.password.startsWith("scmc1-")) {
      try {
        return parseAdmissionCredential(secret.password);
      } catch {
        return parseInviteCode(secret.password).channelKey;
      }
    }
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
      body: JSON.stringify({ memberName, proof, consumerId: this.consumerId }),
    })) as { token?: string; epoch?: number };
    if (typeof joined.token !== "string") throw new Error("relay did not issue a session token");
    this.tokens.set(channelId, joined.token);
    // Persist (encrypted) TOGETHER WITH the memberName so a restart or a
    // second process sharing the SQLite can adopt this session — but only
    // ever under the SAME member name (adoption across identities would
    // silently ride someone else's session).
    try {
      this.store.putSecret(`token:${channelId}`, JSON.stringify({ token: joined.token, memberName }));
    } catch {
      // token persistence is best-effort; memory still works this session
    }
  }

  // ---- ChannelBridge ----

  async createChannel(opts: { name?: string; memberName: string; gitUrl?: string; admissionMode?: string; contactInfo?: string }): Promise<{ channelId: string; password: string }> {
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
        admissionMode: opts.admissionMode,
        contactInfo: opts.contactInfo,
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

  async join(channelId: string, password: string, memberName: string, _opts?: { gitUrl?: string }): Promise<void> {
    // Self-contained admission credential (scmc1- prefix): the message key
    // travels inside the credential — unwrap it; the challenge proof is
    // computed from the SAME channel key either way. Legacy passwords derive
    // it via HKDF.
    const { parseAdmissionCredential } = await import("@share-context-mcp/protocol");
    const key = password.startsWith("scmc1-")
      ? parseAdmissionCredential(password)
      : deriveChannelKey(password, channelId);
    // On 401 the relay's error propagates verbatim BEFORE anything is persisted.
    try {
      await this.challengeJoin(channelId, key, memberName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A live session already holds the requested member name (restart
      // within the token TTL, or a concurrent instance sharing the store).
      // Adopt the persisted session ONLY for the SAME member name — with a
      // different name the live session is someone else's identity, and the
      // relay's 409 must surface so the agent picks another name.
      if (!msg.includes("member name already taken") || !this.adoptStoredSession(channelId, memberName)) {
        throw err;
      }
    }
    // Verify the session actually works before recording the channel locally.
    const meta = await this.request(`/channels/${channelId}/meta`, {
      method: "GET",
      headers: this.authHeaders(channelId),
    });
    // Defense in depth: the live session must actually be this member name.
    const members = (meta.members as ChannelMember[] | undefined) ?? [];
    if (!members.some((m) => m.memberName === memberName)) {
      this.forgetToken(channelId);
      throw new Error("member name already taken");
    }
    this.store.upsertChannel({
      channelId,
      password,
      memberName,
      epoch: typeof meta.epoch === "number" ? meta.epoch : 1,
    });
    this.defaultChannelId = channelId;
  }

  async send(msg: ClaimInput, channelId?: string): Promise<{ seq: number; deduped: boolean }> {
    const ch = this.channelIdFor(msg, channelId);
    const validated = validateClaim(msg);
    if (!validated.ok) throw new Error(validated.reason);
    const envelope: SealedEnvelope = seal(validated.msg, this.channelKey(ch));
    const res = (await this.request(`/channels/${ch}/messages`, {
      method: "POST",
      headers: { ...this.authHeaders(ch), "content-type": "application/json" },
      body: JSON.stringify({
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
        idemKey: validated.msg.idempotencyKey,
      }),
    })) as { seq?: unknown; deduped?: unknown };
    // A successful send is activity (spec §5.8): poll-mode listeners of this
    // channel drop to the active interval.
    this.markListeners(ch);
    return { seq: res.seq as number, deduped: res.deduped === true };
  }

  async poll(channelId: string, since: number, opts?: { markActivity?: boolean }): Promise<PollResult> {
    const data = (await this.request(`/channels/${channelId}/messages?since=${since}`, {
      method: "GET",
      headers: this.authHeaders(channelId),
    })) as { messages?: EnvelopeRow[]; minSeq?: number; nextSeq?: number };
    // Retention gap handling (spec): when the relay evicted a prefix below
    // our cursor, raise the cursor to the last seq that can still exist
    // (min(minSeq, nextSeq-1) — minSeq can equal next_seq when EVERYTHING was
    // evicted, and next_seq is a RESERVED seq for a future message: raising
    // to it would silently skip that future message). The gap is recorded
    // only on real eviction (minSeq > 1); the evicted text is gone and
    // recoverable only via digest messages.
    const minSeq = typeof data.minSeq === "number" ? data.minSeq : undefined;
    const nextSeq = typeof data.nextSeq === "number" ? data.nextSeq : undefined;
    if (minSeq !== undefined && minSeq > 1) {
      const raiseTarget = nextSeq !== undefined ? Math.min(minSeq, nextSeq - 1) : minSeq;
      if (raiseTarget > this.store.getCursor(channelId)) {
        this.store.setCursor(channelId, raiseTarget);
      }
      const gapKey = `gap:${channelId}`;
      const prev = this.store.getKv(gapKey);
      const prevNum = prev === null ? 0 : Number(prev);
      if (minSeq > prevNum) this.store.setKv(gapKey, String(minSeq));
    }
    const envelopes = data.messages ?? [];
    // Candidate keys, current epoch first (C-1/I-2): an envelope sealed in an
    // earlier epoch is opened with its RETAINED old password (spec §5.5 —
    // local holders of the old key keep reading old-epoch ciphertext). A
    // member who never held the old password simply fails to open it.
    // Self-contained credentials (scmc1-): the message key unwraps from the
    // credential, NOT from HKDF(password) — C-1 fix.
    const secret = this.store.getChannelSecret(channelId);
    if (!secret) throw new Error(`unknown channel: ${channelId}`);
    const keys: Uint8Array[] = [this.channelKey(channelId)];
    for (const { password } of this.store.epochPasswords(channelId)) {
      keys.push(
        password.startsWith("scmc1-")
          ? parseAdmissionCredential(password)
          : deriveChannelKey(password, channelId),
      );
    }
    const out: ClaimMessage[] = [];
    let best = 0; // index of the last key that opened an envelope
    for (const env of envelopes) {
      for (let i = 0; i < keys.length; i++) {
        try {
          const msg = open({ nonce: env.nonce, ciphertext: env.ciphertext }, keys[(best + i) % keys.length]);
          // Spec §5.9 server-side clamp: truncate (never drop) overlong
          // content so the cache stays truthful to the cursor.
          msg.statement = msg.statement.slice(0, LIMITS.statementMax);
          if (msg.detail !== undefined) msg.detail = msg.detail.slice(0, LIMITS.detailMax);
          out.push({ ...msg, seq: env.seq });
          best = (best + i) % keys.length;
          break;
        } catch {
          // wrong epoch key — try the next candidate before giving up
        }
      }
    }
    if (out.length > 0) this.store.cacheMessages(channelId, out);
    // Cursor high-water over the RETURNED WINDOW, not over what decrypted
    // (C-1): an undecryptable page prefix (old-epoch ciphertext after a
    // rotate) must advance the cursor, or it would re-fetch forever and
    // permanently block every newer message behind it.
    this.store.recordCursorFromMessages(channelId, envelopes);
    // A fetch is activity (spec §5.8) — usually triggered BY a listener's
    // wake (already marked), but direct poll() calls count too. AGENT-SCOPED
    // (Review F3): the broadcaster's background poll passes markActivity:
    // false — self-marking would keep poll mode at the active pace forever.
    if (opts?.markActivity !== false) this.markListeners(channelId);
    return { messages: out, skipped: envelopes.length - out.length, minSeq };
  }

  /**
   * Live notifications (spec §5.7): WS-first auto downgrade. The transport
   * never pulls messages — onNotify is a wake hint and the CALLER polls
   * (channelId, cursor). The token is resolved lazily per connect attempt so
   * re-join (e.g. after rotate) is adopted without re-listen.
   */
  listen(channelId: string, onNotify: (seq: number) => void, tuning?: TransportTuning): BridgeListener {
    if (!this.store.getChannelSecret(channelId)) throw new Error(`unknown channel: ${channelId}`);
    const wsBase = this.baseUrl.replace(/^http/i, "ws");
    const transport = new ChannelTransport({
      channelId,
      buildWsUrl: (token) => `${wsBase}/channels/${channelId}/ws?token=${encodeURIComponent(token)}`,
      getToken: () => this.loadToken(channelId),
      onNotify,
      tuning,
    });
    let set = this.listeners.get(channelId);
    if (!set) {
      set = new Set();
      this.listeners.set(channelId, set);
    }
    set.add(transport);
    transport.start();
    const listeners = this.listeners;
    return {
      stop: async () => {
        await transport.stop();
        const s = listeners.get(channelId);
        if (s) {
          s.delete(transport);
          if (s.size === 0) listeners.delete(channelId);
        }
      },
      markActivity: () => transport.markActivity(),
      get state() {
        return transport.state;
      },
      closeForTest: () => transport.closeForTest(),
    };
  }

  private markListeners(channelId: string): void {
    const set = this.listeners.get(channelId);
    if (!set) return;
    for (const t of set) t.markActivity();
  }

  async meta(channelId: string): Promise<ChannelMeta> {
    const data = await this.request(`/channels/${channelId}/meta`, {
      method: "GET",
      headers: this.authHeaders(channelId),
    });
    return {
      members: (data.members as ChannelMember[]) ?? [],
      nextSeq: data.nextSeq as number,
    };
  }

  /** Presence receipts: POST the member's last-activity timestamp to the relay,
   * rate-limited to one POST per 30s per channel (presence is bucketed at a
   * 5-minute granularity downstream — sub-30s precision buys nothing). */
  async reportActivity(channelId: string, lastActiveAt: string): Promise<void> {
    const now = Date.now();
    const last = this.lastActivityPost.get(channelId);
    if (last !== undefined && now - last < ACTIVITY_POST_INTERVAL_MS) return;
    await this.request(`/channels/${channelId}/activity`, {
      method: "POST",
      headers: { ...this.authHeaders(channelId), "content-type": "application/json" },
      body: JSON.stringify({ lastActiveAt }),
    });
    // Consume the slot only on success: a failed POST must not suppress the
    // next 30s of presence reports (the member was active; the relay just
    // did not hear about it).
    this.lastActivityPost.set(channelId, now);
  }

  /** Open + settled votes (governance). */
  async votes(channelId: string): Promise<{
    open: Array<{ id: string; type: string; target: string; endsAt: number }>;
    history: Array<{ id: string; type: string; target: string; status: string; yes: number; no: number }>;
  }> {
    const data = await this.request(`/channels/${channelId}/votes`, {
      method: "GET",
      headers: this.authHeaders(channelId),
    });
    return {
      open: (data.open as { id: string; type: string; target: string; endsAt: number }[]) ?? [],
      history:
        (data.history as { id: string; type: string; target: string; status: string; yes: number; no: number }[]) ?? [],
    };
  }

  async castVote(channelId: string, voteId: string, choice: "yes" | "no"): Promise<void> {
    await this.request(`/channels/${channelId}/votes/${voteId}/ballot`, {
      method: "POST",
      headers: { ...this.authHeaders(channelId), "content-type": "application/json" },
      body: JSON.stringify({ choice }),
    });
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

  async leave(channelId: string, opts?: { transferTo?: string }): Promise<void> {
    // Governance leave (§2): succession + dissolution live at the relay.
    // Local cleanup only after the relay accepted the departure.
    await this.request(`/channels/${channelId}/leave`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders(channelId) },
      body: JSON.stringify(opts?.transferTo ? { transferTo: opts.transferTo } : {}),
    });
    this.store.removeChannel(channelId);
    this.forgetToken(channelId);
    if (this.defaultChannelId === channelId) this.defaultChannelId = null;
  }

  /**
   * Invite-tier join: the code is self-contained (code id + wrapped channel
   * key). Parses it, presents the code id to the relay, stores the code as
   * the channel secret (channelKey() unwraps it later).
   */
  async joinWithInvite(channelId: string, code: string, memberName: string): Promise<void> {
    const { parseInviteCode } = await import("@share-context-mcp/protocol");
    const parsed = parseInviteCode(code);
    await this.request(`/channels/${channelId}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberName, consumerId: this.consumerId, inviteCodeId: parsed.codeId }),
    });
    this.tokens.set(channelId, (this.loadStoredSession(channelId)?.token ?? ""));
    this.store.putSecret(`token:${channelId}`, JSON.stringify({ token: this.loadStoredSession(channelId)?.token ?? "", memberName }));
    this.store.upsertChannel({ channelId, password: code, memberName, epoch: 1 });
    this.defaultChannelId = channelId;
  }
}
