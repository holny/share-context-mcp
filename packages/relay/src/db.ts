/**
 * Relay storage (spec §5.5): SQLite via bun:sqlite.
 *
 * BLINDNESS NOTE: the relay stores the channel *verification key* —
 * HMAC-SHA256(channelKey, "verify") — NOT the channel key itself. The
 * verification key only proves password possession during join; it cannot
 * decrypt message envelopes, which are treated as opaque base64 strings.
 */
import { Database } from "bun:sqlite";

export interface ChannelRow {
  id: string;
  epoch: number;
  next_seq: number;
  /** Lowest retained seq (retention Task 6); 1 = nothing evicted. */
  min_seq: number;
  creator_member: string | null;
  manager_member: string | null;
  admission_mode: string;
  /** v3 visibility axis: public (listed) | private (hidden). */
  visibility: string;
  /** v3 probation (spec §6): 1 = new members land in trial tier. */
  probation_enabled: number;
  /** v3 probation (spec §6): 1 = invite-tier joins skip probation. */
  invite_skips_probation: number;
  /** v3 key governance: relay-held sealed key copy — public tier only. */
  sealed_key: string | null;
  /** v3 key governance: ISO ts of the last rotate-key (409 error payload). */
  key_rotated_at: string | null;
  invite_policy: string;
  contact_info: string | null;
  vote_cooldown_until: number | null;
  /** Governance kick (password tier): joins with the old credential are rejected. */
  admission_credential_revoked: number;
  /** Encrypted toggle (governance v2 §11): 1 = new messages carry key_version. */
  encrypted: number;
  /** Message-key version counter; bumps on every toggle-ON (blind counter). */
  key_version: number;
  /** base64 of HMAC-SHA256(channelKey, "verify") — proves possession, cannot decrypt */
  verify_key: string;
  created_at: string;
}

export interface MemberRow {
  channel_id: string;
  name: string;
  /** sha256 hex of the session token; NULL = reserved name, not yet joined */
  token_hash: string | null;
  /** epoch ms; NULL = no live token */
  token_expires_at: number | null;
  epoch: number;
  joined_at: string;
  /** Governance: active | banned | left */
  status: string;
  /** 1 = may mint invite codes */
  can_invite: number;
  /** ISO ts of the last activity receipt (presence buckets). */
  last_active_at: string | null;
  /** Owning relay-global user (user/consumer model, governance v2 §3). */
  user_id: string | null;
  /** v3 permission tier: creator | manager | representative | vip | regular | trial. */
  permission_role?: string;
}

/** Relay-global user identity (governance v2 §3). The session token binds to
 * the USER: one token → one relay connection → one user → N consumers → N
 * channel memberships. */
export interface UserRow {
  user_id: string;
  name: string;
  ip: string | null;
  os_type: string | null;
  os_version: string | null;
  mcp_version: string | null;
  token_hash: string | null;
  registered_at: string;
  last_active_at: string;
}

/** An agent process/session under a user (governance v2 §3, 1 user : N). */
export interface ConsumerRow {
  consumer_id: string;
  user_id: string;
  agent_type: string | null;
  agent_version: string | null;
  session_id: string | null;
  last_active_at: string;
}

export interface MessageRow {
  channel_id: string;
  seq: number;
  sender: string | null;
  nonce: string;
  ciphertext: string;
  idem_key: string;
  created_at: string;
}

export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
    // M3 migration: add tracking columns if not present
    try { db.exec("ALTER TABLE members ADD COLUMN last_poll_seq INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE members ADD COLUMN last_viewed_seq INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE members ADD COLUMN last_active_at TEXT"); } catch {}
    // Retention (Task 6): lowest retained seq per channel (1 = nothing evicted).
    try { db.exec("ALTER TABLE channels ADD COLUMN min_seq INTEGER NOT NULL DEFAULT 1"); } catch {}
    // Governance (governance iteration): roles, admission modes, invite policy.
    try { db.exec("ALTER TABLE channels ADD COLUMN creator_member TEXT"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN manager_member TEXT"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN admission_mode TEXT NOT NULL DEFAULT 'password'"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN invite_policy TEXT NOT NULL DEFAULT 'everyone'"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN contact_info TEXT"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN vote_cooldown_until INTEGER"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN admission_credential_revoked INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch {}
    try { db.exec("ALTER TABLE members ADD COLUMN can_invite INTEGER NOT NULL DEFAULT 1"); } catch {}
    try { db.exec("ALTER TABLE messages ADD COLUMN sender TEXT"); } catch {}
    // User/consumer model (governance v2 §3): members reference a
    // relay-global user row; the session token binds to the user.
    try { db.exec("ALTER TABLE members ADD COLUMN user_id TEXT"); } catch {}
    // Activity/permission roles (governance v2 §4/§5): one permission role
    // (governance tier) + one activity role (daily scan) per member.
    try { db.exec("ALTER TABLE members ADD COLUMN permission_role TEXT NOT NULL DEFAULT 'regular'"); } catch {}
    try { db.exec("ALTER TABLE members ADD COLUMN activity_role TEXT"); } catch {}
    try { db.exec("ALTER TABLE members ADD COLUMN activity_expires_at INTEGER"); } catch {}
    // Encrypted toggle (governance v2 §11): channel-level boolean + key
    // version counter, INDEPENDENT of admission mode; per-message stamps.
    try { db.exec("ALTER TABLE channels ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE messages ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE messages ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0"); } catch {}
    // v3 channel model: visibility axis + probation flags (spec §2/§6).
    try { db.exec("ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN probation_enabled INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN invite_skips_probation INTEGER NOT NULL DEFAULT 1"); } catch {}
    try { db.exec("ALTER TABLE members ADD COLUMN probation_until TEXT"); } catch {}
    // v3 key governance: relay-held sealed key copy (public tier only) +
    // rotation timestamp surfaced in key-mismatch errors.
    try { db.exec("ALTER TABLE channels ADD COLUMN sealed_key TEXT"); } catch {}
    try { db.exec("ALTER TABLE channels ADD COLUMN key_rotated_at TEXT"); } catch {}
    // One-time migration (spec §2.2): the admission axis renamed its open
    // mode — legacy 'public' rows map to 'no_limit'. Visibility defaults to
    // 'public' for all pre-existing rows (spec §9).
    try { db.exec("UPDATE channels SET admission_mode = 'no_limit' WHERE admission_mode = 'public'"); } catch {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS users(
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ip TEXT,
        os_type TEXT,
        os_version TEXT,
        mcp_version TEXT,
        token_hash TEXT,
        registered_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(name);
      CREATE INDEX IF NOT EXISTS idx_users_token ON users(token_hash);
      CREATE TABLE IF NOT EXISTS consumers(
        consumer_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id),
        agent_type TEXT,
        agent_version TEXT,
        session_id TEXT,
        last_active_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_consumers_user ON consumers(user_id);
    `);
    // Role backfill: pre-governance databases have NULL creator/manager —
    // adopt the earliest joined member (the original creator) so management
    // operations keep working (H-7).
    try {
      db.exec(`
        UPDATE channels SET creator_member = (
          SELECT name FROM members WHERE members.channel_id = channels.id ORDER BY members.joined_at ASC LIMIT 1
        ) WHERE creator_member IS NULL;
        UPDATE channels SET manager_member = creator_member WHERE manager_member IS NULL;
      `);
    } catch {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_bans(
        channel_id TEXT NOT NULL REFERENCES channels(id),
        name TEXT NOT NULL,
        consumer_ids TEXT,
        ip TEXT,
        banned_at TEXT NOT NULL,
        banned_by TEXT NOT NULL,
        PRIMARY KEY(channel_id, name)
      );
      CREATE TABLE IF NOT EXISTS member_consumer_ids(
        channel_id TEXT NOT NULL REFERENCES channels(id),
        member_name TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY(channel_id, member_name, consumer_id)
      );
      CREATE TABLE IF NOT EXISTS audit_log(
        channel_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS invite_codes(
        channel_id TEXT NOT NULL REFERENCES channels(id),
        code_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at INTEGER,
        used_by TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        PRIMARY KEY(channel_id, code_id)
      );
      CREATE TABLE IF NOT EXISTS votes(
        channel_id TEXT NOT NULL REFERENCES channels(id),
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        initiator TEXT NOT NULL,
        target TEXT NOT NULL,
        params_json TEXT,
        started_at TEXT NOT NULL,
        ends_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        PRIMARY KEY(channel_id, id)
      );
      CREATE TABLE IF NOT EXISTS ballots(
        channel_id TEXT NOT NULL,
        vote_id TEXT NOT NULL,
        voter_name TEXT NOT NULL,
        choice TEXT NOT NULL,
        PRIMARY KEY(channel_id, vote_id, voter_name)
      );
    `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels(
      id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1,
      min_seq INTEGER NOT NULL DEFAULT 1,
      creator_member TEXT,
      manager_member TEXT,
      admission_mode TEXT NOT NULL DEFAULT 'password',
      visibility TEXT NOT NULL DEFAULT 'public',
      probation_enabled INTEGER NOT NULL DEFAULT 0,
      invite_skips_probation INTEGER NOT NULL DEFAULT 1,
      sealed_key TEXT,
      key_rotated_at TEXT,
      invite_policy TEXT NOT NULL DEFAULT 'everyone',
      contact_info TEXT,
      vote_cooldown_until INTEGER,
      admission_credential_revoked INTEGER NOT NULL DEFAULT 0,
      encrypted INTEGER NOT NULL DEFAULT 0,
      key_version INTEGER NOT NULL DEFAULT 0,
      verify_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members(
      channel_id TEXT NOT NULL REFERENCES channels(id),
      name TEXT NOT NULL,
      token_hash TEXT,
      token_expires_at INTEGER,
      epoch INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      last_poll_seq INTEGER NOT NULL DEFAULT 0,
      last_viewed_seq INTEGER NOT NULL DEFAULT 0,
      last_active_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      can_invite INTEGER NOT NULL DEFAULT 1,
      user_id TEXT,
      permission_role TEXT NOT NULL DEFAULT 'regular',
      probation_until TEXT,
      activity_role TEXT,
      activity_expires_at INTEGER,
      PRIMARY KEY(channel_id, name)
    );

    CREATE TABLE IF NOT EXISTS messages(
      channel_id TEXT NOT NULL REFERENCES channels(id),
      seq INTEGER NOT NULL,
      sender TEXT,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      key_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(channel_id, seq)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem ON messages(channel_id, idem_key);
  `);
  return db;
}
