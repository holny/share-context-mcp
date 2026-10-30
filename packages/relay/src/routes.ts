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
import type { ChannelRow, MemberRow, UserRow } from "./db";
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
  return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
}

/**
 * Governance kick (§4 vote action): ban the target (tokens revoked, name +
 * observed consumer ids blacklisted, optional IP), then — password tier —
 * invalidate the admission credential so the kicked member cannot re-enter
 * under a NEW name. Succession per §2: kicked manager → initiator takes
 * manager; kicked creator → initiator takes creator (initiator holding both
 * takes both). Returns which role moved (null = regular member).
 */
export function applyKick(
  db: Database,
  channelId: string,
  target: string,
  initiator: string,
  opts: { ip?: string; banIp?: boolean } = {},
): { succession: "manager" | "creator" | null } {
  const now = new Date().toISOString();
  const observed = (
    db
      .prepare("SELECT consumer_id FROM member_consumer_ids WHERE channel_id = ? AND member_name = ?")
      .all(channelId, target) as Array<{ consumer_id: string }>
  ).map((r) => r.consumer_id);
  db.prepare(
    "INSERT INTO member_bans(channel_id, name, consumer_ids, ip, banned_at, banned_by) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(channel_id, name) DO UPDATE SET consumer_ids = excluded.consumer_ids, ip = COALESCE(excluded.ip, member_bans.ip), banned_at = excluded.banned_at, banned_by = excluded.banned_by",
  ).run(channelId, target, JSON.stringify(observed), opts.banIp && opts.ip ? opts.ip : null, now, `vote:${initiator}`);
  // Token is KEPT so authenticate() can resolve the member and answer 403
  // "banned" (the kicked member's server must stop retrying — 401 would look
  // like a transient auth failure). Status is the revocation.
  db.prepare("UPDATE members SET status = 'banned' WHERE channel_id = ? AND name = ?").run(channelId, target);
  const ch = db.prepare("SELECT creator_member, manager_member, admission_mode FROM channels WHERE id = ?").get(channelId) as
    | { creator_member: string | null; manager_member: string | null; admission_mode: string }
    | undefined;
  let succession: "manager" | "creator" | null = null;
  if (ch) {
    if (ch.manager_member === target) {
      db.prepare("UPDATE channels SET manager_member = ? WHERE id = ?").run(initiator, channelId);
      succession = "manager";
    }
    if (ch.creator_member === target) {
      db.prepare("UPDATE channels SET creator_member = ? WHERE id = ?").run(initiator, channelId);
      succession = "creator";
    }
    if ((ch.admission_mode ?? "password") === "password") {
      // Invalidate the admission credential: joins with the old credential
      // fail until the manager/creator registers a new one (rotate --mode
      // access). Message key untouched — remaining members unaffected.
      db.prepare("UPDATE channels SET admission_credential_revoked = 1 WHERE id = ?").run(channelId);
    }
    db.prepare("INSERT INTO audit_log(channel_id, ts, actor, action, target, result) VALUES (?, ?, ?, ?, ?, ?)").run(
      channelId,
      now,
      initiator,
      "member.kicked",
      target,
      succession ?? "regular",
    );
  }
  return { succession };
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

/**
 * v3 channel-shape validator (spec §2.1): visibility (public|private) ×
 * admission mode (no_limit|password|invite) with the one forbidden pair —
 * private + no_limit (an open-admission channel cannot be hidden; anyone who
 * can find it can join it, so "private" would be a false promise).
 * Shared by create and set-admission.
 */
export function validateChannelShape(
  visibility: string,
  admissionMode: string,
): { ok: true } | { ok: false; error: string } {
  if (visibility !== "public" && visibility !== "private") {
    return { ok: false, error: "invalid request: visibility must be public|private" };
  }
  if (admissionMode !== "no_limit" && admissionMode !== "password" && admissionMode !== "invite") {
    return { ok: false, error: "invalid request: admissionMode must be no_limit|password|invite" };
  }
  if (visibility === "private" && admissionMode === "no_limit") {
    return { ok: false, error: "private channels cannot use no_limit admission" };
  }
  return { ok: true };
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

  const stmtChannel = db.prepare("SELECT id, epoch, next_seq, verify_key, created_at, min_seq, creator_member, manager_member, admission_mode, visibility, probation_enabled, invite_skips_probation, sealed_key, key_rotated_at, invite_policy, contact_info, vote_cooldown_until, admission_credential_revoked, encrypted, key_version FROM channels WHERE id = ?");
  const stmtMemberByName = db.prepare("SELECT channel_id, name, token_hash, token_expires_at, epoch, joined_at, status, can_invite, last_active_at, user_id FROM members WHERE channel_id = ? AND name = ?");
  const stmtMemberByToken = db.prepare("SELECT channel_id, name, token_hash, token_expires_at, epoch, joined_at, status, can_invite, user_id FROM members WHERE channel_id = ? AND token_hash = ?");
  const stmtMembers = db.prepare("SELECT name, joined_at, last_active_at, permission_role, activity_role, activity_expires_at FROM members WHERE channel_id = ? ORDER BY joined_at ASC");
  const stmtSetLastActive = db.prepare("UPDATE members SET last_active_at = ? WHERE channel_id = ? AND name = ?");
  const stmtInsertChannel = db.prepare("INSERT INTO channels(id, epoch, next_seq, verify_key, created_at) VALUES (?, 1, 1, ?, ?)");
  const stmtUpsertMember = db.prepare(`
    INSERT INTO members(channel_id, name, token_hash, token_expires_at, epoch, joined_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(channel_id, name) DO UPDATE SET
      token_hash = excluded.token_hash,
      token_expires_at = excluded.token_expires_at,
      epoch = excluded.epoch,
      status = 'active'
  `);
  const stmtClearTokens = db.prepare("UPDATE members SET token_hash = NULL, token_expires_at = NULL WHERE channel_id = ?");
  const stmtBumpEpoch = db.prepare("UPDATE channels SET epoch = epoch + 1 WHERE id = ?");
  const stmtInsertMessage = db.prepare("INSERT INTO messages(channel_id, seq, sender, nonce, ciphertext, idem_key, created_at, encrypted, key_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const stmtMessageByIdem = db.prepare("SELECT seq FROM messages WHERE channel_id = ? AND idem_key = ?");
  const stmtMessagesSince = db.prepare("SELECT seq, nonce, ciphertext, encrypted, key_version FROM messages WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?");
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
  const stmtUseInviteCode = db.prepare("UPDATE invite_codes SET used_by = ?, status = 'used' WHERE channel_id = ? AND code_id = ? AND status = 'active'");  const stmtInviteCode = db.prepare("SELECT owner, used_by, status, expires_at FROM invite_codes WHERE channel_id = ? AND code_id = ?");
  const stmtSetRoles = db.prepare("UPDATE channels SET creator_member = ?, manager_member = ? WHERE id = ?");
  const stmtAudit = db.prepare("INSERT INTO audit_log(channel_id, ts, actor, action, target, result) VALUES (?, ?, ?, ?, ?, ?)");
  const stmtInsertInviteCode = db.prepare(
    "INSERT INTO invite_codes(channel_id, code_id, owner, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'active')",
  );
  const stmtSetAdmission = db.prepare(
    "UPDATE channels SET admission_mode = ?, visibility = ?, invite_policy = ?, contact_info = ? WHERE id = ?",
  );
  const stmtSetCredential = db.prepare(
    "UPDATE channels SET verify_key = ?, admission_credential_revoked = ? WHERE id = ?",
  );
  const stmtDirectory = db.prepare(`
    SELECT c.id, c.admission_mode, c.contact_info, c.visibility,
           (SELECT COUNT(*) FROM members m WHERE m.channel_id = c.id AND m.status = 'active') AS members
    FROM channels c
    WHERE c.visibility = 'public'
    ORDER BY c.created_at ASC
  `);
  const stmtLeave = db.prepare(
    "UPDATE members SET status = 'left', token_hash = NULL, token_expires_at = NULL WHERE channel_id = ? AND name = ?",
  );
  const stmtSetManager = db.prepare("UPDATE channels SET manager_member = ? WHERE id = ?");
  const stmtActiveCount = db.prepare(
    "SELECT COUNT(*) AS n FROM members WHERE channel_id = ? AND status = 'active'",
  );
  // Default successor rule (§2): most messages in the trailing 7 days among
  // active members excluding the leaving creator; tie → earliest joined.
  const stmtSuccessor = db.prepare(`
    SELECT m.name
    FROM members m
    LEFT JOIN (
      SELECT sender, COUNT(*) AS n FROM messages
      WHERE channel_id = ? AND created_at > ? AND sender IS NOT NULL
      GROUP BY sender
    ) c ON c.sender = m.name
    WHERE m.channel_id = ? AND m.status = 'active' AND m.name != ?
    ORDER BY COALESCE(c.n, 0) DESC, m.joined_at ASC
    LIMIT 1
  `);
  const stmtDissolve = {
    run(channelId: string): void {
      for (const t of ["members", "messages", "votes", "ballots", "member_bans", "invite_codes", "member_consumer_ids", "audit_log"]) {
        db.prepare(`DELETE FROM ${t} WHERE channel_id = ?`).run(channelId);
      }
      db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
    },
  };

  // ---- vote module (§4) ----
  const VOTE_DURATION_MS = 48 * 3_600_000;
  const VOTE_GLOBAL_COOLDOWN_MS = 4 * 3_600_000;
  const VOTE_INITIATOR_PASS_COOLDOWN_MS = 48 * 3_600_000;
  const VOTE_INITIATOR_FAIL_COOLDOWN_MS = 7 * 86_400_000;

  const stmtInsertVote = db.prepare(
    "INSERT INTO votes(channel_id, id, type, initiator, target, params_json, started_at, ends_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')",
  );
  const stmtOpenVote = db.prepare("SELECT id, type, initiator, target, started_at, ends_at FROM votes WHERE channel_id = ? AND status = 'open'");
  const stmtVoteById = db.prepare("SELECT * FROM votes WHERE channel_id = ? AND id = ?");
  const stmtOpenVotes = db.prepare("SELECT id, type, target, ends_at FROM votes WHERE channel_id = ? AND status = 'open'");
  const stmtVoteHistory = db.prepare("SELECT id, type, initiator, target, status, started_at, ends_at FROM votes WHERE channel_id = ? ORDER BY started_at DESC");
  const stmtBallots = db.prepare("SELECT voter_name, choice FROM ballots WHERE channel_id = ? AND vote_id = ?");
  const stmtInsertBallot = db.prepare(
    "INSERT INTO ballots(channel_id, vote_id, voter_name, choice) VALUES (?, ?, ?, ?)",
  );
  const stmtSettleVote = db.prepare("UPDATE votes SET status = ? WHERE channel_id = ? AND id = ? AND status = 'open'");
  const stmtActiveMembers = db.prepare("SELECT name FROM members WHERE channel_id = ? AND status = 'active'");
  const stmtSetCooldown = db.prepare("UPDATE channels SET vote_cooldown_until = ? WHERE id = ?");
  const stmtCooldown = db.prepare("SELECT vote_cooldown_until FROM channels WHERE id = ?");
  const stmtInitiatorLastPass = db.prepare(
    "SELECT MAX(ends_at) AS t FROM votes WHERE channel_id = ? AND initiator = ? AND status = 'passed'",
  );
  const stmtInitiatorLastFail = db.prepare(
    "SELECT MAX(ends_at) AS t FROM votes WHERE channel_id = ? AND initiator = ? AND status = 'failed'",
  );

  /** Active member names — the vote denominator universe. */
  function activeMemberNames(channelId: string): string[] {
    return (stmtActiveMembers.all(channelId) as Array<{ name: string }>).map((r) => r.name);
  }

  /** Threshold evaluation (§4): does the current tally pass? */
  function tallyPasses(channelId: string, target: string, cast: number, yes: number): boolean {
    const ch = stmtChannel.get(channelId) as ChannelRow;
    const leadership = target === ch.manager_member || target === ch.creator_member;
    if (leadership) {
      const turnoutOk = cast >= Math.ceil(ch2active(channelId) / 2);
      return turnoutOk && yes >= Math.ceil((2 * cast) / 3);
    }
    return yes > cast / 2;
  }

  function ch2active(channelId: string): number {
    return (stmtActiveCount.get(channelId) as { n: number }).n;
  }

  /**
   * Settle an open vote exactly once (guarded by the status transition).
   * `passed` applies the kick action; any settlement sets cooldowns.
   * Idempotent: a second call finds no open vote and does nothing.
   */
  function settleVote(channelId: string, voteId: string, passed: boolean): void {
    const updated = stmtSettleVote.run(passed ? "passed" : "failed", channelId, voteId);
    if (updated.changes === 0) return; // already settled — idempotent
    const vote = stmtVoteById.get(channelId, voteId) as
      | { type: string; initiator: string; target: string; params_json: string | null }
      | undefined;
    const now = Date.now();
    stmtSetCooldown.run(now + VOTE_GLOBAL_COOLDOWN_MS, channelId);
    if (!vote) return;
    if (passed && vote.type === "kick") {
      // v3 (spec §7): a vote whose target left mid-vote CONTINUES. The ban
      // applies on pass even to the departed member — it blocks re-entry at
      // the admission gate. applyKick tolerates a departed target (the member
      // row may be status 'left'; the ban row is what matters).
      const params = vote.params_json ? (JSON.parse(vote.params_json) as { banIp?: boolean; revokeInvitees?: boolean }) : {};
      const ip = (
        db.prepare("SELECT ip FROM member_bans WHERE channel_id = ? AND name = ?").get(channelId, vote.target) as
          | { ip: string | null }
          | undefined
      )?.ip ?? undefined;
      applyKick(db, channelId, vote.target, vote.initiator, { ip, banIp: params.banIp === true });
      if (params.revokeInvitees === true) {
        // Strip invite rights from everyone the target invited — EXCLUDING
        // the manager/creator (governance continuity, spec §4).
        const chRow = db.prepare("SELECT creator_member, manager_member FROM channels WHERE id = ?").get(channelId) as
          | { creator_member: string | null; manager_member: string | null }
          | undefined;
        db.prepare(
          "UPDATE members SET can_invite = 0 WHERE channel_id = ? AND name IN (SELECT used_by FROM invite_codes WHERE channel_id = ? AND owner = ?) AND name != ? AND name != ? AND name != ? AND name != ?",
        ).run(channelId, channelId, vote.target, vote.target, vote.initiator, chRow?.creator_member ?? "", chRow?.manager_member ?? "");
      }
      // Surgical invite-code disposition (invite tier, §4): the code the
      // target USED is revoked permanently; its owner is notified to mint a
      // fresh one (self-contained codes are owner-minted — the relay cannot
      // mint them).
      const usedCode = db.prepare("SELECT code_id, owner, status FROM invite_codes WHERE channel_id = ? AND used_by = ?").get(channelId, vote.target) as
        | { code_id: string; owner: string; status: string }
        | undefined;
      const notifiedOwners: string[] = [];
      if (usedCode && usedCode.status !== "revoked") {
        db.prepare("UPDATE invite_codes SET status = 'revoked' WHERE channel_id = ? AND code_id = ?").run(channelId, usedCode.code_id);
        if (!notifiedOwners.includes(usedCode.owner)) notifiedOwners.push(usedCode.owner);
      }
      // F-12: pass-path frozen codes (target's network) get the 7-day ban
      // expiry instead of staying frozen forever.
      db.prepare(
        "UPDATE invite_codes SET status = 'revoked', expires_at = ? WHERE channel_id = ? AND status = 'frozen'",
      ).run(now + 7 * 86_400_000, channelId);
      // Successor stat profile (§4 notice): when the target held a role, the
      // notice names the successor — roles already moved by applyKick.
      const ch2 = db.prepare("SELECT creator_member, manager_member FROM channels WHERE id = ?").get(channelId) as
        | { creator_member: string | null; manager_member: string | null }
        | undefined;
      const successor = ch2?.manager_member ?? null;
      db.prepare(
        "INSERT INTO audit_log(channel_id, ts, actor, action, target, result) VALUES (?, ?, ?, 'vote.kicked', ?, ?)",
      ).run(channelId, new Date().toISOString(), vote.initiator, vote.target, successor ?? "regular");
      // Stat profile attached to the settled frame (names/counters only —
      // blind-safe). Clients render with their own OS timezone.
      const prof = (target2: string) => {
        const total = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND sender = ?").get(channelId, target2) as { n: number }).n;
        const totalAll = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(channelId) as { n: number }).n;
        const m = db.prepare("SELECT joined_at, last_active_at FROM members WHERE channel_id = ? AND name = ?").get(channelId, target2) as { joined_at: string; last_active_at: string | null } | undefined;
        return {
          member: target2,
          joinedAt: m?.joined_at,
          lastActiveAt: m?.last_active_at,
          totalMessages: total,
          totalShare: totalAll > 0 ? Math.round((total / totalAll) * 100) : 0,
        };
      };
      // Successor attribution: only meaningful when the CREATOR role moved
      // (manager succession alone doesn't produce a "successor").
      const settleFrame: Record<string, unknown> = {
        type: "vote-settled",
        voteId,
        target: vote.target,
        outcome: "passed",
        profile: prof(vote.target),
        ...(successor && vote.target === (db.prepare("SELECT creator_member FROM channels WHERE id = ?").get(channelId) as { creator_member: string }).creator_member
          ? { successor, successorProfile: prof(successor) }
          : {}),
        ...(notifiedOwners.length > 0 ? { notifyCodeOwners: notifiedOwners } : {}),
      };
      wsHub?.notifyGovernance(channelId, settleFrame);
    }
    if (!passed && vote.type === "kick") {
      // failure lifts the lineage freeze exactly
      db.prepare("UPDATE invite_codes SET status = 'active' WHERE channel_id = ? AND status = 'frozen'").run(channelId);
      wsHub?.notifyGovernance(channelId, {
        type: "vote-settled",
        voteId,
        target: vote.target,
        outcome: "failed",
      });
    }
  }

  function checkSettle(channelId: string, voteId: string): void {
    const vote = stmtVoteById.get(channelId, voteId) as
      | { status: string; target: string; initiator: string; ends_at: number }
      | undefined;
    if (!vote || vote.status !== "open") return;
    const ballots = stmtBallots.all(channelId, voteId) as Array<{ voter_name: string; choice: string }>;
    const yes = ballots.filter((b) => b.choice === "yes").length;
    const cast = ballots.length;
    const ch = stmtChannel.get(channelId) as ChannelRow;
    const leadership = vote.target === ch.manager_member || vote.target === ch.creator_member;
    const active = activeMemberNames(channelId);
    // The target cannot vote — but only subtract them when they are actually
    // among the active members (a departed target no longer suppresses anyone
    // else's ballot; v3 §7 ballot math counts the REMAINING eligible voters).
    const eligible = active.includes(vote.target) ? active.length - 1 : active.length;
    const remaining = eligible - cast;
    // EARLY PASS — even a unanimous remaining "no" cannot flip the outcome.
    if (leadership) {
      const turnoutWillBeMet = cast >= Math.ceil(active.length / 2) || cast + remaining >= Math.ceil(active.length / 2);
      const yesWillBeMet = yes >= Math.ceil((2 * (cast + remaining)) / 3);
      if (turnoutWillBeMet && yesWillBeMet) {
        settleVote(channelId, voteId, true);
        return;
      }
    } else if (yes > (cast + remaining) / 2) {
      settleVote(channelId, voteId, true);
      return;
    }
    // EARLY FAIL — even a unanimous remaining "yes" cannot flip the outcome.
    const bestCaseYes = yes + remaining;
    if (leadership) {
      const eventualCast = cast + remaining;
      if (bestCaseYes < Math.ceil((2 * eventualCast) / 3)) {
        settleVote(channelId, voteId, false);
      }
      // Remaining ballots always count toward cast, so turnout only grows —
      // no separate early-fail on turnout is possible.
      return;
    }
    if (bestCaseYes <= cast / 2) {
      settleVote(channelId, voteId, false);
    }
  }

  function settleExpiredVotes(): void {
    const now = Date.now();
    const expired = db
      .prepare("SELECT channel_id, id, target FROM votes WHERE status = 'open' AND ends_at <= ?")
      .all(now) as Array<{ channel_id: string; id: string; target: string }>;
    for (const v of expired) {
      const ballots = stmtBallots.all(v.channel_id, v.id) as Array<{ choice: string }>;
      const yes = ballots.filter((b) => b.choice === "yes").length;
      settleVote(v.channel_id, v.id, tallyPasses(v.channel_id, v.target, ballots.length, yes));
    }
  }

  function dissolve(channelId: string): void {
    stmtDissolve.run(channelId);
  }

  function defaultSuccessor(channelId: string, leavingCreator: string): string | null {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const row = stmtSuccessor.get(channelId, since, channelId, leavingCreator) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /** Governance audit trail (§4b): every governance operation lands here. */
  function audit(channelId: string, actor: string, action: string, target?: string, result?: string): void {
    stmtAudit.run(channelId, new Date().toISOString(), actor, action, target ?? null, result ?? null);
  }

  // ---- user / consumer model (governance v2 §3) ----

  const stmtUserByName = db.prepare("SELECT user_id FROM users WHERE name = ?");
  const stmtInsertUser = db.prepare(
    "INSERT INTO users(user_id, name, ip, os_type, os_version, mcp_version, token_hash, registered_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const stmtUpdateUserProfile = db.prepare(
    "UPDATE users SET ip = COALESCE(?, ip), os_type = COALESCE(?, os_type), os_version = COALESCE(?, os_version), mcp_version = COALESCE(?, mcp_version), token_hash = ?, last_active_at = ? WHERE user_id = ?",
  );
  const stmtUserByTokenHash = db.prepare("SELECT user_id FROM users WHERE token_hash = ?");
  const stmtBindUserToken = db.prepare("UPDATE users SET token_hash = ? WHERE user_id = ?");
  const stmtUserById = db.prepare("SELECT user_id, name, ip, os_type, os_version, mcp_version, registered_at, last_active_at FROM users WHERE user_id = ?");
  const stmtUpsertConsumer = db.prepare(
    "INSERT INTO consumers(consumer_id, user_id, agent_type, agent_version, session_id, last_active_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(consumer_id) DO UPDATE SET user_id = excluded.user_id, agent_type = COALESCE(excluded.agent_type, consumers.agent_type), agent_version = COALESCE(excluded.agent_version, consumers.agent_version), session_id = COALESCE(excluded.session_id, consumers.session_id), last_active_at = excluded.last_active_at",
  );
  const stmtTouchConsumer = db.prepare(
    "INSERT INTO consumers(consumer_id, user_id, last_active_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(consumer_id) DO UPDATE SET user_id = excluded.user_id, last_active_at = excluded.last_active_at",
  );
  const stmtConsumersOfUser = db.prepare(
    "SELECT consumer_id, agent_type, agent_version, session_id, last_active_at FROM consumers WHERE user_id = ? ORDER BY last_active_at DESC",
  );

  const USER_NAME_MAX = 64;
  const USER_FIELD_MAX = 64;

  function validUserField(v: unknown, max = USER_FIELD_MAX): v is string {
    return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= max;
  }

  function clientIp(req: Request): string | null {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) {
      const first = fwd.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.headers.get("x-real-ip");
  }

  /**
   * Find-or-create the relay-global user for a join. Identity key: user name
   * (client sends its machine hostname; legacy clients fall back to the
   * member name). Profile fields are refresh-on-join (COALESCE keeps the
   * first-seen value when a later join omits them); the token hash is
   * overwritten — the LATEST issued token is the live user token.
   */
  function upsertUser(spec: { name: string; ip: string | null; osType?: string; osVersion?: string; mcpVersion?: string }, tokenHash: string): string {
    const now = new Date().toISOString();
    const existing = stmtUserByName.get(spec.name) as { user_id: string } | undefined;
    if (existing) {
      stmtUpdateUserProfile.run(spec.ip, spec.osType ?? null, spec.osVersion ?? null, spec.mcpVersion ?? null, tokenHash, now, existing.user_id);
      return existing.user_id;
    }
    const userId = `u${randomBytes(8).toString("hex")}`;
    stmtInsertUser.run(userId, spec.name, spec.ip, spec.osType ?? null, spec.osVersion ?? null, spec.mcpVersion ?? null, tokenHash, now, now);
    return userId;
  }

  /** Parse the optional join/consumers `user` block into bounded strings. */
  function parseUserSpec(body: Record<string, unknown>, fallbackName: string): { name: string; osType?: string; osVersion?: string; mcpVersion?: string } {
    const raw = body.user;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { name: fallbackName };
    }
    const u = raw as Record<string, unknown>;
    return {
      name: validUserField(u.name, USER_NAME_MAX) ? (u.name as string).trim() : fallbackName,
      ...(validUserField(u.osType) ? { osType: (u.osType as string).trim() } : {}),
      ...(validUserField(u.osVersion) ? { osVersion: (u.osVersion as string).trim() } : {}),
      ...(validUserField(u.mcpVersion) ? { mcpVersion: (u.mcpVersion as string).trim() } : {}),
    };
  }

  function parseAgentSpec(body: Record<string, unknown>): { agentType?: string; agentVersion?: string; sessionId?: string } {
    return {
      ...(validUserField(body.agentType, 32) ? { agentType: (body.agentType as string).trim() } : {}),
      ...(validUserField(body.agentVersion, 32) ? { agentVersion: (body.agentVersion as string).trim() } : {}),
      ...(validUserField(body.sessionId, 128) ? { sessionId: (body.sessionId as string).trim() } : {}),
    };
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
    settleExpiredVotes();
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
    if (!token) {
      if (process.env.SCM_DEBUG) console.error("auth-debug: no token", new URL(req.url).pathname);
      return null;
    }
    const channel = stmtChannel.get(channelId) as ChannelRow | undefined;
    if (!channel) {
      if (process.env.SCM_DEBUG) console.error("auth-debug: no channel", channelId);
      return null;
    }
    const member = stmtMemberByToken.get(channelId, sha256Hex(token)) as MemberRow | undefined;
    if (!member) {
      if (process.env.SCM_DEBUG) {
        // Same-channel only: never dump cross-channel member data.
        const all = db.prepare("SELECT name, status FROM members WHERE channel_id = ?").all(channelId);
        console.error("auth-debug: no member by token", channelId, JSON.stringify(all));
      }
      return null;
    }
    const now = Date.now();
    if (!isLiveToken(member, channel, now)) {
      if (process.env.SCM_DEBUG) console.error("auth-debug: token not live", member.token_expires_at, member.epoch, channel.epoch);
      return null;
    }
    const memberBanned = member.status === "banned";
    // Consumer binding: a presented consumer id must not be consumer-banned
    // (any ban row in the channel — same rule as the admission gate), and is
    // auto-registered/refreshed. Writes are skipped for read-only requests
    // (last_seen refresh is a write; polling hot paths stay read-only).
    const consumer = req.headers.get("x-scm-consumer");
    let consumerBanned = false;
    const isWrite = req.method !== "GET";
    if (consumer !== null && consumer !== "") {
      const banRows = db.prepare("SELECT name, consumer_ids FROM member_bans WHERE channel_id = ? AND consumer_ids IS NOT NULL").all(channelId) as Array<{ name: string; consumer_ids: string }>;
      for (const row of banRows) {
        try {
          const bannedConsumers: string[] = JSON.parse(row.consumer_ids);
          if (Array.isArray(bannedConsumers) && bannedConsumers.includes(consumer)) consumerBanned = true;
        } catch { /* malformed ban entry — ignore consumer check */ }
      }
      if (!consumerBanned && isWrite) {
        stmtRegisterConsumer.run(channelId, member.name, consumer, new Date().toISOString());
        // User/consumer ledger (governance v2 §3): a valid token + a fresh
        // consumer id is a registration — the consumer auto-joins the user's
        // ledger without an explicit /consumers call. The user's own
        // last_active_at rides the same write.
        if (member.user_id) {
          const nowIso = new Date().toISOString();
          stmtTouchConsumer.run(consumer, member.user_id, nowIso);
          db.prepare("UPDATE users SET last_active_at = ? WHERE user_id = ?").run(nowIso, member.user_id);
        }
      }
    }
    if (memberBanned || consumerBanned) return "banned";
    return { channel, member };
  }

  const stmtMemberStatsPerDay = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND created_at LIKE ?",
  );
  const stmtMemberStatsSenderDay = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND sender = ? AND created_at LIKE ?",
  );

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
    (channelId: string, sender: string, nonce: string, ciphertext: string, idemKey: string, encrypted: number, keyVersion: number): { seq: number; epoch: number; deduped: boolean } => {
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
      stmtInsertMessage.run(channelId, allocated.seq, sender, nonce, ciphertext, idemKey, new Date().toISOString(), encrypted, keyVersion);
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
      // v3 (spec §2.2): visibility defaults 'public'; admissionMode defaults
      // 'password'; the pair is strictly validated (private+no_limit → 400)
      // BEFORE anything is written.
      const visibility = typeof parsed.body.visibility === "string" ? parsed.body.visibility : "public";
      const admissionModeRaw = parsed.body.admissionMode;
      const mode = typeof admissionModeRaw === "string" ? admissionModeRaw : "password";
      const shape = validateChannelShape(visibility, mode);
      if (!shape.ok) return jsonError(400, shape.error);
      stmtInsertChannel.run(channelId, verifyKeyB64, new Date().toISOString());
      // reserve the creator's member name (no token yet → not "live",
      // so the creator can still join under it)
      stmtUpsertMember.run(channelId, (memberName as string).trim(), null, null, 1, new Date().toISOString());
      // Governance: the creating member is creator AND manager (§2). Optional
      // admission mode/policy/contact/visibility come from the create payload.
      const invitePolicy = parsed.body.invitePolicy === "managers-only" ? "managers-only" : "everyone";
      const contactInfo = typeof parsed.body.contactInfo === "string" ? (parsed.body.contactInfo as string) : null;
      const probationEnabled = parsed.body.probationEnabled === true ? 1 : 0;
      const inviteSkipsProbation = parsed.body.inviteSkipsProbation === false ? 0 : 1;
      const stmtSetRolesAndAdmission = db.prepare(
        "UPDATE channels SET creator_member = ?, manager_member = ?, admission_mode = ?, visibility = ?, probation_enabled = ?, invite_skips_probation = ?, invite_policy = ?, contact_info = ? WHERE id = ?",
      );
      stmtSetRolesAndAdmission.run((memberName as string).trim(), (memberName as string).trim(), mode, visibility, probationEnabled, inviteSkipsProbation, invitePolicy, contactInfo, channelId);
      audit(channelId, (memberName as string).trim(), "channel.created", channelId, `mode=${mode}`);
      return json({ channelId, epoch: 1, nextSeq: 1 });
    }

    // ---- /directory — public listing of opted-in channels (§6) ----
    if (path === "/directory" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const rows = stmtDirectory.all() as Array<{
        id: string;
        admission_mode: string;
        contact_info: string | null;
        members: number;
      }>;
      const channels = rows
        .filter((r) => q === "" || r.id.toLowerCase().includes(q) || (r.contact_info ?? "").toLowerCase().includes(q))
        .map((r) => ({
          channelId: r.id,
          admissionMode: r.admission_mode,
          members: r.members,
          ...(r.contact_info ? { contactInfo: r.contact_info } : {}),
        }));
      return json({ channels });
    }

    // ---- /channels/:id/votes/:vid/ballot — cast a ballot ----
    const ballotMatch = path.match(/^\/channels\/([^/]+)\/votes\/([^/]+)\/ballot$/);
    if (ballotMatch && method === "POST") {
      const [, channelId, voteId] = ballotMatch;
      const auth = authenticate(channelId, req);
      if (auth === "banned") return jsonError(403, "banned");
      if (!auth) return jsonError(401, "unauthorized");
      const voter = auth.member.name;
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.resp;
      const choice = parsed.body.choice;
      if (choice !== "yes" && choice !== "no") return jsonError(400, "invalid request: choice must be yes|no");
      const vote = stmtVoteById.get(channelId, voteId) as
        | { status: string; initiator: string; target: string; ends_at: number }
        | undefined;
      if (!vote) return jsonError(404, "vote not found");
      if (vote.status !== "open") return jsonError(409, "vote settled");
      // Expired-but-unswept (the sweep runs on an interval): settle now, then
      // reject the late ballot.
      if (vote.ends_at <= Date.now()) {
        checkSettle(channelId, voteId);
        settleExpiredVotes();
        return jsonError(409, "vote settled");
      }
      if (vote.target === voter) return jsonError(403, "target cannot vote");
      // checkSettle may settle early; ballot insert first, then settle check
      try {
        stmtInsertBallot.run(channelId, voteId, voter, choice);
      } catch {
        return jsonError(409, "already voted");
      }
      checkSettle(channelId, voteId);
      return json({ ok: true });
    }

    // ---- /channels/:id/... ----
    const match = path.match(/^\/channels\/([^/]+)(?:\/(challenge|join|messages|meta|rotate|rotate-key|activity|consumers|token-refresh|invite-codes|set-admission|set-credential|set-encryption|transfer|leave|votes|votes\/[^/]+\/ballot|bans|unban|invite-rights|member-stats|dissolve|audit|me))?$/);
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
        // Admission gate per tier (§1): public = open; invite = code required;
        // password = credential proof. Creator (reserved, not yet joined)
        // always admits with the credential. A governance kick invalidates
        // the credential — only a manager/creator credential rotation
        // re-enables admission. The BAN LIST is enforced here too: a banned
        // name, or a banned consumer id under ANY name, is rejected at the
        // gate — kicks must survive new-name re-entry attempts.
        const mode = channel.admission_mode ?? "password";
        const isCreator = channel.creator_member === memberName;
        let pendingInviteCodeId: string | null = null;
        const banRowGate = stmtBanRow.get(channelId, memberName) as { consumer_ids: string | null } | undefined;
        if (banRowGate) return jsonError(403, "banned");
        if (consumerId) {
          const allBans = db.prepare("SELECT consumer_ids FROM member_bans WHERE channel_id = ? AND consumer_ids IS NOT NULL").all(channelId) as Array<{ consumer_ids: string }>;
          const bannedConsumer = allBans.some((r) => {
            try {
              const arr: string[] = JSON.parse(r.consumer_ids);
              return Array.isArray(arr) && arr.includes(consumerId);
            } catch { return false; }
          });
          if (bannedConsumer) return jsonError(403, "banned");
        }
        if (mode === "password" && channel.admission_credential_revoked === 1 && !isCreator) {
          return jsonError(403, "admission credential revoked");
        }
        if (mode === "invite" && !isCreator) {
          const codeId = parsed.body.inviteCodeId;
          if (typeof codeId !== "string" || codeId.length === 0) {
            return jsonError(403, "invite code required");
          }
          const code = stmtInviteCode.get(channelId, codeId) as
            | { owner: string; used_by: string | null; status: string; expires_at: number | null }
            | undefined;
          if (!code || code.status !== "active") return jsonError(403, "invite code invalid");
          if (code.expires_at !== null && code.expires_at <= now) return jsonError(403, "invite code expired");
          if (code.used_by !== null) return jsonError(403, "invite code already used");
          // Consumption is DEFERRED until admission succeeds (F-4): a failed
          // join must not burn a single-use code.
          pendingInviteCodeId = codeId;
        }
        const proof = parsed.body.proof;
        const needsProof = mode === "password" || (isCreator && mode !== "no_limit");
        if (
          needsProof &&
          (typeof proof !== "string" || proof.length === 0 || proof.length > 128)
        ) {
          return jsonError(400, "invalid request: proof must be a base64 string");
        }
        const key = challengeKey(channelId, memberName);
        const pending = needsProof ? challenges.get(key) : { nonceB64: "", expiresAt: now + 1000 };
        if (!pending || pending.expiresAt <= now) {
          challenges.delete(key);
          return jsonError(400, "no pending challenge: request one first");
        }
        if (needsProof) {
          // Verify possession WITHOUT learning the password: expected proof =
          // HMAC-SHA256(verification key, nonce). The verification key cannot
          // decrypt messages (it is not the channel key).
          const expected = hmacProof(new Uint8Array(Buffer.from(channel.verify_key, "base64")), pending.nonceB64);
          if (!safeEqualStr(proof as string, expected)) {
            return jsonError(401, "auth failed: wrong password");
          }
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
        // User/consumer model (§3): the token binds to the relay-global USER,
        // not the channel. Find-or-create the user (identity key: client
        // hostname; legacy clients fall back to the member name), bind the
        // token, link the member row, and register the consumer under it.
        const agentSpec = parseAgentSpec(parsed.body);
        const userSpec = parseUserSpec(parsed.body, memberName);
        const userId = upsertUser({ ...userSpec, ip: clientIp(req) }, sha256Hex(token));
        db.prepare("UPDATE members SET user_id = ? WHERE channel_id = ? AND name = ?").run(userId, channelId, memberName);
        stmtUpsertConsumer.run(
          consumerId,
          userId,
          agentSpec.agentType ?? null,
          agentSpec.agentVersion ?? null,
          agentSpec.sessionId ?? null,
          new Date().toISOString(),
        );
        if (pendingInviteCodeId !== null) {
          // Admission succeeded — consume the code (F-4).
          stmtUseInviteCode.run(memberName, channelId, pendingInviteCodeId);
        }
        // v3 probation (spec §6): probated joins land in the trial tier with a
        // 7-day probation_until. Skipped by invite joins while
        // invite_skips_probation is set (default), and always for the creator.
        const probationEnabled = (channel.probation_enabled ?? 0) === 1;
        const inviteJoinSkips = pendingInviteCodeId !== null && (channel.invite_skips_probation ?? 1) === 1;
        if (probationEnabled && !inviteJoinSkips && !isCreator) {
          db.prepare("UPDATE members SET probation_until = ?, permission_role = 'trial' WHERE channel_id = ? AND name = ?").run(
            new Date(now + 7 * 86_400_000).toISOString(),
            channelId,
            memberName,
          );
          audit(channelId, memberName, "member.probation", memberName, "until=" + new Date(now + 7 * 86_400_000).toISOString());
        }
        challenges.delete(key); // one-time use
        audit(channelId, memberName, "member.joined", memberName, "ok");
        return json({ token, epoch: channel.epoch, memberName, userId });
      }

      case "consumers": {
        // Register an ADDITIONAL consumer id under this membership (multi-
        // session processes share one member). Token-authenticated. Also
        // recorded in the user-level consumer ledger (governance v2 §3).
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
        if (auth.member.user_id) {
          const agentSpec = parseAgentSpec(parsed.body);
          stmtUpsertConsumer.run(
            consumerId,
            auth.member.user_id,
            agentSpec.agentType ?? null,
            agentSpec.agentVersion ?? null,
            agentSpec.sessionId ?? null,
            new Date().toISOString(),
          );
        }
        return json({ ok: true });
      }

      case "me": {
        // Identity card of the authenticated member's relay-global user
        // (governance v2 §3): profile + the consumer ledger (agent
        // processes/sessions) registered under it.
        if (method !== "GET") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const userId = auth.member.user_id;
        if (!userId) {
          // Pre-model member (joined before the users table existed): the
          // identity is channel-local only.
          return json({ userId: null, user: null, consumers: [] });
        }
        const user = stmtUserById.get(userId) as
          | { user_id: string; name: string; ip: string | null; os_type: string | null; os_version: string | null; mcp_version: string | null; registered_at: string; last_active_at: string }
          | undefined;
        if (!user) return json({ userId: null, user: null, consumers: [] });
        const consumers = stmtConsumersOfUser.all(userId) as Array<{
          consumer_id: string; agent_type: string | null; agent_version: string | null; session_id: string | null; last_active_at: string;
        }>;
        return json({
          userId,
          user: {
            userId: user.user_id,
            name: user.name,
            ip: user.ip,
            osType: user.os_type,
            osVersion: user.os_version,
            mcpVersion: user.mcp_version,
            registeredAt: user.registered_at,
            lastActiveAt: user.last_active_at,
          },
          consumers: consumers.map((c) => ({
            consumerId: c.consumer_id,
            agentType: c.agent_type ?? undefined,
            agentVersion: c.agent_version ?? undefined,
            sessionId: c.session_id ?? undefined,
            lastActiveAt: c.last_active_at,
          })),
        });
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
        // Rebind the user-scoped token: the refreshed token becomes the live
        // user token; the old one stops resolving everywhere.
        if (auth.member.user_id) {
          stmtBindUserToken.run(sha256Hex(token), auth.member.user_id);
        }
        audit(channelId, auth.member.name, "token.refreshed", auth.member.name, "ok");
        return json({ token, epoch: channel.epoch, memberName: auth.member.name, ...(auth.member.user_id ? { userId: auth.member.user_id } : {}) });
      }

      case "invite-codes": {
        // Register a minted invite code (the code itself is client-minted and
        // self-contained; the relay only records the ledger entry). Mint
        // right: manager/creator always; regular members per invite_policy
        // and their can_invite flag.
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const codeId = parsed.body.codeId;
        const expiresAt = parsed.body.expiresAt;
        if (typeof codeId !== "string" || codeId.length < 8 || codeId.length > 128) {
          return jsonError(400, "invalid request: codeId must be a string of 8..128 characters");
        }
        const isManagerOrCreator =
          auth.member.name === auth.channel.manager_member || auth.member.name === auth.channel.creator_member;
        const policy = auth.channel.invite_policy ?? "everyone";
        if (!isManagerOrCreator && (policy !== "everyone" || auth.member.can_invite !== 1)) {
          return jsonError(403, "invite right revoked or managers-only policy");
        }
        const exp = typeof expiresAt === "number" && expiresAt > now ? expiresAt : null;
        try {
          stmtInsertInviteCode.run(channelId, codeId, auth.member.name, new Date().toISOString(), exp);
        } catch {
          return jsonError(409, "invite code id already registered");
        }
        audit(channelId, auth.member.name, "invite.minted", codeId, "ok");
        return json({ ok: true, codeId });
      }

      case "set-admission": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const name = auth.member.name;
        if (name !== auth.channel.manager_member && name !== auth.channel.creator_member) {
          return jsonError(403, "manager or creator only");
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const mode = parsed.body.mode;
        const visibility = parsed.body.visibility;
        if (mode === undefined && visibility === undefined && parsed.body.invitePolicy === undefined && parsed.body.contactInfo === undefined) {
          return jsonError(400, "invalid request: mode, visibility, invitePolicy or contactInfo required");
        }
        if (visibility !== undefined && visibility !== "public" && visibility !== "private") {
          return jsonError(400, "invalid request: visibility must be public|private");
        }
        if (mode !== undefined && mode !== "no_limit" && mode !== "invite" && mode !== "password") {
          return jsonError(400, "invalid request: mode must be no_limit|invite|password");
        }
        // v3 (spec §2.2): the (visibility, admission) PAIR is validated against
        // the effective post-change values — flipping visibility to private on
        // a no_limit channel is rejected instead of silently coerced.
        const nextMode = typeof mode === "string" ? mode : (auth.channel.admission_mode ?? "password");
        const nextVisibility = typeof visibility === "string" ? visibility : (auth.channel.visibility ?? "public");
        const shape = validateChannelShape(nextVisibility, nextMode);
        if (!shape.ok) return jsonError(400, shape.error);
        const invitePolicy = parsed.body.invitePolicy;
        if (invitePolicy !== undefined && invitePolicy !== "everyone" && invitePolicy !== "managers-only") {
          return jsonError(400, "invalid request: invitePolicy must be everyone|managers-only");
        }
        const contactInfo = parsed.body.contactInfo;
        if (contactInfo !== undefined && typeof contactInfo !== "string") {
          return jsonError(400, "invalid request: contactInfo must be a string");
        }
        stmtSetAdmission.run(
          nextMode,
          nextVisibility,
          typeof invitePolicy === "string" ? invitePolicy : auth.channel.invite_policy,
          typeof contactInfo === "string" ? contactInfo : auth.channel.contact_info,
          channelId,
        );
        // Spec §2.3: switching visibility to private DELETES the relay-held
        // sealed key copy. (Blind-ness is only fully restored by an owner key
        // rotation — the relay has seen the old key — but no copy may remain.)
        if (nextVisibility === "private") {
          db.prepare("UPDATE channels SET sealed_key = NULL WHERE id = ?").run(channelId);
        }
        audit(channelId, name, "admission.changed", nextMode, `visibility=${nextVisibility}`);
        return json({
          ok: true,
          mode: nextMode,
          visibility: nextVisibility,
          ...(nextMode === "password" && auth.channel.admission_credential_revoked === 1
            ? { warning: "admission credential was revoked by a kick — run `rotate --mode access` to mint a fresh credential before accepting new members" }
            : {}),
        });
      }

      case "transfer": {
        // Creator hands the manager role to another active member.
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        if (auth.member.name !== auth.channel.creator_member) {
          return jsonError(403, "creator only");
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const to = parsed.body.to;
        if (typeof to !== "string" || !validMemberName(to)) {
          return jsonError(400, "invalid request: to must be a valid member name");
        }
        const target = stmtMemberByName.get(channelId, to) as MemberRow | undefined;
        if (!target || target.status !== "active") return jsonError(400, "transfer target must be an active member");
        stmtSetRoles.run(auth.channel.creator_member, to, channelId);
        audit(channelId, auth.member.name, "role.transferred", to, "manager");
        wsHub?.notifyGovernance(channelId, { type: "role-changed", manager: to });
        return json({ ok: true, manager: to });
      }

      case "leave": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const parsed = await readJson(req);
        const name = auth.member.name;
        const isCreator = name === auth.channel.creator_member;
        const isManager = name === auth.channel.manager_member;
        let transferTo: string | null = null;
        if (parsed.ok && typeof parsed.body.transferTo === "string" && validMemberName(parsed.body.transferTo)) {
          const t = (parsed.body.transferTo as string).trim();
          const tRow = stmtMemberByName.get(channelId, t) as MemberRow | undefined;
          if (!tRow || tRow.status !== "active") return jsonError(400, "transferTo must be an active member");
          if (t === name) return jsonError(400, "transferTo must differ from the leaving member");
          transferTo = t;
        }
        // Mark left + revoke tokens.
        stmtLeave.run(channelId, name);
        // v3 (spec §7): an open kick vote targeting the leaver is NOT voided —
        // the vote continues over the remaining eligible voters and a pass
        // bans the departed member (blocking re-entry).
        // Succession.
        if (isCreator) {          const successor =
            transferTo !== null && transferTo !== name
              ? transferTo
              : defaultSuccessor(channelId, name);
          if (successor) {
            const oldManager = auth.channel.manager_member;
            // creator leaves → successor takes creator; manager passes too if
            // the leaving creator was also the manager
            stmtSetRoles.run(successor, oldManager === name ? successor : oldManager, channelId);
            audit(channelId, name, "role.transferred", successor, "creator");
            wsHub?.notifyGovernance(channelId, { type: "role-changed", creator: successor, manager: oldManager === name ? successor : (oldManager ?? "") });
          } else {
            // nobody to hand over to → dissolution below
          }
        } else if (isManager) {
          // manager (not creator) leaves → reverts to creator
          const creator = auth.channel.creator_member ?? "";
          stmtSetManager.run(creator, channelId);
          audit(channelId, name, "role.reverted", creator, "manager");
          wsHub?.notifyGovernance(channelId, { type: "role-changed", manager: creator });
        }
        // Dissolution: no active members remain. The audit entry is written
        // BEFORE the wipe — dissolve() deletes this channel's audit_log rows,
        // so an entry written after would be silently lost (ordering matters
        // for any external audit sink too).
        const activeLeft = stmtActiveCount.get(channelId) as { n: number };
        if ((activeLeft?.n ?? 0) === 0) {
          audit(channelId, name, "channel.dissolved", channelId, "last member left");
          dissolve(channelId);
          // Dissolved: evict every live connection for the dead channel.
          wsHub?.invalidateChannel(channelId, 0);
        } else {
          wsHub?.notifyGovernance(channelId, { type: "member-left", member: name });
        }
        return json({ ok: true, dissolved: (activeLeft?.n ?? 0) === 0 });
      }

      case "votes": {
        if (method === "POST") {
          // OPEN a vote (CLI-facing; the relay accepts any active member —
          // the CLI-only rule is a surface rule, enforced by tool presence).
          const auth = authenticate(channelId, req);
          if (auth === "banned") return jsonError(403, "banned");
          if (!auth) return jsonError(401, "unauthorized");
          const initiator = auth.member.name;
          const parsed = await readJson(req);
          if (!parsed.ok) return parsed.resp;
          const type = parsed.body.type;
          if (type !== "kick") return jsonError(400, "invalid request: type must be kick (v1)");
          const target = parsed.body.target;
          if (typeof target !== "string" || !validMemberName(target)) {
            return jsonError(400, "invalid request: target must be a valid member name");
          }
          if (target === initiator) return jsonError(400, "invalid request: target must differ from initiator");
          const targetRow = stmtMemberByName.get(channelId, target) as MemberRow | undefined;
          if (!targetRow || targetRow.status !== "active") {
            return jsonError(400, "invalid request: target must be an active member");
          }
          // single open vote per channel
          const open = stmtOpenVote.get(channelId) as { id: string } | undefined;
          if (open) return jsonError(409, "a vote is already open");
          // cooldowns: global + initiator
          const cooldown = (stmtCooldown.get(channelId) as { vote_cooldown_until: number | null } | undefined)
            ?.vote_cooldown_until ?? 0;
          if (cooldown > Date.now()) return jsonError(429, "vote cooldown active");
          const lastPass = (stmtInitiatorLastPass.get(channelId, initiator) as { t: number | null }).t ?? 0;
          if (Date.now() - lastPass < VOTE_INITIATOR_PASS_COOLDOWN_MS) {
            return jsonError(429, "initiator cooldown (passed vote)");
          }
          const lastFail = (stmtInitiatorLastFail.get(channelId, initiator) as { t: number | null }).t ?? 0;
          if (Date.now() - lastFail < VOTE_INITIATOR_FAIL_COOLDOWN_MS) {
            return jsonError(429, "initiator cooldown (failed vote)");
          }
          const active = activeMemberNames(channelId);
          if (active.length < 3) return jsonError(400, "at least 3 active members required");
          if (!active.includes(target)) return jsonError(400, "target must be an active member");
          const voteId = randomBytes(8).toString("hex");
          const params: Record<string, unknown> = {};
          if (parsed.body.banIp === true) params.banIp = true;
          if (parsed.body.revokeInvitees === true) params.revokeInvitees = true;
          const now = Date.now();
          stmtInsertVote.run(
            channelId,
            voteId,
            "kick",
            initiator,
            target,
            JSON.stringify(params),
            new Date().toISOString(),
            now + VOTE_DURATION_MS,
          );
          // Lineage freeze: target's code + codes of everyone the target
          // invited (invite tier semantics; no-op in password mode).
          db.prepare(
            "UPDATE invite_codes SET status = 'frozen' WHERE channel_id = ? AND (owner = ? OR used_by = ?) AND status = 'active'",
          ).run(channelId, target, target);
          audit(channelId, initiator, "vote.opened", target, `vote ${voteId} type kick`);
          wsHub?.notifyGovernance(channelId, { type: "vote-open", voteId, target, endsAt: now + VOTE_DURATION_MS });
          return json({ ok: true, voteId, endsAt: now + VOTE_DURATION_MS });
        }
        if (method === "GET") {
          const auth = authenticate(channelId, req);
          if (auth === "banned") return jsonError(403, "banned");
          if (!auth) return jsonError(401, "unauthorized");
          const open = stmtOpenVotes.all(channelId) as Array<{ id: string; type: string; target: string; ends_at: number }>;
          const history = stmtVoteHistory.all(channelId) as Array<{
            id: string; type: string; initiator: string; target: string; status: string; started_at: string; ends_at: number;
          }>;
          const withTallies = history.map((v) => {
            const ballots = stmtBallots.all(channelId, v.id) as Array<{ choice: string }>;
            return { ...v, yes: ballots.filter((b) => b.choice === "yes").length, no: ballots.filter((b) => b.choice === "no").length };
          });
          return json({
            open: open.map((v) => ({ id: v.id, type: v.type, target: v.target, endsAt: v.ends_at })),
            history: withTallies,
          });
        }
        return jsonError(405, "method not allowed");
      }

      case "bans": {
        if (method !== "GET") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const rows = db.prepare("SELECT name, consumer_ids, ip, banned_at, banned_by FROM member_bans WHERE channel_id = ?").all(channelId);
        return json({ bans: rows });
      }

      case "unban": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        if (auth.member.name !== auth.channel.manager_member && auth.member.name !== auth.channel.creator_member) {
          return jsonError(403, "manager or creator only");
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const name = parsed.body.name;
        if (typeof name !== "string" || !validMemberName(name)) return jsonError(400, "invalid request: name must be a valid member name");
        const res = db.prepare("DELETE FROM member_bans WHERE channel_id = ? AND name = ?").run(channelId, name);
        // Unban ≠ readmission: clear the ban AND revoke tokens — the person
        // re-admits with valid credentials (current password / fresh code).
        if (res.changes > 0) {
          db.prepare("UPDATE members SET status = 'active', token_hash = NULL, token_expires_at = NULL WHERE channel_id = ? AND name = ?").run(channelId, name);
        }
        audit(channelId, auth.member.name, res.changes > 0 ? "member.unbanned" : "unban.noop", name, res.changes > 0 ? "ok" : "no ban row");
        return json({
          ok: res.changes > 0,
          ...(res.changes > 0 && (auth.channel.admission_mode ?? "password") === "password"
            ? { reminder: "readmission requires the CURRENT admission credential — fetch it from the manager/creator" }
            : {}),
        });
      }

      case "invite-rights": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        if (auth.member.name !== auth.channel.manager_member && auth.member.name !== auth.channel.creator_member) {
          return jsonError(403, "manager or creator only");
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const name = parsed.body.name;
        const canInvite = parsed.body.canInvite;
        if (typeof name !== "string" || !validMemberName(name) || (canInvite !== 0 && canInvite !== 1)) {
          return jsonError(400, "invalid request: name (member) and canInvite (0|1) required");
        }
        const target = stmtMemberByName.get(channelId, name) as MemberRow | undefined;
        if (!target || target.status !== "active") return jsonError(400, "target must be an active member");
        db.prepare("UPDATE members SET can_invite = ? WHERE channel_id = ? AND name = ?").run(canInvite, channelId, name);
        if (canInvite === 0) {
          // strip their active codes too — no invite right, no invite capability
          db.prepare("UPDATE invite_codes SET status = 'revoked' WHERE channel_id = ? AND owner = ? AND status = 'active'").run(channelId, name);
        }
        audit(channelId, auth.member.name, "invite.rights", name, `can_invite=${canInvite}`);
        wsHub?.notifyGovernance(channelId, { type: "invite-rights", member: name, canInvite: canInvite === 1 });
        return json({ ok: true, name, canInvite: canInvite === 1 });
      }

      case "set-credential": {
        // Manager/creator swaps the admission credential WITHOUT touching the
        // message key, epoch, or tokens (§ rotate --mode access).
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        if (auth.member.name !== auth.channel.manager_member && auth.member.name !== auth.channel.creator_member) {
          return jsonError(403, "manager or creator only");
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const verifyKeyB64 = parsed.body.verifyKeyB64;
        const decodedLen = typeof verifyKeyB64 === "string" ? Buffer.from(verifyKeyB64, "base64").length : 0;
        if (typeof verifyKeyB64 !== "string" || decodedLen !== 32) {
          return jsonError(400, "invalid request: verifyKeyB64 must be a base64 32-byte key");
        }
        stmtSetCredential.run(verifyKeyB64, 0, channelId);
        audit(channelId, auth.member.name, "credential.rotated", auth.member.name, "access mode");
        return json({ ok: true });
      }

      case "member-stats": {
        if (method !== "GET") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const name = url.searchParams.get("name") ?? auth.member.name;
        const member = stmtMemberByName.get(channelId, name) as MemberRow | undefined;
        if (!member) return jsonError(404, "member not found");
        const total = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND sender = ?").get(channelId, name) as { n: number }).n;
        const channelTotal = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?").get(channelId) as { n: number }).n;
        const perDay: Array<{ day: string; count: number; share: number }> = [];
        for (let i = 6; i >= 0; i--) {
          const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
          const c = (stmtMemberStatsSenderDay.get(channelId, name, `${day}%`) as { n: number }).n;
          const dayTotal = (stmtMemberStatsPerDay.get(channelId, `${day}%`) as { n: number }).n;
          perDay.push({ day, count: c, share: dayTotal > 0 ? Math.round((c / dayTotal) * 100) : 0 });
        }
        return json({
          member: name,
          joinedAt: member.joined_at,
          totalMessages: total,
          totalShare: channelTotal > 0 ? Math.round((total / channelTotal) * 100) : 0,
          lastActiveAt: member.last_active_at,
          perDay,
        });
      }

      case "set-encryption": {
        // Encrypted toggle (§11): manager/creator flips the channel-level
        // boolean ONLY. v3 (spec §3.5): the endpoint no longer mints or bumps
        // key material in any form — key_version starts at 0 and is bumped
        // exclusively by the owner's rotate-key. Toggle-OFF leaves the counter
        // and any sealed copy intact: old encrypted rows remain readable to
        // key holders; new messages go out plaintext.
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        if (auth.member.name !== auth.channel.manager_member && auth.member.name !== auth.channel.creator_member) {
          return jsonError(403, "manager or creator only");
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const wanted = parsed.body.encrypted;
        if (typeof wanted !== "boolean") {
          return jsonError(400, "invalid request: encrypted must be a boolean");
        }
        const keyVersion = auth.channel.key_version ?? 0;
        db.prepare("UPDATE channels SET encrypted = ? WHERE id = ?").run(wanted ? 1 : 0, channelId);
        audit(channelId, auth.member.name, "encryption.changed", channelId, wanted ? `on keyVersion=${keyVersion}` : `off keyVersion=${keyVersion}`);
        wsHub?.notifyGovernance(channelId, { type: "encryption-changed", encrypted: wanted, keyVersion });
        return json({ ok: true, encrypted: wanted, keyVersion });
      }

      case "rotate-key": {
        // v3 key governance (spec §3): CREATOR-ONLY. The owner's CLI mints
        // the new key locally and submits only the version counter (plus an
        // optional sealed copy on the PUBLIC tier — the relay must never hold
        // key material for private channels). WS broadcast carries the
        // version + contact, NEVER key material.
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        if (auth.member.name !== auth.channel.creator_member) {
          audit(channelId, auth.member.name, "rotate-key.denied", auth.member.name, "not creator");
          return jsonError(403, "creator only");
        }
        const parsed = await readJson(req);
        if (!parsed.ok) return parsed.resp;
        const kv = parsed.body.keyVersion;
        if (typeof kv !== "number" || !Number.isInteger(kv) || kv < 1) {
          return jsonError(400, "invalid request: keyVersion must be an integer >= 1");
        }
        if (kv <= (auth.channel.key_version ?? 0)) {
          return jsonError(409, "invalid request: keyVersion must be greater than the current version");
        }
        let sealedKey: string | null = null;
        if (typeof parsed.body.sealedKey === "string" && (parsed.body.sealedKey as string).length > 0) {
          if ((auth.channel.visibility ?? "public") !== "public") {
            return jsonError(400, "invalid request: sealedKey is only accepted on public channels");
          }
          sealedKey = parsed.body.sealedKey as string;
        }
        const rotatedAt = new Date().toISOString();
        db.prepare("UPDATE channels SET key_version = ?, sealed_key = ?, key_rotated_at = ? WHERE id = ?").run(kv, sealedKey, rotatedAt, channelId);
        audit(channelId, auth.member.name, "rotate-key", auth.member.name, `keyVersion=${kv}`);
        wsHub?.notifyGovernance(channelId, {
          type: "key_rotated",
          keyVersion: kv,
          contact: auth.channel.contact_info ?? "",
          rotatedAt,
        });
        return json({ ok: true, keyVersion: kv });
      }

      case "dissolve": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        if (auth.member.name !== auth.channel.manager_member && auth.member.name !== auth.channel.creator_member) {
          return jsonError(403, "manager or creator only");
        }
        audit(channelId, auth.member.name, "channel.dissolved", channelId, "explicit");
        dissolve(channelId);
        wsHub?.invalidateChannel(channelId, 0);
        return json({ ok: true });
      }

      case "audit": {
        if (method !== "GET") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        const rows = db.prepare("SELECT ts, actor, action, target, result FROM audit_log WHERE channel_id = ? ORDER BY ts DESC LIMIT 200").all(channelId);
        return json({ entries: rows });
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
          // Encrypted-toggle stamping (§11): the RELAY owns the row stamps —
          // clients cannot lie a row into (or out of) the encrypted state.
          // Re-read the live channel row: the auth snapshot may predate a
          // concurrent set-encryption.
          const liveChannel = stmtChannel.get(channelId) as ChannelRow | undefined;
          const channelEncrypted = (liveChannel?.encrypted ?? 0) === 1;
          let encrypted = 0;
          let keyVersion = 0;
          if (channelEncrypted && parsed.body.keyVersion !== undefined) {
            const kv = parsed.body.keyVersion;
            if (typeof kv !== "number" || !Number.isInteger(kv) || kv < 1) {
              return jsonError(400, "invalid request: keyVersion must be an integer >= 1");
            }
            const current = liveChannel?.key_version ?? 0;
            if (kv !== current) {
              // v3 (spec §3.2): the sender holds a stale key. The error must be
              // agent-actionable: the CURRENT version + the owner contact
              // string, verbatim, so the member knows who to ask for a blob.
              return new Response(
                JSON.stringify({
                  error: "message key rotated",
                  currentVersion: current,
                  contact: liveChannel?.contact_info ?? "",
                  rotatedAt: liveChannel?.key_rotated_at ?? null,
                }),
                { status: 409, headers: { "content-type": "application/json" } },
              );
            }
            encrypted = 1;
            keyVersion = kv;
          }
          // A send WITHOUT keyVersion on an encrypted channel is a plaintext
          // send — allowed (spec §3.2: unencrypted messages are unaffected;
          // the E2E/plain mismatch is a client concern). The row is stamped
          // with what the sender actually sent.
          const stored = storeMessage(channelId, auth.member.name, shape.values.nonce, ciphertext, shape.values.idemKey, encrypted, keyVersion);
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
            encrypted: number;
            key_version: number;
          }>;
          return json({
            messages: rows.map((r) => ({
              seq: r.seq,
              nonce: r.nonce,
              ciphertext: r.ciphertext,
              encrypted: r.encrypted,
              ...(r.encrypted === 1 ? { keyVersion: r.key_version } : {}),
            })),
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
        const members = stmtMembers.all(channelId) as Array<{ name: string; joined_at: string; last_active_at: string | null; permission_role: string; activity_role: string | null; activity_expires_at: number | null }>;
        return json({
          channelId: auth.channel.id,
          epoch: auth.channel.epoch,
          nextSeq: auth.channel.next_seq,
          minSeq: auth.channel.min_seq ?? 1,
          creatorMember: auth.channel.creator_member,
          managerMember: auth.channel.manager_member,
          admissionMode: auth.channel.admission_mode ?? "password",
          visibility: auth.channel.visibility ?? "public",
          probationEnabled: (auth.channel.probation_enabled ?? 0) === 1,
          invitePolicy: auth.channel.invite_policy ?? "everyone",
          contactInfo: auth.channel.contact_info,
          encrypted: (auth.channel.encrypted ?? 0) === 1,
          keyVersion: auth.channel.key_version ?? 0,
          members: members.map((m) => ({
            memberName: m.name,
            joinedAt: m.joined_at,
            lastActiveAt: m.last_active_at,
            permissionRole: m.permission_role,
            activityRole: m.activity_role ?? undefined,
            ...(m.activity_expires_at !== null ? { activityExpiresAt: m.activity_expires_at } : {}),
          })),
        });
      }

      case "rotate": {
        if (method !== "POST") return jsonError(405, "method not allowed");
        const auth = authenticate(channelId, req);
        if (auth === "banned") return jsonError(403, "banned");
        if (!auth) return jsonError(401, "unauthorized");
        // Governance (§2): rotation is a MANAGER/CREATOR operation.
        if (auth.member.name !== auth.channel.manager_member && auth.member.name !== auth.channel.creator_member) {
          audit(channelId, auth.member.name, "rotate.denied", auth.member.name, "not manager/creator");
          return jsonError(403, "manager or creator only");
        }
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
    "SELECT channel_id, name, token_hash, token_expires_at, epoch, joined_at, status FROM members WHERE channel_id = ? AND token_hash = ?",
  ).get(channelId, sha256Hex(token)) as MemberRow | undefined;
  if (!member || !isLiveToken(member, channel, Date.now())) return null;
  // Governance: banned members lose realtime too (F-1/H-6 parity with HTTP).
  if (member.status === "banned") return null;
  return { channelId, memberName: member.name, epoch: channel.epoch };
}
