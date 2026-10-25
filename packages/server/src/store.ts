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
    `);
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
        ch.memberName,
        ch.epoch,
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

  listChannels(): string[] {
    const rows = this.db.prepare("SELECT channel_id FROM channels ORDER BY joined_at ASC").all() as Array<{
      channel_id: string;
    }>;
    return rows.map((r) => r.channel_id);
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
    this.db.prepare("DELETE FROM channels WHERE channel_id = ?").run(channelId);
    this.db.prepare("DELETE FROM epoch_keys WHERE channel_id = ?").run(channelId);
    this.db.prepare("DELETE FROM messages WHERE channel_id = ?").run(channelId);
  }

  // ---- cursor (spec §5.7) ----

  setCursor(channelId: string, seq: number): void {
    this.db.prepare("UPDATE channels SET cursor = ? WHERE channel_id = ?").run(seq, channelId);
  }

  getCursor(channelId: string): number {
    const row = this.db.prepare("SELECT cursor FROM channels WHERE channel_id = ?").get(channelId) as
      | { cursor: number }
      | undefined;
    return row?.cursor ?? 0;
  }

  /**
   * Advance the cursor to the max seq seen. Monotonic: never regresses on
   * re-delivered older messages, no-op for an empty batch or all-null seqs.
   */
  recordCursorFromMessages(channelId: string, msgs: ReadonlyArray<{ seq: number | null }>): void {
    const seqs = msgs.map((m) => m.seq).filter((s): s is number => typeof s === "number");
    if (seqs.length === 0) return;
    const max = Math.max(...seqs);
    if (max > this.getCursor(channelId)) this.setCursor(channelId, max);
  }

  // ---- decrypted message cache ----

  /** Upsert decrypted messages keyed by (channel_id, seq). */
  cacheMessages(channelId: string, msgs: ReadonlyArray<ClaimMessage>): void {
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
    const insertAll = this.db.transaction((rows: ReadonlyArray<ClaimMessage>) => {
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
      }
    });
    insertAll(msgs);
  }

  /**
   * Keyword search over the decrypted cache: `a&b,c&d` = (a AND b) OR (c AND d);
   * case-insensitive substring match over statement+detail. Empty/blank query
   * returns the whole cache. Returns reconstructed ClaimMessages, newest first.
   * Note: `%`/`_` inside terms act as LIKE wildcards (accepted in v1).
   */
  searchCache(channelId: string, query: string): ClaimMessage[] {
    const groups = query
      .split(",")
      .map((g) => g.split("&").map((t) => t.trim()).filter((t) => t.length > 0))
      .filter((g) => g.length > 0);

    let where = "";
    const params: string[] = [];
    if (groups.length > 0) {
      const match = `lower(coalesce(statement, '') || ' ' || coalesce(detail, '')) LIKE ?`;
      where = ` AND (${groups.map((g) => `(${g.map(() => match).join(" AND ")})`).join(" OR ")})`;
      for (const g of groups) {
        for (const term of g) params.push(`%${term.toLowerCase()}%`);
      }
    }
    const rows = this.db
      .prepare(
        `SELECT seq, ts, statement, detail, kind, scope_json, topic, "to" AS to_member, provenance_json
         FROM messages WHERE channel_id = ?${where} ORDER BY seq DESC`,
      )
      .all(channelId, ...params) as MessageRow[];
    return rows.map(rowToClaim);
  }

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

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kvs WHERE key = ?").get(key) as { value: string } | undefined;
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

  /** Close the database (WAL checkpoints on close). */
  close(): void {
    this.db.close();
  }
}
