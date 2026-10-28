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
  invite_policy: string;
  contact_info: string | null;
  vote_cooldown_until: number | null;
  /** Governance kick (password tier): joins with the old credential are rejected. */
  admission_credential_revoked: number;
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
}

export interface MessageRow {
  channel_id: string;
  seq: number;
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
      invite_policy TEXT NOT NULL DEFAULT 'everyone',
      contact_info TEXT,
      vote_cooldown_until INTEGER,
      admission_credential_revoked INTEGER NOT NULL DEFAULT 0,
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
      PRIMARY KEY(channel_id, seq)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem ON messages(channel_id, idem_key);
  `);
  return db;
}
