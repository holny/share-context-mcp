/**
 * Local state store (spec §5.5/§5.7): bun:sqlite at a machine-level path,
 * persistent across agent sessions and shared by concurrent server instances
 * on the same machine (SQLite locking; WAL enabled).
 *
 * Secrets at rest: channel passwords are AES-256-GCM encrypted under a random
 * 32-byte machine key stored next to the database (~/.share-context-mcp/machine.key,
 * mode 0600). The store never holds plaintext passwords on disk.
 */
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { idempotencyKey, type ClaimKind, type ClaimMessage } from "@share-context-mcp/protocol";

const DEFAULT_DB_PATH = join(homedir(), ".share-context-mcp", "state.db");
const MACHINE_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const SECRET_FORMAT = "v1";
/** Old-epoch passwords retained per channel (spec §5.5); older ones are pruned. */
const EPOCH_KEY_RETENTION = 5;

interface ChannelRow {
  channel_id: string;
  password_enc: string;
  member_name: string;
  epoch: number;
  cursor: number;
  joined_at: string;
}

interface MessageRow {
  seq: number;
  ts: string;
  statement: string;
  detail: string | null;
  kind: string;
  scope_json: string | null;
  topic: string;
  to_member: string | null;
  provenance_json: string;
}

const KEY_LOAD_RETRIES = 20;
const KEY_LOAD_RETRY_MS = 5;

/**
 * Load or create the machine key, safe under concurrent first-run instances:
 * - creation uses open(O_EXCL) so exactly ONE process wins the write —
 *   no existsSync→write TOCTOU window, no last-writer-wins, no interleaved
 *   O_TRUNC garbage that would silently brick stored passwords;
 * - losers (EEXIST) load the winner's key, retrying briefly while the winner
 *   is still between create and write (sync sleep via Atomics.wait — the
 *   Store constructor is synchronous);
 * - an existing file with a looser mode is re-tightened to 0600.
 */
function loadOrCreateMachineKey(keyPath: string): Buffer {
  mkdirSync(dirname(keyPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(keyPath, "wx", 0o600); // O_EXCL — fails with EEXIST if it exists
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return loadExistingMachineKey(keyPath);
  }
  try {
    const key = randomBytes(MACHINE_KEY_BYTES);
    writeSync(fd, key);
    return key;
  } finally {
    closeSync(fd);
  }
}

function loadExistingMachineKey(keyPath: string): Buffer {
  for (let attempt = 0; ; attempt++) {
    const key = readFileSync(keyPath);
    if (key.length === MACHINE_KEY_BYTES) {
      chmodSync(keyPath, 0o600); // re-tighten a looser mode (idempotent)
      return key;
    }
    if (attempt >= KEY_LOAD_RETRIES) {
      throw new Error(
        `machine key at ${keyPath} is corrupt (expected ${MACHINE_KEY_BYTES} bytes, got ${key.length})`,
      );
    }
    // File exists but is empty/partial: a concurrent creator is mid-write.
    const wait = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KEY_LOAD_RETRY_MS);
    if (wait === "not-equal") throw new Error("machine key load retry unavailable on this thread");
  }
}

/** AES-256-GCM under the machine key → "v1:" + base64(nonce ‖ ciphertext ‖ tag). */
function encryptSecret(machineKey: Buffer, plaintext: string): string {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", machineKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_FORMAT}:${Buffer.concat([nonce, ciphertext, tag]).toString("base64")}`;
}

function decryptSecret(machineKey: Buffer, blob: string): string {
  const sep = blob.indexOf(":");
  if (sep !== SECRET_FORMAT.length) throw new Error("unknown secret format");
  const data = Buffer.from(blob.slice(sep + 1), "base64");
  if (data.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) throw new Error("secret too short");
  const nonce = data.subarray(0, GCM_NONCE_BYTES);
  const tag = data.subarray(data.length - GCM_TAG_BYTES);
  const ciphertext = data.subarray(GCM_NONCE_BYTES, data.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", machineKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function rowToClaim(r: MessageRow): ClaimMessage {
  return {
    seq: r.seq,
    ts: r.ts,
    statement: r.statement,
    detail: r.detail ?? undefined,
    kind: r.kind as ClaimKind,
    scope: r.scope_json ? (JSON.parse(r.scope_json) as Record<string, string>) : undefined,
    topic: r.topic,
    to: r.to_member ?? undefined,
    provenance: JSON.parse(r.provenance_json),
    idempotencyKey: idempotencyKey(r.statement, r.kind as ClaimKind, r.topic),
  };
}

export interface ChannelSecretInput {
  channelId: string;
  password: string;
  memberName: string;
  epoch: number;
  /** Initial cursor for a brand-new row; existing rows keep their cursor on conflict. */
  cursor?: number;
}

export interface SubscriptionFilter {
  kinds?: string[];
  scopePrefix?: string;
  topic?: string;
}

const SUBSCRIPTION_KEY_PREFIX = "subscription:";

export class Store {
  private readonly db: Database;
  private readonly machineKey: Buffer;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath === ":memory:") {
      throw new Error("Store requires a file-backed path (the machine key lives next to the database)");
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.machineKey = loadOrCreateMachineKey(join(dirname(dbPath), "machine.key"));
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id   TEXT PRIMARY KEY,
        password_enc TEXT NOT NULL,
        member_name  TEXT NOT NULL,
        epoch        INTEGER NOT NULL,
        cursor       INTEGER NOT NULL DEFAULT 0,
        joined_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        channel_id      TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        ts              TEXT NOT NULL,
        statement       TEXT NOT NULL,
        detail          TEXT,
        kind            TEXT NOT NULL,
        scope_json      TEXT,
        topic           TEXT NOT NULL,
        "to"            TEXT,
        provenance_json TEXT NOT NULL,
        PRIMARY KEY (channel_id, seq)
      );
      CREATE TABLE IF NOT EXISTS epoch_keys (
        channel_id   TEXT NOT NULL,
        epoch        INTEGER NOT NULL,
        password_enc TEXT NOT NULL,
        PRIMARY KEY (channel_id, epoch)
      );
      CREATE TABLE IF NOT EXISTS kvs (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumer_channels (
        consumer_id TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        member_name TEXT,
        joined_at   TEXT NOT NULL,
        PRIMARY KEY(consumer_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS memberships (
        channel_id   TEXT NOT NULL,
        member_name  TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        epoch        INTEGER NOT NULL,
        cursor       INTEGER NOT NULL DEFAULT 0,
        token_enc    TEXT,
        joined_at    TEXT NOT NULL,
        PRIMARY KEY(channel_id, member_name)
      );
      CREATE TABLE IF NOT EXISTS message_keys (
        channel_id  TEXT NOT NULL,
        key_version INTEGER NOT NULL,
        key_enc     TEXT NOT NULL,
        PRIMARY KEY(channel_id, key_version)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        statement, detail, topic, kind, scope,
        tokenize = 'trigram'
      );
    `);
    // Encrypted toggle (governance v2 §11): per-channel state columns
    // (older stores get them via ALTER).
    try { this.db.exec("ALTER TABLE channels ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE channels ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0"); } catch {}
    // v3 identity iteration: multiple memberships per channel per machine.
    // Backfill: every legacy channels row becomes one membership; every
    // consumer_channels row gets the member it joined as.
    try { this.db.exec(`INSERT OR IGNORE INTO memberships(channel_id, member_name, password_enc, epoch, cursor, token_enc, joined_at)
      SELECT channel_id, member_name, password_enc, epoch, cursor, NULL, joined_at FROM channels`); } catch {}
    try { this.db.exec(`UPDATE consumer_channels SET member_name = (SELECT member_name FROM channels WHERE channels.channel_id = consumer_channels.channel_id)
      WHERE member_name IS NULL`); } catch {}
    // One-time backfill for stores created before the FTS index existed:
    // rows cached pre-upgrade would otherwise be invisible to >=3-char
    // searches forever. Runs only when the index is empty while the cache
    // is not — a populated index means nothing to do.
    const ftsEmpty = this.db.prepare("SELECT NOT EXISTS (SELECT 1 FROM messages_fts) AS e").get() as { e: number };
    const hasRows = this.db.prepare("SELECT EXISTS (SELECT 1 FROM messages) AS h").get() as { h: number };
    if (ftsEmpty.e && hasRows.h) {
      this.db.exec(`
        INSERT INTO messages_fts(rowid, statement, detail, topic, kind, scope)
        SELECT rowid, statement, coalesce(detail, ''), topic, kind, coalesce(scope_json, '')
        FROM messages
      `);
    }
  }

  // ---- channels ----

  /**
   * Insert or update a locally-held channel. On conflict the local cursor is
   * preserved. When the password changes, the previous one is retired under
   * its epoch (spec §5.5: "旧 epoch 密文仍由中继保留，只有持有过旧密码的人能解
   * （本地已存旧钥的可继续读）") so this machine keeps local readability of
   * old-epoch ciphertext; retention is bounded to the last 5 epochs.
   */
  upsertChannel(ch: ChannelSecretInput): void {
    const existing = this.db
      .prepare("SELECT password_enc, epoch FROM channels WHERE channel_id = ?")
      .get(ch.channelId) as { password_enc: string; epoch: number } | undefined;
    if (existing) {
      let oldPassword: string | null = null;
      try {
        oldPassword = decryptSecret(this.machineKey, existing.password_enc);
      } catch {
        oldPassword = null; // undecryptable residue — nothing to retire
      }
      if (oldPassword !== null && oldPassword !== ch.password) {
        this.db
          .prepare(
            `INSERT INTO epoch_keys(channel_id, epoch, password_enc) VALUES (?, ?, ?)
             ON CONFLICT(channel_id, epoch) DO UPDATE SET password_enc = excluded.password_enc`,
          )
          .run(ch.channelId, existing.epoch, existing.password_enc);
        this.db
          .prepare("DELETE FROM epoch_keys WHERE channel_id = ? AND epoch <= ?")
          .run(ch.channelId, ch.epoch - EPOCH_KEY_RETENTION);
      }
    }
    this.db
      .prepare(
        `INSERT INTO channels(channel_id, password_enc, member_name, epoch, cursor, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           password_enc = excluded.password_enc,
           member_name = excluded.member_name,
           epoch = excluded.epoch`,
      )
      .run(
        ch.channelId,
        encryptSecret(this.machineKey, ch.password),
        ch.memberName,        ch.epoch,
        ch.cursor ?? 0,
        new Date().toISOString(),
      );
  }

  /**
   * Retired old-epoch passwords for a channel, ascending by epoch (current
   * password excluded). Used by poll to open envelopes sealed in earlier
   * epochs; bounded by EPOCH_KEY_RETENTION at write time.
   */
  epochPasswords(channelId: string): Array<{ epoch: number; password: string }> {
    const rows = this.db
      .prepare("SELECT epoch, password_enc FROM epoch_keys WHERE channel_id = ? ORDER BY epoch ASC")
      .all(channelId) as Array<{ epoch: number; password_enc: string }>;
    const out: Array<{ epoch: number; password: string }> = [];
    for (const r of rows) {
      try {
        out.push({ epoch: r.epoch, password: decryptSecret(this.machineKey, r.password_enc) });
      } catch {
        // undecryptable residue — skip that epoch
      }
    }
    return out;
  }

  /** Decrypt and return the channel secret; null if the channel is not held locally. */
  getChannelSecret(channelId: string): { password: string; memberName: string; epoch: number } | null {
    const row = this.db.prepare("SELECT password_enc, member_name, epoch FROM channels WHERE channel_id = ?").get(channelId) as
      | { password_enc: string; member_name: string; epoch: number }
      | undefined;
    if (!row) return null;
    return {
      password: decryptSecret(this.machineKey, row.password_enc),
      memberName: row.member_name,
      epoch: row.epoch,
    };
  }

  // ---- memberships (v3 identity iteration: several members per channel per machine) ----

  /** Insert or update one (channel, member) membership. Cursor is preserved on conflict. */
  upsertMembership(ch: ChannelSecretInput): void {
    this.db
      .prepare(
        `INSERT INTO memberships(channel_id, member_name, password_enc, epoch, cursor, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, member_name) DO UPDATE SET
           password_enc = excluded.password_enc,
           epoch = excluded.epoch`,
      )
      .run(
        ch.channelId,
        ch.memberName,
        encryptSecret(this.machineKey, ch.password),
        ch.epoch,
        ch.cursor ?? this.getMembershipCursor(ch.channelId, ch.memberName),
        new Date().toISOString(),
      );
    // Keep the legacy channels row pointing at the newest membership so older
    // code paths (metadata lookups, single-member flows) keep working.
    this.upsertChannel({ ...ch, cursor: this.getMembershipCursor(ch.channelId, ch.memberName) });
  }

  getMembership(channelId: string, memberName: string): { password: string; epoch: number; cursor: number } | null {
    const row = this.db
      .prepare("SELECT password_enc, epoch, cursor FROM memberships WHERE channel_id = ? AND member_name = ?")
      .get(channelId, memberName) as { password_enc: string; epoch: number; cursor: number } | undefined;
    if (!row) return null;
    return { password: decryptSecret(this.machineKey, row.password_enc), epoch: row.epoch, cursor: row.cursor };
  }

  hasMembership(channelId: string, memberName: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM memberships WHERE channel_id = ? AND member_name = ?")
      .get(channelId, memberName);
  }

  /** Member names this machine holds for a channel, oldest first. */
  listMembershipNames(channelId: string): string[] {
    return (
      this.db
        .prepare("SELECT member_name FROM memberships WHERE channel_id = ? ORDER BY joined_at ASC")
        .all(channelId) as Array<{ member_name: string }>
    ).map((r) => r.member_name);
  }

  deleteMembership(channelId: string, memberName: string): void {
    this.db.prepare("DELETE FROM memberships WHERE channel_id = ? AND member_name = ?").run(channelId, memberName);
    if (this.listMembershipNames(channelId).length === 0) this.removeChannel(channelId);
  }

  getMembershipCursor(channelId: string, memberName: string): number {
    const row = this.db
      .prepare("SELECT cursor FROM memberships WHERE channel_id = ? AND member_name = ?")
      .get(channelId, memberName) as { cursor: number } | undefined;
    if (row) return row.cursor;
    // legacy single-member store: channels.cursor doubles as the membership cursor
    const legacy = this.db.prepare("SELECT cursor FROM channels WHERE channel_id = ?").get(channelId) as { cursor: number } | undefined;
    return legacy?.cursor ?? 0;
  }

  setMembershipCursor(channelId: string, memberName: string, seq: number): void {
    this.db
      .prepare("UPDATE memberships SET cursor = ? WHERE channel_id = ? AND member_name = ?")
      .run(seq, channelId, memberName);
  }

  /** Membership-scoped token storage (AES-sealed at rest). */
  setMembershipToken(channelId: string, memberName: string, token: string): void {
    // Upsert: the token can arrive BEFORE the membership row (createChannel
    // joins the creator before the row is written). The empty password
    // placeholder is filled by the immediately-following membership upsert.
    this.db
      .prepare(
        `INSERT INTO memberships(channel_id, member_name, password_enc, epoch, cursor, token_enc, joined_at)
         VALUES (?, ?, '', 0, 0, ?, ?)
         ON CONFLICT(channel_id, member_name) DO UPDATE SET token_enc = excluded.token_enc`,
      )
      .run(channelId, memberName, encryptSecret(this.machineKey, token), new Date().toISOString());
  }

  getMembershipToken(channelId: string, memberName: string): string | null {
    const row = this.db
      .prepare("SELECT token_enc FROM memberships WHERE channel_id = ? AND member_name = ?")
      .get(channelId, memberName) as { token_enc: string | null } | undefined;
    if (!row?.token_enc) return null;
    try {
      return decryptSecret(this.machineKey, row.token_enc);
    } catch {
      return null;
    }
  }

  deleteMembershipToken(channelId: string, memberName: string): void {
    this.db
      .prepare("UPDATE memberships SET token_enc = NULL WHERE channel_id = ? AND member_name = ?")
      .run(channelId, memberName);
  }

  /** The member this consumer joined a channel as (null when never joined here). */
  memberForConsumer(consumerId: string, channelId: string): string | null {
    const row = this.db
      .prepare("SELECT member_name FROM consumer_channels WHERE consumer_id = ? AND channel_id = ?")
      .get(consumerId, channelId) as { member_name: string | null } | undefined;
    return row?.member_name ?? null;
  }

  recordConsumerChannel(consumerId: string, channelId: string, memberName?: string): void {
    this.db
      .prepare(
        `INSERT INTO consumer_channels(consumer_id, channel_id, member_name, joined_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(consumer_id, channel_id) DO UPDATE SET member_name = COALESCE(excluded.member_name, member_name)`,
      )
      .run(consumerId, channelId, memberName ?? null, new Date().toISOString());
  }

  listChannels(): string[] {
    const rows = this.db.prepare("SELECT channel_id FROM channels ORDER BY joined_at ASC").all() as Array<{
      channel_id: string;
    }>;
    return rows.map((r) => r.channel_id);
  }

  // ---- message keyring (encrypted toggle, governance v2 §11) ----
  //
  // {channelId → {keyVersion → key}} in memory; entries are persisted
  // GCM-sealed under the machine key so a restarted server keeps decrypting
  // old-version rows. Keys are NEVER derived from the admission credential —
  // they travel out-of-band (credential wrap / manager handoff).

  private readonly keyring = new Map<string, Map<number, Uint8Array>>();

  /** Channel encryption state: {encrypted, keyVersion}. Defaults off/0. */
  encryptionState(channelId: string): { encrypted: boolean; keyVersion: number } {
    const row = this.db.prepare("SELECT encrypted, key_version FROM channels WHERE channel_id = ?").get(channelId) as
      | { encrypted: number; key_version: number }
      | undefined;
    return { encrypted: (row?.encrypted ?? 0) === 1, keyVersion: row?.key_version ?? 0 };
  }

  /** Record the relay-reported toggle state (post set-encryption / join meta). */
  setEncryptionState(channelId: string, encrypted: boolean, keyVersion: number): void {
    this.db
      .prepare("UPDATE channels SET encrypted = ?, key_version = ? WHERE channel_id = ?")
      .run(encrypted ? 1 : 0, keyVersion, channelId);
  }

  /** Store a message key under its version (memory + GCM-sealed at rest). */
  setMessageKey(channelId: string, keyVersion: number, key: Uint8Array): void {
    if (key.length !== 32) throw new Error("message key must be 32 bytes");
    let perChannel = this.keyring.get(channelId);
    if (!perChannel) {
      perChannel = new Map();
      this.keyring.set(channelId, perChannel);
    }
    perChannel.set(keyVersion, key);
    this.db
      .prepare(
        "INSERT INTO message_keys(channel_id, key_version, key_enc) VALUES (?, ?, ?) " +
          "ON CONFLICT(channel_id, key_version) DO UPDATE SET key_enc = excluded.key_enc",
      )
      .run(channelId, keyVersion, encryptSecret(this.machineKey, Buffer.from(key).toString("base64")));
  }

  /** Drop one locally-held message key (tests / owner re-mint scenarios). */
  forgetMessageKey(channelId: string, keyVersion: number): void {
    this.keyring.get(channelId)?.delete(keyVersion);
    this.db.prepare("DELETE FROM message_keys WHERE channel_id = ? AND key_version = ?").run(channelId, keyVersion);
  }

  /** The key for a version, or null when this member does not hold it. */
  messageKey(channelId: string, keyVersion: number): Uint8Array | null {
    const cached = this.keyring.get(channelId)?.get(keyVersion);
    if (cached) return cached;
    const row = this.db
      .prepare("SELECT key_enc FROM message_keys WHERE channel_id = ? AND key_version = ?")
      .get(channelId, keyVersion) as { key_enc: string } | undefined;
    if (!row) return null;
    try {
      const key = new Uint8Array(Buffer.from(decryptSecret(this.machineKey, row.key_enc), "base64"));
      let perChannel = this.keyring.get(channelId);
      if (!perChannel) {
        perChannel = new Map();
        this.keyring.set(channelId, perChannel);
      }
      perChannel.set(keyVersion, key);
      return key;
    } catch {
      return null; // undecryptable residue — treat as not held
    }
  }

  /** Rejoin candidates: channels with a stored (encrypted) password. */
  rejoinable(): string[] {
    const rows = this.db.prepare("SELECT channel_id FROM channels WHERE password_enc IS NOT NULL ORDER BY joined_at ASC").all() as Array<{
      channel_id: string;
    }>;
    return rows.map((r) => r.channel_id);
  }

  /** Forget a channel locally (relay-side membership record is untouched in v1). */
  removeChannel(channelId: string): void {
    const tx = this.db.transaction((ch: string) => {
      this.db.prepare("DELETE FROM channels WHERE channel_id = ?").run(ch);
      this.db.prepare("DELETE FROM epoch_keys WHERE channel_id = ?").run(ch);
      this.db.prepare("DELETE FROM consumer_channels WHERE channel_id = ?").run(ch);
      this.db.prepare("DELETE FROM message_keys WHERE channel_id = ?").run(ch);
      // FTS mirror cleanup: orphan rows are otherwise only reclaimed lazily
      // when a later insert happens to reuse their rowid.
      this.db
        .prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE channel_id = ?)")
        .run(ch);
      this.db.prepare("DELETE FROM messages WHERE channel_id = ?").run(ch);
    });
    tx(channelId);
  }

  // ---- cursor (spec §5.7) ----

  setCursor(channelId: string, seq: number, memberName?: string): void {
    if (memberName) {
      this.setMembershipCursor(channelId, memberName, seq);
      return;
    }
    this.db.prepare("UPDATE channels SET cursor = ? WHERE channel_id = ?").run(seq, channelId);
  }

  getCursor(channelId: string, memberName?: string): number {
    if (memberName) return this.getMembershipCursor(channelId, memberName);
    const row = this.db.prepare("SELECT cursor FROM channels WHERE channel_id = ?").get(channelId) as
      | { cursor: number }
      | undefined;
    return row?.cursor ?? 0;
  }

  /**
   * Advance the cursor to the max seq seen. Monotonic: never regresses on
   * re-delivered older messages, no-op for an empty batch or all-null seqs.
   */
  recordCursorFromMessages(channelId: string, msgs: ReadonlyArray<{ seq: number | null }>, memberName?: string): void {
    const seqs = msgs.map((m) => m.seq).filter((s): s is number => typeof s === "number");
    if (seqs.length === 0) return;
    const max = Math.max(...seqs);
    if (max > this.getCursor(channelId, memberName)) this.setCursor(channelId, max, memberName);
  }

  // ---- decrypted message cache ----

  /**
   * Upsert decrypted messages keyed by (channel_id, seq). The idempotency key
   * is not persisted — searchCache re-derives it on read — so inputs may omit it.
   */
  cacheMessages(channelId: string, msgs: ReadonlyArray<Omit<ClaimMessage, "idempotencyKey">>): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages(channel_id, seq, ts, statement, detail, kind, scope_json, topic, "to", provenance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, seq) DO UPDATE SET
         ts = excluded.ts,
         statement = excluded.statement,
         detail = excluded.detail,
         kind = excluded.kind,
         scope_json = excluded.scope_json,
         topic = excluded.topic,
         "to" = excluded."to",
         provenance_json = excluded.provenance_json`,
    );
    const insertAll = this.db.transaction((rows: ReadonlyArray<Omit<ClaimMessage, "idempotencyKey">>) => {
      // Hoisted once per batch — bun:sqlite compiles on prepare.
      const ftsRowid = this.db.prepare(`SELECT rowid FROM messages WHERE channel_id = ? AND seq = ?`);
      const ftsDelete = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`);
      const ftsInsert = this.db.prepare(
        `INSERT INTO messages_fts(rowid, statement, detail, topic, kind, scope) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const m of rows) {
        stmt.run(
          channelId,
          m.seq,
          m.ts,
          m.statement,
          m.detail ?? null,
          m.kind,
          m.scope ? JSON.stringify(m.scope) : null,
          m.topic,
          m.to ?? null,
          JSON.stringify(m.provenance),
        );
        // Mirror into the FTS5 index (trigram): replace any previous text for
        // this (channel_id, seq) so search sees upserted content, not stale.
        const row = ftsRowid.get(channelId, m.seq) as { rowid: number };
        ftsDelete.run(row.rowid);
        ftsInsert.run(row.rowid, m.statement, m.detail ?? "", m.topic, m.kind, m.scope ? JSON.stringify(m.scope) : "");
      }
    });
    insertAll(msgs);
  }

  /**
   * Keyword search over the decrypted cache: `a&b,c&d` = (a AND b) OR (c AND d);
   * case-insensitive. Hybrid engine: terms of ≥3 chars go through the FTS5
   * trigram index (BM25 relevance ranking, CJK substring matching); shorter
   * terms fall back to LIKE over statement+detail (trigram needs 3 chars).
   * A query made purely of ≥3-char terms orders by BM25 rank; any LIKE
   * involvement falls back to newest-first. Empty/blank query returns the
   * whole cache. Returns reconstructed ClaimMessages.
   */
  searchCache(channelId: string, query: string): ClaimMessage[] {
    const groups = query
      .split(",")
      .map((g) => g.split("&").map((t) => t.trim()).filter((t) => t.length > 0))
      .filter((g) => g.length > 0);

    const conds: string[] = [];
    const params: string[] = [];
    let hasFts = false;
    let hasLike = false;
    const ftsGroups: string[] = [];
    for (const g of groups) {
      const parts: string[] = [];
      const ftsParts: string[] = [];
      for (const term of g) {
        const quoted = `"${term.replace(/"/g, '""')}"`;
        if (term.length >= 3) {
          hasFts = true;
          // Column-restricted MATCH: parity with the LIKE path, which scans
          // statement+detail only. topic/kind/scope have dedicated exact
          // filters (catch_up) and must not leak into content search.
          ftsParts.push(quoted);
          parts.push(`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`);
          params.push(`{statement detail}: ${quoted}`);
        } else {
          hasLike = true;
          parts.push(`lower(coalesce(statement, '') || ' ' || coalesce(detail, '')) LIKE ?`);
          params.push(`%${term.toLowerCase()}%`);
        }
      }
      conds.push(`(${parts.join(" AND ")})`);
      // FTS5 allows exactly one MATCH constraint per table per query, so the
      // OR-of-groups structure lives INSIDE a single MATCH expression, with
      // the column filter repeated per group.
      ftsGroups.push(`{statement detail}: (${ftsParts.join(" AND ")})`);
    }
    const where = conds.length > 0 ? ` AND (${conds.join(" OR ")})` : "";
    // Pure-FTS queries rank by relevance; anything touching LIKE keeps the
    // stable newest-first order (BM25 scores are not comparable to LIKE hits).
    // Two FTS5 quirks pinned by probes: rank is only populated when the MATCH
    // targets the scanned FTS table in the same query (a rowid IN (subquery)
    // filter leaves it NULL), and in a JOIN the MATCH/ORDER BY must reference
    // the real table name — an alias raises "no such column".
    let rows: MessageRow[];
    if (hasFts && !hasLike) {
      rows = this.db
        .prepare(
          `SELECT m.seq, m.ts, m.statement, m.detail, m.kind, m.scope_json, m.topic, m."to" AS to_member, m.provenance_json
           FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
           WHERE m.channel_id = ? AND messages_fts MATCH ?
           ORDER BY messages_fts.rank`,
        )
        .all(channelId, ftsGroups.join(" OR ")) as MessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT seq, ts, statement, detail, kind, scope_json, topic, "to" AS to_member, provenance_json
           FROM messages WHERE channel_id = ?${where}
           ORDER BY seq DESC`,
        )
        .all(channelId, ...params) as MessageRow[];
    }
    return rows.map(rowToClaim);
  }

  /**
   * Cached messages with since < seq <= until, ascending. Serves fetch_updates
   * when the broadcaster (M2) already consumed a window: its poll cached the
   * messages and advanced the cursor before the tool ran, so a relay poll
   * returns empty while the content is locally available.
   */
  cachedRange(channelId: string, since: number, until: number): ClaimMessage[] {
    const rows = this.db
      .prepare(
        `SELECT seq, ts, statement, detail, kind, scope_json, topic, "to" AS to_member, provenance_json
         FROM messages WHERE channel_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC`,
      )
      .all(channelId, since, until) as MessageRow[];
    return rows.map(rowToClaim);
  }

  /**
   * Delivered cursor: the seq up to which fetch_updates has SERVED messages to
   * this agent. Separate from the high-water cursor (which the broadcaster
   * advances by consuming windows ahead of the agent) — fetch_updates serves
   * cachedRange(delivered, highWater) and then moves delivered forward.
   */
  // delivered cursor moved to process memory (session-scoped, M3 review):
  // each MCP server process tracks its own delivery position independently,
  // so multiple sessions on the same machine get isolated views.


  // delivered cursor moved to process memory (session-scoped, M3 review).


  // ---- key-value scratch space (active channel, subscriptions, labels) ----

  /**
   * Encrypted kv slot for bearer secrets (relay session tokens) under the
   * same machine-key GCM scheme as channel passwords. Null when absent.
   */
  getSecret(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kvs WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return decryptSecret(this.machineKey, row.value);
    } catch {
      return null; // corrupt/foreign entry — treat as absent
    }
  }

  putSecret(key: string, plaintext: string): void {
    this.db
      .prepare("INSERT INTO kvs(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, encryptSecret(this.machineKey, plaintext));
  }

  /** Per-session channel ledger (§6 multi-channel): a consumer's joined channels. */


  listConsumerChannels(consumerId: string): Array<{ channelId: string; joinedAt: string }> {
    return this.db
      .prepare("SELECT channel_id AS channelId, joined_at FROM consumer_channels WHERE consumer_id = ? ORDER BY joined_at ASC")
      .all(consumerId) as Array<{ channelId: string; joinedAt: string }>;
  }

  removeConsumerChannel(consumerId: string, channelId: string): void {
    this.db.prepare("DELETE FROM consumer_channels WHERE consumer_id = ? AND channel_id = ?").run(consumerId, channelId);
  }

  getKv(key: string): string | null {    const row = this.db.prepare("SELECT value FROM kvs WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO kvs(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteKv(key: string): void {
    this.db.prepare("DELETE FROM kvs WHERE key = ?").run(key);
  }

  // ---- subscriptions (consumed by the IPC broadcaster, spec §5.4) ----

  /**
   * Per-channel push filters, as set by the `set_subscription` tool. Null when
   * no subscription was declared (the broadcaster then passes everything).
   */
  getSubscription(channelId: string): SubscriptionFilter[] | null {
    const raw = this.getKv(SUBSCRIPTION_KEY_PREFIX + channelId);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as SubscriptionFilter[]) : null;
    } catch {
      return null; // corrupt entry — treat as absent
    }
  }

  setSubscription(channelId: string, filters: SubscriptionFilter[]): void {
    this.setKv(SUBSCRIPTION_KEY_PREFIX + channelId, JSON.stringify(filters));
  }

  /** Close the database (WAL checkpoints on close). */
  close(): void {
    this.db.close();
  }
}
