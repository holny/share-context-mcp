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
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels(
      id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1,
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
      PRIMARY KEY(channel_id, name)
    );

    CREATE TABLE IF NOT EXISTS messages(
      channel_id TEXT NOT NULL REFERENCES channels(id),
      seq INTEGER NOT NULL,
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
