/**
 * Relay WebSocket push endpoint tests (spec §5.5/§5.7, M2 task-1 brief Step 1).
 *
 * BLINDNESS RULES under test: push frames carry ONLY {type, seq, epoch}
 * (hello: {type, seq}; ping: {type}) — never ciphertext, plaintext, or
 * member identities.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveChannelKey,
  hmacProof,
  idempotencyKey,
  seal,
  validateClaim,
  type ClaimMessage,
} from "@share-context-mcp/protocol";
import { startRelay, type RelayHandle } from "../src/index";

const PASSWORD = "correct horse battery staple";

let relay: RelayHandle;
let base: string;
let wsBase: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "relay-ws-test-"));
  // Short heartbeat so the ping test observes a frame quickly (prod: 25s).
  relay = await startRelay({ port: 0, dbPath: join(dir, "relay.db"), pingIntervalMs: 100 });
  base = `http://127.0.0.1:${relay.port}`;
  wsBase = `ws://127.0.0.1:${relay.port}`;
});

afterAll(async () => {
  await relay?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---- HTTP helpers (mirrors relay.test.ts) ----

function verifyKeyB64Of(password: string, channelId: string): string {
  const key = deriveChannelKey(password, channelId);
  return createHmac("sha256", Buffer.from(key)).update("verify", "utf8").digest("base64");
}

function proofOf(verifyKeyB64: string, nonceB64: string): string {
  return hmacProof(new Uint8Array(Buffer.from(verifyKeyB64, "base64")), nonceB64);
}

async function postJson(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function setupChannel(): Promise<{ channelId: string; token: string }> {
  const channelId = randomBytes(8).toString("hex");
  const created = await postJson("/channels", {
    channelId,
    memberName: "alice",
    verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
  });
  expect(created.status).toBe(200);
  const ch = await postJson(`/channels/${channelId}/challenge`, { memberName: "alice" });
  const { nonceB64 } = (await ch.json()) as { nonceB64: string };
  const joined = await postJson(`/channels/${channelId}/join`, {
    memberName: "alice",
    proof: proofOf(verifyKeyB64Of(PASSWORD, channelId), nonceB64),
  });
  expect(joined.status).toBe(200);
  const { token } = (await joined.json()) as { token: string };
  return { channelId, token };
}

/** Seal a real claim and POST it; returns {seq, deduped}. */
async function sendClaim(
  token: string,
  channelId: string,
  statement: string,
  opts: { kind?: ClaimMessage["kind"] } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = deriveChannelKey(PASSWORD, channelId);
  const validated = validateClaim({
    ts: "2026-10-26T10:00:00Z",
    statement,
    kind: opts.kind ?? "progress",
    topic: "relay-ws-test",
    provenance: { member: "alice", agent: "opencode-v2", source: "agent" },
  });
  if (!validated.ok) throw new Error(`fixture invalid: ${validated.reason}`);
  const env = seal(validated.msg, key);
  const res = await postJson(`/channels/${channelId}/messages`, {
    nonce: env.nonce,
    ciphertext: env.ciphertext,
    idemKey: validated.msg.idempotencyKey ?? idempotencyKey(statement, "progress", "relay-ws-test"),
  }, token);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---- WS test client ----

type Frame = Record<string, unknown>;

class WsSession {
  readonly ws: WebSocket;
  /** true if the upgrade succeeded (open fired before any error). */
  readonly opened: Promise<boolean>;
  readonly closed: Promise<{ code: number; reason: string }>;
  private queue: Frame[] = [];
  private waiters: Array<(f: Frame) => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise<boolean>((resolve) => {
      this.ws.addEventListener("open", () => resolve(true));
      this.ws.addEventListener("error", () => resolve(false));
    });
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener("close", (ev) => {
        const ce = ev as CloseEvent;
        resolve({ code: ce.code, reason: ce.reason });
      });
    });
    this.ws.addEventListener("message", (ev) => {
      const frame = JSON.parse(String((ev as MessageEvent).data)) as Frame;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
  }

  /**
   * Next frame in arrival order. With skipPings (default) heartbeat frames
   * are consumed silently so tests assert on meaningful notifications only.
   */
  async nextFrame(opts: { skipPings?: boolean; timeoutMs?: number } = {}): Promise<Frame> {
    const skipPings = opts.skipPings ?? true;
    // Deadline is TOTAL for this call, not per-waiter: heartbeat pings resolve
    // waiters continuously, so a per-wait timer would never fire.
    const deadline = Date.now() + (opts.timeoutMs ?? 2000);
    for (;;) {
      const queued = this.queue.shift();
      if (queued) {
        if (skipPings && queued.type === "ping") continue;
        return queued;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no frame within ${opts.timeoutMs ?? 2000}ms`);
      const f = await new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no frame within ${opts.timeoutMs ?? 2000}ms`)), remaining);
        this.waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
      if (!(skipPings && f.type === "ping")) return f;
    }
  }

  close(): void {
    this.ws.close();
  }
}

// ---- tests ----

describe("relay websocket push", () => {
  test("hello carries the current last-allocated seq; frames are seq-only (blind)", async () => {
    const { channelId, token } = await setupChannel();
    // two messages already stored before connecting
    const m1 = await sendClaim(token, channelId, "first pre-connect message");
    expect(m1.status).toBe(200);
    const m2 = await sendClaim(token, channelId, "second pre-connect message", { kind: "decision" });
    expect(m2.status).toBe(200);

    const s = new WsSession(`${wsBase}/channels/${channelId}/ws?token=${encodeURIComponent(token)}`);
    try {
      expect(await s.opened).toBe(true);
      const hello = await s.nextFrame();
      expect(hello).toEqual({ type: "hello", seq: 2 });
      // blind property: hello carries only type+seq
      expect(Object.keys(hello).sort()).toEqual(["seq", "type"]);
    } finally {
      s.close();
    }
  });

  test("2 sends → 2 message notifications in order, seq-only frames", async () => {
    const { channelId, token } = await setupChannel();
    const s = new WsSession(`${wsBase}/channels/${channelId}/ws?token=${encodeURIComponent(token)}`);
    try {
      expect(await s.opened).toBe(true);
      const hello = await s.nextFrame();
      expect(hello).toEqual({ type: "hello", seq: 0 });

      const m1 = await sendClaim(token, channelId, "push me one");
      expect(m1.status).toBe(200);
      const m2 = await sendClaim(token, channelId, "push me two", { kind: "decision" });
      expect(m2.status).toBe(200);

      const f1 = await s.nextFrame();
      const f2 = await s.nextFrame();
      expect(f1).toEqual({ type: "message", seq: 1, epoch: 1 });
      expect(f2).toEqual({ type: "message", seq: 2, epoch: 1 });
      // blind property: notifications carry ONLY type/seq/epoch
      expect(Object.keys(f1).sort()).toEqual(["epoch", "seq", "type"]);
      expect(Object.keys(f2).sort()).toEqual(["epoch", "seq", "type"]);
    } finally {
      s.close();
    }
  });

  test("bad or missing token → upgrade rejected", async () => {
    const { channelId } = await setupChannel();

    const bad = new WsSession(`${wsBase}/channels/${channelId}/ws?token=${encodeURIComponent("bm90LWEtdG9rZW4=")}`);
    expect(await bad.opened).toBe(false);

    const missing = new WsSession(`${wsBase}/channels/${channelId}/ws`);
    expect(await missing.opened).toBe(false);
  });

  test("rotate → epoch-invalidated frame then close(1008); old-epoch token rejected at upgrade", async () => {
    const { channelId, token } = await setupChannel();
    const s = new WsSession(`${wsBase}/channels/${channelId}/ws?token=${encodeURIComponent(token)}`);
    expect(await s.opened).toBe(true);
    await s.nextFrame(); // hello

    const rotate = await postJson(`/channels/${channelId}/rotate`, {}, token);
    expect(rotate.status).toBe(200);
    expect((await rotate.json()) as Record<string, unknown>).toEqual({ epoch: 2 });

    const inv = await s.nextFrame();
    expect(inv).toEqual({ type: "epoch-invalidated", epoch: 2 });
    const closed = await s.closed;
    expect(closed.code).toBe(1008);

    // a connection attempt with the now-dead (old-epoch) token is rejected
    const stale = new WsSession(`${wsBase}/channels/${channelId}/ws?token=${encodeURIComponent(token)}`);
    expect(await stale.opened).toBe(false);
  });

  test("heartbeat: server ping observed within the interval", async () => {
    const { channelId, token } = await setupChannel();
    const s = new WsSession(`${wsBase}/channels/${channelId}/ws?token=${encodeURIComponent(token)}`);
    try {
      expect(await s.opened).toBe(true);
      await s.nextFrame(); // hello
      const ping = await s.nextFrame({ skipPings: false, timeoutMs: 5000 });
      expect(ping).toEqual({ type: "ping" });
      // blind property: the heartbeat frame carries no payload
      expect(Object.keys(ping)).toEqual(["type"]);
    } finally {
      s.close();
    }
  });

  test("expired-token WS upgrade rejected (token TTL enforced at upgrade)", async () => {
    const { channelId, token } = await setupChannel();
    // Least-invasive TTL manipulation: expire the token directly in the
    // relay's shared SQLite file (WAL — a brief external writer is safe);
    // no production surface is added for a knob only tests observe.
    const db = new Database(join(dir, "relay.db"));
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.prepare("UPDATE members SET token_expires_at = ? WHERE channel_id = ?").run(Date.now() - 1000, channelId);
    } finally {
      db.close();
    }
    const s = new WsSession(`${wsBase}/channels/${channelId}/ws?token=${encodeURIComponent(token)}`);
    expect(await s.opened).toBe(false);
  });

  test("unknown-channel WS upgrade rejected", async () => {
    const s = new WsSession(`${wsBase}/channels/000000000000/ws?token=${encodeURIComponent("whatever")}`);
    expect(await s.opened).toBe(false);
  });

  test("cross-channel isolation: sends on channel B do not reach channel A sockets", async () => {
    const a = await setupChannel();
    const b = await setupChannel();
    const sA = new WsSession(`${wsBase}/channels/${a.channelId}/ws?token=${encodeURIComponent(a.token)}`);
    try {
      expect(await sA.opened).toBe(true);
      await sA.nextFrame(); // hello
      const sent = await sendClaim(b.token, b.channelId, "for channel b only");
      expect(sent.status).toBe(200);
      let leaked = false;
      try {
        await sA.nextFrame({ skipPings: true, timeoutMs: 400 });
        leaked = true;
      } catch {
        // expected: no frame for channel A
      }
      expect(leaked).toBe(false);
    } finally {
      sA.close();
    }
  });

  test("stop() closes live websocket connections", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "relay-ws-stop-"));
    const relay2 = await startRelay({ port: 0, dbPath: join(dir2, "relay.db"), pingIntervalMs: 0 });
    const base2 = `http://127.0.0.1:${relay2.port}`;
    const wsBase2 = `ws://127.0.0.1:${relay2.port}`;
    try {
      const channelId = randomBytes(8).toString("hex");
      const vk = verifyKeyB64Of(PASSWORD, channelId);
      await (await fetch(`${base2}/channels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, memberName: "alice", verifyKeyB64: vk }),
      })).json();
      const ch = await (await fetch(`${base2}/channels/${channelId}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberName: "alice" }),
      })).json() as { nonceB64: string };
      const joined = await (await fetch(`${base2}/channels/${channelId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberName: "alice", proof: proofOf(vk, ch.nonceB64) }),
      })).json() as { token: string };

      const s = new WsSession(`${wsBase2}/channels/${channelId}/ws?token=${encodeURIComponent(joined.token)}`);
      expect(await s.opened).toBe(true);
      await relay2.stop();
      const closed = await s.closed;
      expect(closed.code).toBe(1001);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
