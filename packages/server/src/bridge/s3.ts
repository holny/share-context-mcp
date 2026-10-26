/**
 * S3Bridge — ChannelBackend implementation over any S3-compatible object
 * store (AWS S3 / Cloudflare R2 / 阿里 OSS / 腾讯 COS / self-hosted MinIO).
 *
 * Layout under `<prefix>/channels/<channelId>/`:
 *   state/head.json    {"nextSeq": N, "epoch": E}   (ETag conditional write)
 *   members.json       [{memberName, joinedAt}]
 *   messages/<epoch>/<seq 12-digit>-<idemKey8>.enc   {nonce, ciphertext}
 *
 * seq allocation: GET head (keep ETag) → conditional PUT head with If-Match
 * (412 = a concurrent writer won: re-read and retry, ≤5). Message objects are
 * PUT unconditionally after the seq is reserved.
 *
 * poll: ListObjectsV2 with start-after = last served key, ascending — lexicographic
 * order of the zero-padded seq equals numeric order.
 */
import { existsSync, readFileSync } from "node:fs";
import { deriveChannelKey, open as sealOpen, seal, validateClaim, type ClaimMessage } from "@share-context-mcp/protocol";
import { sigv4Headers } from "./sigv4";
import type { TransportState, TransportTuning } from "../transport";
import type { ClaimInput, ChannelBridge, ChannelMember, ChannelMeta, PollResult, S3ConnectionParams } from "./types";

const RETRY_LIMIT = 5;
const pad12 = (n: number) => String(n).padStart(12, "0");

export interface S3Connection extends S3ConnectionParams {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix for all channel state. Default "share-context-mcp". */
  prefix: string;
}

interface ChannelSecret {
  channelId: string;
  password: string;
  memberName: string;
  epoch: number;
  s3: S3Connection;
  /** Retained per spec §5.5: holders of an old password keep reading its epoch. */
  priorPasswords: Array<{ epoch: number; password: string }>;
}

export interface S3BridgeOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  /** Poll interval for listen(), ms. Default 10_000. */
  pollIntervalMs?: number;
}

export class S3Bridge implements ChannelBridge {
  private readonly secrets = new Map<string, ChannelSecret>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly defaultS3?: S3Connection;
  private readonly opts: S3BridgeOptions;

  constructor(opts: Partial<S3BridgeOptions> & { defaultS3?: S3Connection }) {
    this.opts = opts as S3BridgeOptions;
    this.defaultS3 = opts.defaultS3 ?? (opts.endpoint
      ? { endpoint: opts.endpoint, bucket: opts.bucket!, region: opts.region!, accessKeyId: opts.accessKeyId!, secretAccessKey: opts.secretAccessKey!, prefix: opts.prefix ?? "share-context-mcp" }
      : undefined);
  }

  private conn(s: ChannelSecret): S3Connection {
    return s.s3;
  }

  private secret(channelId: string): ChannelSecret {
    const s = this.secrets.get(channelId);
    if (!s) throw new Error("unknown channel — create or join first");
    return s;
  }

  private keyFor(s: ChannelSecret, epoch = s.epoch): Uint8Array {
    const pw = epoch === s.epoch ? s.password : (s.priorPasswords.find((p) => p.epoch === epoch)?.password ?? s.password);
    return deriveChannelKey(pw, `${s.channelId}/epoch/${epoch}`);
  }

  private async request(s: ChannelSecret, method: string, key: string, body?: Uint8Array, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: Uint8Array; etag?: string }> {
    const conn = this.conn(s);
    const url = `${conn.endpoint}/${conn.bucket}/${conn.prefix}/${key}`;
    const sig = sigv4Headers({ method, url, region: conn.region, accessKeyId: conn.accessKeyId, secretAccessKey: conn.secretAccessKey, body: body ?? "" });
    const res = await fetch(url, { method, headers: { ...sig, ...extraHeaders }, body: method === "GET" ? undefined : (body as unknown as BodyInit) });
    const resBody = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, body: resBody, etag: res.headers.get("etag") ?? undefined };
  }

  private async getJson<T>(s: ChannelSecret, key: string): Promise<{ data: T; etag: string } | null> {
    const r = await this.request(s, "GET", key);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`S3 GET ${key} failed: ${r.status}`);
    return { data: JSON.parse(new TextDecoder().decode(r.body)) as T, etag: r.etag! };
  }

  private async putJson(s: ChannelSecret, key: string, data: unknown, ifMatch?: string): Promise<{ etag: string }> {
    const body = new TextEncoder().encode(JSON.stringify(data));
    const extra: Record<string, string> = { "content-type": "application/json" };
    if (ifMatch !== undefined) extra["if-match"] = ifMatch;
    const r = await this.request(s, "PUT", key, body, extra);
    if (r.status === 412) throw new Error("condition failed: concurrent writer");
    if (r.status !== 200) throw new Error(`S3 PUT ${key} failed: ${r.status}`);
    return { etag: r.etag ?? "" };
  }

  private messageKey(s: ChannelSecret, channelId: string, epoch: number, seq: number, idem8: string): string {
    return `channels/${channelId}/${this.dir(s, epoch)}/${pad12(seq)}-${idem8}.enc`;
  }

  private dir(s: ChannelSecret, epoch: number): string {
    return `messages/epoch-${epoch}`;
  }

  async createChannel(opts: { name?: string; memberName: string; s3?: S3ConnectionParams }): Promise<{ channelId: string; password: string }> {
    const s3 = opts.s3 ?? this.defaultS3;
    if (!s3) throw new Error("S3Bridge.createChannel requires an S3 connection (env or params)");
    void opts.name;
    const channelId = "ch-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const password = "pw-" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    const secret: ChannelSecret = { channelId, password, memberName: opts.memberName, epoch: 1, s3, priorPasswords: [] };
    this.secrets.set(channelId, secret);
    // If-None-Match:* — creating over an existing channel id fails loudly.
    const headBody = new TextEncoder().encode(JSON.stringify({ nextSeq: 1, epoch: 1 }));
    const sig = sigv4Headers({ method: "PUT", url: `${s3.endpoint}/${s3.bucket}/${s3.prefix}/${headKey(channelId)}`, region: s3.region, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, body: headBody });
    const res = await fetch(`${s3.endpoint}/${s3.bucket}/${s3.prefix}/${headKey(channelId)}`, { method: "PUT", headers: { ...sig, "if-none-match": "*", "content-type": "application/json" }, body: headBody });
    if (res.status === 412) throw new Error("create failed: channel id already exists");
    if (res.status !== 200) throw new Error(`create failed: ${res.status}`);
    await this.putJson(secret, `channels/${channelId}/members.json`, [{ memberName: opts.memberName, joinedAt: new Date().toISOString() }]);
    return { channelId, password };
  }

  async join(channelId: string, password: string, memberName: string, opts?: { s3?: S3ConnectionParams }): Promise<void> {
    const s3 = (opts?.s3 ?? this.defaultS3) as S3Connection;
    if (!s3) throw new Error("S3Bridge.join requires an S3 connection");
    // Retain locally-held knowledge of older epochs (spec §5.5): a member who
    // re-joins with the new password keeps reading epochs it held keys for.
    const existing = this.secrets.get(channelId);
    const priorPasswords: Array<{ epoch: number; password: string }> = existing ? [...existing.priorPasswords] : [];
    const provisional: ChannelSecret = { channelId, password, memberName, epoch: 1, s3, priorPasswords };
    this.secrets.set(channelId, provisional);
    const head = await this.getJson<{ nextSeq: number; epoch: number }>(provisional, `channels/${channelId}/state/head.json`);
    if (!head) {
      this.secrets.delete(channelId);
      throw new Error("join failed: channel state not readable (check S3 credentials and endpoint)");
    }
    const epoch = head.data.epoch;
    if (existing && existing.epoch < epoch) provisional.priorPasswords.push({ epoch: existing.epoch, password: existing.password });
    provisional.epoch = epoch;
    const members = await this.getJson<Array<{ memberName: string; joinedAt: string }>>(provisional, `channels/${channelId}/members.json`);
    const list = members?.data ?? [];
    if (!list.some((m) => m.memberName === memberName)) {
      list.push({ memberName, joinedAt: new Date().toISOString() });
      await this.putJson(provisional, `channels/${channelId}/members.json`, list, members?.etag);
    }
  }

  async send(msg: ClaimInput, channelId?: string): Promise<{ seq: number; deduped: boolean }> {
    const ch = channelId ?? "";
    const s = this.secret(ch);
    const checked = validateClaim({ ...msg, provenance: { ...(msg.provenance ?? {}), member: s.memberName, source: "agent" as const } });
    if (!checked.ok) throw new Error(checked.reason);
    const claim = checked.msg;
    // Reserve the seq FIRST (conditional head PUT, §3.1), then publish the
    // message object at the reserved seq — a lost race never leaves an orphan
    // file behind (review: OCR wave).
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
      const head = await this.getJson<{ nextSeq: number; epoch: number }>(s, `channels/${ch}/state/head.json`);
      if (!head) throw new Error("send failed: channel head missing");
      const seq = head.data.nextSeq;
      try {
        await this.putJson(s, `channels/${ch}/state/head.json`, { nextSeq: seq + 1, epoch: head.data.epoch }, head.etag);
      } catch {
        continue; // 412: concurrent writer won this seq — re-read and retry
      }
      const key = this.keyFor(s, head.data.epoch);
      const env = seal(claim, key);
      const messageKey = this.messageKey(s, ch, head.data.epoch, seq, claim.idempotencyKey.slice(0, 8));
      const putMsg = await this.request(s, "PUT", messageKey, new TextEncoder().encode(JSON.stringify(env)));
      if (putMsg.status !== 200) throw new Error(`send failed: message PUT ${putMsg.status}`);
      return { seq, deduped: false };
    }
    throw new Error(`send failed after ${RETRY_LIMIT} attempts — try again`);
  }

  async poll(channelId: string, since: number, _opts?: { markActivity?: boolean }): Promise<PollResult> {
    const s = this.secret(channelId);
    const head = await this.getJson<{ nextSeq: number; epoch: number }>(s, `channels/${channelId}/state/head.json`);
    if (!head) return { messages: [], skipped: 0 };
    const high = head.data.nextSeq - 1;
    if (high <= since) return { messages: [], skipped: 0 };
    const conn = this.conn(s);
    // List every message key after the padded `since` position, ascending.
    const listPrefix = `${conn.prefix}/channels/${channelId}/messages/`;
    const startAfter = `${listPrefix}${pad12(since + 1)}`;
    const url = `${conn.endpoint}/${conn.bucket}?list-type=2&prefix=${encodeURIComponent(listPrefix)}&start-after=${encodeURIComponent(startAfter)}`;
    const sig = sigv4Headers({ method: "GET", url, region: conn.region, accessKeyId: conn.accessKeyId, secretAccessKey: conn.secretAccessKey });
    const res = await fetch(url, { headers: sig });
    if (res.status !== 200) throw new Error(`S3Bridge poll: list failed ${res.status}`);
    const xml = await res.text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).sort();

    const out: ClaimMessage[] = [];
    let skipped = 0;
    for (const full of keys) {
      const fileName = full.split("/").pop()!;
      const seq = Number(fileName.split("-")[0]);
      if (!Number.isFinite(seq) || seq <= since || seq > high) continue;
      const r = await this.request(s, "GET", full.replace(`${conn.prefix}/`, ""));
      if (r.status !== 200) { skipped++; continue; }
      // try every epoch key the member holds (spec §5.5: old-key holders keep reading)
      let delivered = false;
      const epochs = [s.epoch, ...s.priorPasswords.map((p) => p.epoch)].sort((a, b) => b - a);
      for (const epoch of epochs) {
        try {
          const msg = sealOpen(JSON.parse(new TextDecoder().decode(r.body)), this.keyFor(s, epoch));
          msg.seq = seq;
          out.push(msg);
          delivered = true;
          break;
        } catch { /* try next retained key */ }
      }
      if (!delivered) skipped++;
    }
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { messages: out, skipped };
  }

  async meta(channelId: string): Promise<ChannelMeta> {
    const s = this.secret(channelId);
    const members = await this.getJson<Array<{ memberName: string; joinedAt: string }>>(s, `channels/${channelId}/members.json`);
    const head = await this.getJson<{ nextSeq: number; epoch: number }>(s, `channels/${channelId}/state/head.json`);
    return { members: members?.data ?? [], nextSeq: head?.data.nextSeq ?? 1 };
  }

  listen(channelId: string, onNotify: (seq: number) => void, _tuning?: TransportTuning): { stop: () => Promise<void>; markActivity(): void; closeForTest(): void; readonly state: TransportState } {
    const interval = this.opts.pollIntervalMs ?? 10_000;
    const timer = setInterval(() => onNotify(0), interval);
    this.timers.set(channelId, timer);
    return {
      stop: async () => {
        const t = this.timers.get(channelId);
        if (t) clearInterval(t);
        this.timers.delete(channelId);
      },
      markActivity() {},
      closeForTest() {},
      get state() { return "poll" as const; },
    };
  }

  async rotate(channelId: string, newPassword: string): Promise<void> {
    const s = this.secret(channelId);
    const head = await this.getJson<{ nextSeq: number; epoch: number }>(s, `channels/${channelId}/state/head.json`);
    s.priorPasswords.push({ epoch: s.epoch, password: s.password });
    s.password = newPassword;
    s.epoch = (head?.data.epoch ?? s.epoch) + 1;
    await this.putJson(s, `channels/${channelId}/state/head.json`, { nextSeq: head?.data.nextSeq ?? 1, epoch: s.epoch });
  }

  async leave(channelId: string): Promise<void> {
    this.secrets.delete(channelId);
    const t = this.timers.get(channelId);
    if (t) clearInterval(t);
    this.timers.delete(channelId);
  }
}

function headKey(channelId: string): string {
  return `channels/${channelId}/state/head.json`;
}
