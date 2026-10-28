/**
 * Blind relay HTTP routes (spec §5.5/§5.9, task-3 brief).
 *
 * BLINDNESS RULES:
 * - Client-supplied ciphertext is OPAQUE: never decoded into content, never
 *   validated beyond "is a base64 string of ≤8KB bytes" (length only).
 * - The relay stores the password-derived *verification key*
 *   (HMAC-SHA256(channelKey, "verify")) — not the channel key — so it can
 *   check join proofs but can never decrypt messages.
 * - Errors are plaintext-free fixed strings; logs carry at most
 *   channelId/seq/lengths, never message bodies.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { hmacProof } from "@share-context-mcp/protocol";
import type { ChannelRow, MemberRow } from "./db";
import type { WsHub } from "./ws";

// ---- tunables (spec §5.5: token TTL 24h default) ----
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_CIPHERTEXT_BYTES = 8 * 1024;
const VERIFY_KEY_BYTES = 32;
const CHALLENGE_NONCE_BYTES = 32;
const TOKEN_BYTES = 32;
const MEMBER_NAME_MAX = 32;
const NONCE_MAX_CHARS = 256;
const IDEM_KEY_MAX_CHARS = 256;

interface PendingChallenge {
  nonceB64: string;
  expiresAt: number;
}

// ---- helpers ----

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Timing-safe string comparison; length mismatch returns false immediately. */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function readJson(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; resp: Response }> {
  try {
    const body = (await req.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, resp: jsonError(400, "invalid request: body must be a JSON object") };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, resp: jsonError(400, "invalid request: malformed JSON") };
  }
}

function validMemberName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= MEMBER_NAME_MAX;
}

function isLiveToken(m: MemberRow, channel: { epoch: number }, now: number): boolean {
  return (
    m.token_hash !== null &&
    // token_expires_at NULL = no expiry (long-lived membership token)
    (m.token_expires_at === null || m.token_expires_at > now) &&
    m.epoch === channel.epoch
  );
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

// ---- route factory ----

/** Shared retention defaults — bin.ts, index.ts and the route factory must not drift. */
export const DEFAULT_MAX_MESSAGES = 10_000;
export const DEFAULT_MAX_AGE_DAYS = 30;

export interface RelayRetention {
  maxMessages: number;
  maxAgeDays: number;
}

function validateRetention(r: RelayRetention): RelayRetention {
  if (!Number.isInteger(r.maxMessages) || r.maxMessages < 1) {
    throw new Error(`invalid retention: maxMessages must be an integer >= 1 (got ${r.maxMessages})`);
  }
  if (!Number.isFinite(r.maxAgeDays) || r.maxAgeDays < 0) {
    throw new Error(`invalid retention: maxAgeDays must be a finite number >= 0 (got ${r.maxAgeDays})`);
  }
  return r;
}

export function createRelayHandler(db: Database, wsHub?: WsHub, retention: RelayRetention = { maxMessages: DEFAULT_MAX_MESSAGES, maxAgeDays: DEFAULT_MAX_AGE_DAYS }, sweepIntervalMs?: number, tokenTtlMs: number | null = null): (req: Request) => Promise<Response> {
  validateRetention(retention);
  // pending challenges, in-memory only: (channelId, memberName) → nonce
  const challenges = new Map<string, PendingChallenge>();
  const challengeKey = (channelId: string, memberName: string) => `${channelId}\n${memberName}`;
  if (sweepIntervalMs !== undefined && sweepIntervalMs > 0) {
    // unref'd: the sweep must not keep the process alive on its own; stop()
    // closes the db, after which a late tick would throw — guarded below.
    const timer = setInterval(() => {
      try {
        sweepTtl();
      } catch {
        /* db closed — sweep is best-effort */
      }
    }, sweepIntervalMs);
    timer.unref();
  }

  const stmtChannel = db.prepare("SELECT id, epoch, next_seq, verify_key, created_at, min_seq, creator_member, manager_member, admission_mode, invite_policy, contact_info, vote_cooldown_until FROM channels WHERE id = ?");
  const stmtMemberByName = db.prepare("SELECT channel_id, name, token_hash, token_expires_at, epoch, joined_at, status, can_invite FROM members WHERE channel_id = ? AND name = ?");
  const stmtMemberByToken = db.prepare("SELECT channel_id, name, token_hash, token_expires_at, epoch, joined_at, status, can_invite FROM members WHERE channel_id = ? AND token_hash = ?");
  const stmtMembers = db.prepare("SELECT name, joined_at, last_active_at FROM members WHERE channel_id = ? ORDER BY joined_at ASC");
  const stmtSetLastActive = db.prepare("UPDATE members SET last_active_at = ? WHERE channel_id = ? AND name = ?");
  const stmtInsertChannel = db.prepare("INSERT INTO channels(id, epoch, next_seq, verify_key, created_at) VALUES (?, 1, 1, ?, ?)");
  const stmtUpsertMember = db.prepare(`
    INSERT INTO members(channel_id, name, token_hash, token_expires_at, epoch, joined_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, name) DO UPDATE SET
      token_hash = excluded.token_hash,
      token_expires_at = excluded.token_expires_at,
      epoch = excluded.epoch
  `);
  const stmtClearTokens = db.prepare("UPDATE members SET token_hash = NULL, token_expires_at = NULL WHERE channel_id = ?");
  const stmtBumpEpoch = db.prepare("UPDATE channels SET epoch = epoch + 1 WHERE id = ?");
  const stmtInsertMessage = db.prepare("INSERT INTO messages(channel_id, seq, nonce, ciphertext, idem_key, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const stmtMessageByIdem = db.prepare("SELECT seq FROM messages WHERE channel_id = ? AND idem_key = ?");
  const stmtMessagesSince = db.prepare("SELECT seq, nonce, ciphertext FROM messages WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?");
  // Returns the LIVE epoch alongside the allocated seq so push notifications
  // are allocated atomically with the message (a concurrent rotate cannot
  // split seq from its epoch).
  const stmtRegisterConsumer = db.prepare(
    "INSERT INTO member_consumer_ids(channel_id, member_name, consumer_id, last_seen) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(channel_id, member_name, consumer_id) DO UPDATE SET last_seen = excluded.last_seen",
  );
  const stmtConsumerRegistered = db.prepare(
    "SELECT 1 FROM member_consumer_ids WHERE channel_id = ? AND member_name = ? AND consumer_id = ?",
  );
  const stmtBanRow = db.prepare("SELECT consumer_ids FROM member_bans WHERE channel_id = ? AND name = ?");
  const stmtAllocSeq = db.prepare("UPDATE channels SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq, epoch");
  const stmtAudit = db.prepare("INSERT INTO audit_log(channel_id, ts, actor, action, target, result) VALUES (?, ?, ?, ?, ?, ?)");

  /** Governance audit trail (§4b): every governance operation lands here. */
  function audit(channelId: string, actor: string, action: string, target?: string, result?: string): void {
    stmtAudit.run(channelId, new Date().toISOString(), actor, action, target ?? null, result ?? null);
  }
  const stmtMinSeqAbove = db.prepare("SELECT MIN(seq) AS s FROM messages WHERE channel_id = ? AND created_at > ?");
  const stmtEvictPrefix = db.prepare("DELETE FROM messages WHERE channel_id = ? AND seq < ?");
  const stmtSetMinSeq = db.prepare("UPDATE channels SET min_seq = MAX(min_seq, ?) WHERE id = ?");

  /**
   * Retention (spec): evict the OLDEST messages as a contiguous seq prefix
   * when either bound is hit — count (next_seq - maxMessages) or age
   * (created_at older than maxAgeDays). Eviction must never punch holes: a
   * consumer cursor below min_seq would make "no data loss" undecidable.
   */
  function evictIfNeeded(channelId: string, nextSeqHint: number): void {
    // Re-read at eviction time: under concurrent sends the caller's snapshot
    // (auth.channel) is stale, and an unconditional min_seq write from an
    // older cutoff would REGRESS it.
    const row = stmtChannel.get(channelId) as { next_seq: number; min_seq: number } | undefined;
    if (!row) return;
    const nextSeq = Math.max(row.next_seq, nextSeqHint);
    const current = row.min_seq ?? 1;
    const countCutoff = nextSeq - retention.maxMessages;
    const cutoffTime = new Date(Date.now() - retention.maxAgeDays * 86_400_000).toISOString();
    const oldestKept = (stmtMinSeqAbove.get(channelId, cutoffTime) as { s: number | null }).s;
    const timeCutoff = oldestKept ?? nextSeq; // nothing young enough → evict all
    const cutoff = Math.min(Math.max(1, Math.max(countCutoff, timeCutoff)), nextSeq);
    if (cutoff <= current) return;
    // One transaction: a crash between DELETE and the min_seq update would
    // hide the eviction from consumers (rows gone, no gap recorded).
    const tx = db.transaction(() => {
      stmtEvictPrefix.run(channelId, cutoff);
      stmtSetMinSeq.run(cutoff, channelId);
    });
    tx();
  }

  // TTL sweeps iterate all channels; the per-channel cutoff<=min_seq guard
  // keeps quiet channels cheap.
  const stmtChannelsForSweep = db.prepare("SELECT id, next_seq FROM channels");

  /** Periodic TTL sweep: insert-driven eviction alone lets idle channels keep ciphertext past maxAgeDays forever. */
  function sweepTtl(): void {
    for (const ch of stmtChannelsForSweep.all() as Array<{ id: string; next_seq: number }>) {
      evictIfNeeded(ch.id, ch.next_seq);
    }
  }

  /** Returns channel+member for a valid Bearer token, or null (caller answers 401). */
  type AuthResult = { channel: ChannelRow; member: MemberRow } | "banned" | null;

  /**
   * Returns channel+member for a valid Bearer token. Discriminated result:
   * `null` = unauthorized (401 — do not leak ban status to unproven callers),
   * `"banned"` = governance revocation (403 — the client must stop retrying,
   * not re-auth). Consumer binding: when the request presents a consumer id
   * it must be registered under this membership and not consumer-banned.
   */
  function authenticate(channelId: string, req: Request): AuthResult {
    const token = bearerToken(req);
    if (!token) return null;
    const channel = stmtChannel.get(channelId) as ChannelRow | undefined;
    if (!channel) return null;
    const member = stmtMemberByToken.get(channelId, sha256Hex(token)) as MemberRow | undefined;
    if (!member) return null;
    const now = Date.now();
    if (!isLiveToken(member, channel, now)) return null;
    const memberBanned = member.status === "banned";
    // Consumer binding: a presented consumer id is auto-registered (a valid
    // member token IS the membership proof — multi-session processes must
    // just work); the binding's enforcement point is the BAN check below.
    const consumer = req.headers.get("x-scm-consumer");
    let consumerBanned = false;
    if (consumer !== null && consumer !== "") {
      const banRow = stmtBanRow.get(channelId, member.name) as { consumer_ids: string | null } | undefined;
      if (banRow?.consumer_ids) {
        try {
          const bannedConsumers: string[] = JSON.parse(banRow.consumer_ids);
          if (Array.isArray(bannedConsumers) && bannedConsumers.includes(consumer)) consumerBanned = true;
        } catch { /* malformed ban entry — ignore consumer check */ }
      }
      if (!consumerBanned) {
        stmtRegisterConsumer.run(channelId, member.name, consumer, new Date().toISOString());
      }
    }
    if (memberBanned || consumerBanned) return "banned";
    return { channel, member };
  }

  function requireValidatedBody(
    body: Record<string, unknown>,
    keys: Array<{ key: string; maxChars: number; minLength?: number }>,
  ): { ok: true; values: Record<string, string> } | { ok: false; resp: Response } {
    const values: Record<string, string> = {};
    for (const { key, maxChars, minLength = 1 } of keys) {
      const v = body[key];
      if (typeof v !== "string" || v.length < minLength || v.length > maxChars) {
        return { ok: false, resp: jsonError(400, `invalid request: ${key} must be a string of ${minLength}..${maxChars} characters`) };
      }
      values[key] = v;
    }
    return { ok: true, values };
  }

  const storeMessage = db.transaction(
    (channelId: string, nonce: string, ciphertext: string, idemKey: string): { seq: number; epoch: number; deduped: boolean } => {
      const existing = stmtMessageByIdem.get(channelId, idemKey) as { seq: number } | undefined;
      if (existing) {
        return { seq: existing.seq, epoch: 0, deduped: true };
      }
      // Allocate seq INSIDE the transaction (F-1): the channel row captured in
      // authenticate() may be stale after the body-parse await point under
      // concurrent sends; UPDATE ... RETURNING reads the live counter instead.
      const allocated = stmtAllocSeq.get(channelId) as { seq: number; epoch: number } | undefined;
      if (!allocated) {
        // unreachable: channel existence verified in authenticate()
        throw new Error("channel vanished mid-transaction");
      }
      stmtInsertMessage.run(channelId, allocated.seq, nonce, ciphertext, idemKey, new Date().toISOString());
      return { seq: allocated.seq, epoch: allocated.epoch, deduped: false };
    },
  );

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const now = Date.now();

    // opportunistic challenge GC (in-memory; O(n) is fine at relay scale)
    if (challenges.size > 0) {
      for (const [k, v] of challenges) if (v.expiresAt <= now) challenges.delete(k);
    }

    // ---- POST /channels (the only unauthenticated route) ----
    if (path === "/channels" && method === "POST") {
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.resp;
      const { memberName, verifyKeyB64 } = parsed.body;
      if (!validMemberName(memberName)) {
        return jsonError(400, `invalid request: memberName must be a string of 1..${MEMBER_NAME_MAX} characters`);
      }
      if (typeof verifyKeyB64 !== "string" || verifyKeyB64.length === 0 || verifyKeyB64.length > 128) {
        return jsonError(400, "invalid request: verifyKeyB64 must be a base64 string");
      }
      if (Buffer.from(verifyKeyB64, "base64").length !== VERIFY_KEY_BYTES) {
        return jsonError(400, `invalid request: verifyKeyB64 must decode to ${VERIFY_KEY_BYTES} bytes`);
      }
      let channelId: string;
      const requested = parsed.body.channelId;
      if (requested !== undefined) {
        if (typeof requested !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(requested)) {
          return jsonError(400, "invalid request: channelId must match [A-Za-z0-9_-]{8,64}");
        }
        if (stmtChannel.get(requested)) {
          return jsonError(409, "channel id already exists");
        }
        channelId = requested;
      } else {
        channelId = randomBytes(16).toString("hex");
      }
      stmtInsertChannel.run(channelId, verifyKeyB64, new Date().toISOString());
      // reserve the creator's member name (no token yet → not "live",
      // so the creator can still join under it)
      stmtUpsertMember.run(channelId, (memberName as string).trim(), null, null, 1, new Date().toISOString());
      // Governance: the creating member is creator AND manager (§2).
      const stmtSetRoles = db.prepare("UPDATE channels SET creator_member = ?, manager_member = ? WHERE id = ?");
      stmtSetRoles.run((memberName as string).trim(), (memberName as string).trim(), channelId);
      audit(channelId, (memberName as string).trim(), "channel.created", channelId, "ok");
      return json({ channelId, epoch: 1, nextSeq: 1 });
    }

    // ---- /channels/:id/... ----
    const match = path.match(/^\/channels\/([^/]+)(?:\/(challenge|join|messages|meta|rotate|activity|consumers|token-refresh))?$/);
    if (!match) return jsonError(404, "not found");
    const [, channelId, action] = match;
    if (!action) {
      return jsonError(405, method === "GET" ? "method not allowed" : "not found");
    }
    const channel = stmtChannel.get(channelId) as ChannelRow | undefined;
    if (!channel) return jsonError(404, "channel not found");

    switch (action) {
      case "challenge": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        if (!validMemberName(parsed.body.memberName)) {
          return jsonError(400, `invalid request: memberName must be a string of 1..${MEMBER_NAME_MAX} characters`);
        }
        const memberName = (parsed.body.memberName as string).trim();
        const nonceB64 = randomBytes(CHALLENGE_NONCE_BYTES).toString("base64");
        challenges.set(challengeKey(channelId, memberName), { nonceB64, expiresAt: now + CHALLENGE_TTL_MS });
        return json({ nonceB64 });
      }

      case "join": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        if (!validMemberName(parsed.body.memberName)) {
          return jsonError(400, `invalid request: memberName must be a string of 1..${MEMBER_NAME_MAX} characters`);
        }
        const memberName = (parsed.body.memberName as string).trim();
        const consumerId = parsed.body.consumerId;
        if (typeof consumerId !== "string" || consumerId.length < 1 || consumerId.length > 64) {
          return jsonError(400, "invalid request: consumerId must be a string of 1..64 characters");
        }
        const proof = parsed.body.proof;
        if (typeof proof !== "string" || proof.length === 0 || proof.length > 128) {
          return jsonError(400, "invalid request: proof must be a base64 string");
        }
        const key = challengeKey(channelId, memberName);
        const pending = challenges.get(key);
        if (!pending || pending.expiresAt <= now) {
          challenges.delete(key);
          return jsonError(400, "no pending challenge: request one first");
        }
        // Verify possession WITHOUT learning the password: expected proof =
        // HMAC-SHA256(verification key, nonce). The verification key cannot
        // decrypt messages (it is not the channel key).
        const expected = hmacProof(new Uint8Array(Buffer.from(channel.verify_key, "base64")), pending.nonceB64);
        if (!safeEqualStr(proof, expected)) {
          return jsonError(401, "auth failed: wrong password");
        }
        const member = stmtMemberByName.get(channelId, memberName) as MemberRow | undefined;
        if (member && isLiveToken(member, channel, now)) {
          return jsonError(409, "member name already taken");
        }
        const token = randomBytes(TOKEN_BYTES).toString("base64");
        const expiresAt = tokenTtlMs === null ? null : now + tokenTtlMs;
        stmtUpsertMember.run(
          channelId,
          memberName,
          sha256Hex(token),
          expiresAt,
          channel.epoch,
          member?.joined_at ?? new Date().toISOString(),
        );
        stmtRegisterConsumer.run(channelId, memberName, consumerId, new Date().toISOString());
        challenges.delete(key); // one-time use
        audit(channelId, memberName, "member.joined", memberName, "ok");
        return json({ token, epoch: channel.epoch, memberName });
      }

      case "consumers": {
        // Register an ADDITIONAL consumer id under this membership (multi-
        // session processes share one member). Token-authenticated.
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const consumerId = parsed.body.consumerId;
        if (typeof consumerId !== "string" || consumerId.length < 1 || consumerId.length > 64) {
          return jsonError(400, "invalid request: consumerId must be a string of 1..64 characters");
        }
        if (auth.member.status === "banned") return jsonError(403, "banned");
        stmtRegisterConsumer.run(channelId, auth.member.name, consumerId, new Date().toISOString());
        return json({ ok: true });
      }

      case "token-refresh": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        if (auth.member.status === "banned") return jsonError(403, "banned");
        const token = randomBytes(TOKEN_BYTES).toString("base64");
        stmtUpsertMember.run(
          channelId,
          auth.member.name,
          sha256Hex(token),
          tokenTtlMs === null ? null : now + tokenTtlMs,
          channel.epoch,
          auth.member.joined_at,
        );
        audit(channelId, auth.member.name, "token.refreshed", auth.member.name, "ok");
        return json({ token, epoch: channel.epoch, memberName: auth.member.name });
      }

      case "messages": {
        if (method === "POST") {
          const auth = authenticate(channelId, req);
          if (auth === "banned") return jsonError(403, "banned");
          if (!auth) return jsonError(401, "unauthorized");
          const parsed = await readJson(req);
          if (!parsed.ok) return parsed.resp;
          const shape = requireValidatedBody(parsed.body, [
            { key: "nonce", maxChars: NONCE_MAX_CHARS },
            { key: "idemKey", maxChars: IDEM_KEY_MAX_CHARS },
          ]);
          if (!shape.ok) return shape.resp;
          const ciphertext = parsed.body.ciphertext;
          if (typeof ciphertext !== "string" || ciphertext.length === 0) {
            return jsonError(400, "invalid request: ciphertext must be a non-empty base64 string");
          }
          // OPAQUE: decode base64 ONLY to enforce the length cap. Content is
          // never inspected, decoded into text, or logged.
          if (Buffer.from(ciphertext, "base64").length > MAX_CIPHERTEXT_BYTES) {
            return jsonError(413, "message too large: ciphertext must be at most 8192 bytes");
          }
          const stored = storeMessage(channelId, shape.values.nonce, ciphertext, shape.values.idemKey);
          if (!stored.deduped) {
            // Push-wake only (spec §5.7): notifications carry seq+epoch, never
            // content. Dedup re-sends nothing (the original insert already
            // notified); poll GET ?since= remains the correctness fallback.
            wsHub?.notifyMessage(channelId, stored.seq, stored.epoch);
            // Retention runs after each accepted message (spec: count + TTL).
            evictIfNeeded(channelId, stored.seq + 1);
          }
          return json({ seq: stored.seq, deduped: stored.deduped });
        }
        if (method === "GET") {
          const auth = authenticate(channelId, req);
          if (auth === "banned") return jsonError(403, "banned");
          if (!auth) return jsonError(401, "unauthorized");
          const sinceRaw = url.searchParams.get("since") ?? "0";
          const since = Number(sinceRaw);
          if (!Number.isInteger(since) || since < 0) {
            return jsonError(400, "invalid request: since must be a non-negative integer");
          }
          const rows = stmtMessagesSince.all(channelId, since, PAGE_SIZE) as Array<{
            seq: number;
            nonce: string;
            ciphertext: string;
          }>;
          return json({
            messages: rows,
            nextSeq: auth.channel.next_seq,
            minSeq: auth.channel.min_seq ?? 1,
          });
        }
        return jsonError(405, "method not allowed");
      }

      case "activity": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const lastActiveAt = parsed.body.lastActiveAt;
        if (typeof lastActiveAt !== "string" || Number.isNaN(Date.parse(lastActiveAt))) {
          return jsonError(400, "invalid request: lastActiveAt must be an ISO 8601 timestamp");
        }
        // Normalize and clamp: a member posting a far-future timestamp would
        // otherwise stay permanently "active" and corrupt presence buckets.
        const t = new Date(lastActiveAt);
        stmtSetLastActive.run(
          (t.getTime() > Date.now() ? new Date() : t).toISOString(),
          channelId,
          auth.member.name,
        );
        return json({ ok: true });
      }

      case "meta": {
        if (method !== "GET") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const members = stmtMembers.all(channelId) as Array<{ name: string; joined_at: string; last_active_at: string | null }>;
        return json({
          channelId: auth.channel.id,
          epoch: auth.channel.epoch,
          nextSeq: auth.channel.next_seq,
          minSeq: auth.channel.min_seq ?? 1,
          creatorMember: auth.channel.creator_member,
          managerMember: auth.channel.manager_member,
          admissionMode: auth.channel.admission_mode ?? "password",
          invitePolicy: auth.channel.invite_policy ?? "everyone",
          members: members.map((m) => ({ memberName: m.name, joinedAt: m.joined_at, lastActiveAt: m.last_active_at })),
        });
      }

      case "rotate": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        // v1: no key chain (spec §5.5). The caller (proven old-password holder
        // via Bearer token) supplies the NEW password's verification key —
        // still blind: a verification key cannot decrypt messages. Bump epoch,
        // kill all tokens; old-epoch ciphertext STAYS in the DB — members
        // re-join with the new password.
        let newVerifyKey: string | null = null;
        const contentType = req.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const parsed = await readJson(req);
          if (!parsed.ok) return parsed.resp;
          const v = parsed.body.verifyKeyB64;
          if (v !== undefined) {
            if (typeof v !== "string" || v.length === 0 || v.length > 128) {
              return jsonError(400, "invalid request: verifyKeyB64 must be a base64 string");
            }
            if (Buffer.from(v, "base64").length !== VERIFY_KEY_BYTES) {
              return jsonError(400, `invalid request: verifyKeyB64 must decode to ${VERIFY_KEY_BYTES} bytes`);
            }
            newVerifyKey = v;
          }
        }
        if (newVerifyKey) {
          db.prepare("UPDATE channels SET epoch = epoch + 1, verify_key = ? WHERE id = ?").run(newVerifyKey, channelId);
        } else {
          stmtBumpEpoch.run(channelId);
        }
        stmtClearTokens.run(channelId);
        for (const k of challenges.keys()) {
          if (k.startsWith(`${channelId}\n`)) challenges.delete(k);
        }
        // Evict live WS connections of this channel: one seq-free frame
        // naming the new epoch, then a policy close. Old-epoch tokens cannot
        // re-upgrade (auth check rejects them).
        wsHub?.invalidateChannel(channelId, auth.channel.epoch + 1);
        return json({ epoch: auth.channel.epoch + 1 });
      }
    }
    return jsonError(404, "not found");
  }

  return handle;
}

// ---- WS upgrade auth (M2 task-1) ----

/** Identity attached to an upgraded socket (server-side only, never pushed). */
export interface UpgradeIdentity {
  channelId: string;
  memberName: string;
  epoch: number;
}

/**
 * Authenticate a WS-upgrade token from the `?token=` query param.
 * Same rules as Bearer HTTP: sha256 lookup, TTL, epoch must match the
 * channel's current epoch — so old-epoch tokens are rejected at upgrade.
 */
export function authenticateUpgradeToken(db: Database, channelId: string, token: string | null): UpgradeIdentity | null {
  if (!token) return null;
  const channel = db.prepare("SELECT id, epoch FROM channels WHERE id = ?").get(channelId) as
    | Pick<ChannelRow, "id" | "epoch">
    | undefined;
  if (!channel) return null;
  const member = db.prepare(
    "SELECT channel_id, name, token_hash, token_expires_at, epoch, joined_at FROM members WHERE channel_id = ? AND token_hash = ?",
  ).get(channelId, sha256Hex(token)) as MemberRow | undefined;
  if (!member || !isLiveToken(member, channel, Date.now())) return null;
  return { channelId, memberName: member.name, epoch: channel.epoch };
}
