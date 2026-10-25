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

function isLiveToken(m: MemberRow, channel: ChannelRow, now: number): boolean {
  return (
    m.token_hash !== null &&
    m.token_expires_at !== null &&
    m.token_expires_at > now &&
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

export function createRelayHandler(db: Database): (req: Request) => Promise<Response> {
  // pending challenges, in-memory only: (channelId, memberName) → nonce
  const challenges = new Map<string, PendingChallenge>();
  const challengeKey = (channelId: string, memberName: string) => `${channelId}\n${memberName}`;

  const stmtChannel = db.prepare("SELECT id, epoch, next_seq, verify_key, created_at FROM channels WHERE id = ?");
  const stmtMemberByName = db.prepare("SELECT channel_id, name, token_hash, token_expires_at, epoch, joined_at FROM members WHERE channel_id = ? AND name = ?");
  const stmtMemberByToken = db.prepare("SELECT channel_id, name, token_hash, token_expires_at, epoch, joined_at FROM members WHERE channel_id = ? AND token_hash = ?");
  const stmtMembers = db.prepare("SELECT name, joined_at FROM members WHERE channel_id = ? ORDER BY joined_at ASC");
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
  const stmtBumpSeq = db.prepare("UPDATE channels SET next_seq = ? WHERE id = ?");

  /** Returns channel+member for a valid Bearer token, or null (caller answers 401). */
  function authenticate(channelId: string, req: Request): { channel: ChannelRow; member: MemberRow } | null {
    const token = bearerToken(req);
    if (!token) return null;
    const channel = stmtChannel.get(channelId) as ChannelRow | undefined;
    if (!channel) return null;
    const member = stmtMemberByToken.get(channelId, sha256Hex(token)) as MemberRow | undefined;
    if (!member) return null;
    const now = Date.now();
    if (!isLiveToken(member, channel, now)) return null;
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

  const storeMessage = db.transaction((channelId: string, channel: ChannelRow, nonce: string, ciphertext: string, idemKey: string): Response => {
    const existing = stmtMessageByIdem.get(channelId, idemKey) as { seq: number } | undefined;
    if (existing) {
      return json({ seq: existing.seq, deduped: true });
    }
    const seq = channel.next_seq;
    stmtInsertMessage.run(channelId, seq, nonce, ciphertext, idemKey, new Date().toISOString());
    stmtBumpSeq.run(seq + 1, channelId);
    return json({ seq, deduped: false });
  });

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
      return json({ channelId, epoch: 1, nextSeq: 1 });
    }

    // ---- /channels/:id/... ----
    const match = path.match(/^\/channels\/([^/]+)(?:\/(challenge|join|messages|meta|rotate))?$/);
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
        stmtUpsertMember.run(
          channelId,
          memberName,
          sha256Hex(token),
          now + TOKEN_TTL_MS,
          channel.epoch,
          member?.joined_at ?? new Date().toISOString(),
        );
        challenges.delete(key); // one-time use
        return json({ token, epoch: channel.epoch, memberName });
      }

      case "messages": {
        if (method === "POST") {
          const auth = authenticate(channelId, req);
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
          return storeMessage(channelId, auth.channel, shape.values.nonce, ciphertext, shape.values.idemKey);
        }
        if (method === "GET") {
          const auth = authenticate(channelId, req);
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
          return json({ messages: rows, nextSeq: auth.channel.next_seq });
        }
        return jsonError(405, "method not allowed");
      }

      case "meta": {
        if (method !== "GET") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (!auth) return jsonError(401, "unauthorized");
        const members = stmtMembers.all(channelId) as Array<{ name: string; joined_at: string }>;
        return json({
          channelId: auth.channel.id,
          epoch: auth.channel.epoch,
          nextSeq: auth.channel.next_seq,
          members: members.map((m) => ({ memberName: m.name, joinedAt: m.joined_at })),
        });
      }

      case "rotate": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
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
        return json({ epoch: auth.channel.epoch + 1 });
      }
    }
    return jsonError(404, "not found");
  }

  return handle;
}
