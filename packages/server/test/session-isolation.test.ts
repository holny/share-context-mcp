/**
 * Session isolation tests: multiple MCP server processes (sessions) on the
 * same machine, same channel — each session gets an independent view.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startFakeS3 } from "../src/bridge/fake-s3";
import { S3Bridge } from "../src/bridge/s3";
import { Store } from "../src/store";

let root: string;
let stopFake: () => void;
let fakeUrl: string;
let alice: S3Bridge;
let bob: S3Bridge;
let channelId: string;

const conn = () => ({
  endpoint: fakeUrl, bucket: "b", region: "r",
  accessKeyId: "ak", secretAccessKey: "sk", prefix: "test",
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "scm-session-"));
  const fake = startFakeS3(0);
  stopFake = fake.stop;
  fakeUrl = fake.url;
  alice = new S3Bridge({ ...conn(), defaultS3: conn() });
  bob = new S3Bridge({ ...conn(), defaultS3: conn() });
  const created = await alice.createChannel({ memberName: "alice", s3: conn() });
  channelId = created.channelId;
  await bob.join(channelId, created.password, "bob", { s3: conn() });
});

afterAll(() => { stopFake(); rmSync(root, { recursive: true, force: true }); });

test("two sessions on same machine, same channel — independent consumption", async () => {
  // session 1 and session 2 are two S3Bridge instances (separate processes in prod)
  // alice sends 3 messages
  for (let i = 1; i <= 3; i++) {
    await alice.send({ statement: `msg ${i}`, kind: "progress", topic: "t", seq: null, ts: new Date().toISOString(), provenance: { member: "alice", source: "agent" } }, channelId);
  }
  // session 1 (alice) fetches → sees 3, delivered advances
  const s1 = await alice.poll(channelId, 0);
  expect(s1.messages.length).toBe(3);
  // session 2 (bob) fetches independently → also sees 3
  const s2 = await bob.poll(channelId, 0);
  expect(s2.messages.length).toBe(3);
  // both sessions independently consumed the same messages — no interference
});

test("cross-session: bob's reply visible to alice", async () => {
  await bob.send({ statement: "bob reply", kind: "decision", topic: "t", seq: null, ts: new Date().toISOString(), provenance: { member: "bob", source: "agent" } }, channelId);
  const r = await alice.poll(channelId, 0);
  expect(r.messages.some((m) => m.statement.includes("bob reply"))).toBe(true);
});

test("same S3Bridge instance, two channels — no cross-channel interference", async () => {
  const c2 = await alice.createChannel({ memberName: "alice", s3: conn() });
  await alice.send({ statement: "channel 2 message", kind: "progress", topic: "other", seq: null, ts: new Date().toISOString(), provenance: { member: "alice", source: "agent" } }, c2.channelId);
  // channel 1 messages not visible in channel 2
  const r = await alice.poll(c2.channelId, 0);
  // messages don't carry channelId — isolation is by separate seq spaces
  expect(r.messages.length).toBe(1); // only channel 2's message
});

// ---- consumer identity (Task 3): one MCP server process, many sessions ----
// Uses RelayBridge (the only bridge that persists channels into the Store —
// same pattern as mcp.test.ts; S3/Git MCP persistence is a separate gap).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startRelay } from "@share-context-mcp/relay";
import { buildMcpServer, consumerIdFromExtra } from "../src/mcp";
import { RelayBridge } from "../src/bridge/relay";

describe("consumer identity via _meta sessionID", () => {
  let root2: string;
  let stopRelay: () => Promise<void>;
  let client: Client;
  let store: Store;
  let channelId2: string;

  const call = async (name: string, args: Record<string, unknown>, sessionID?: string) => {
    const res = await client.callTool({
      name,
      arguments: args,
      ...(sessionID === undefined ? {} : { _meta: { "ai.opencode/sessionID": sessionID } }),
    });
    const text = (res as { content?: Array<{ text?: string }> }).content?.map((c) => c.text ?? "").join("\n") ?? "";
    const lines = text.split("\n");
    const payload = lines[0]?.startsWith("📋") ? lines.slice(1).map((l) => l.slice(2)).join("\n") : text;
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return { raw: payload, isError: (res as { isError?: boolean }).isError === true };
    }
  };

  beforeAll(async () => {
    const relay = await startRelay({ port: 0 });
    stopRelay = relay.stop;
    root2 = mkdtempSync(join(tmpdir(), "scm-consumer-"));
    store = new Store(join(root2, "state.db"));
    const bridge = new RelayBridge({ baseUrl: `http://127.0.0.1:${relay.port}`, store });
    (globalThis as Record<string, unknown>).__bridgeSingleton = bridge;
    const server = buildMcpServer({ store, bridge });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "consumer-test", version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    // create_channel answers with plain text (not quote-wrapped JSON)
    const createdRaw = ((await call("create_channel", { memberName: "alice" })) as { raw: string }).raw;
    channelId2 = /channel_id=([a-z0-9]+)/.exec(createdRaw)![1];
  });

  afterAll(async () => { await stopRelay(); rmSync(root2, { recursive: true, force: true }); });

  test("consumerIdFromExtra: sessionID path and pid fallback", () => {
    // full sessionID preserved — slicing to 8 chars leaves ~4 variable chars
    // after the ses_ prefix (collision → two sessions share a cursor)
    expect(consumerIdFromExtra({ _meta: { "ai.opencode/sessionID": "ses_abcdefgh123" } })).toBe("s/ses_abcdefgh123");
    expect(consumerIdFromExtra(undefined)).toMatch(/^p\//);
    expect(consumerIdFromExtra({})).toMatch(/^p\//);
  });

  test("two sessions sharing one process each consume the same messages independently", async () => {
    for (let i = 1; i <= 3; i++) {
      await call("share_update", { statement: `shared fact ${i}`, kind: "progress", topic: "t" }, "ses_abcdefgh123");
    }
    // consumer 1 fetches → sees all 3
    const c1 = (await call("fetch_updates", {}, "ses_abcdefgh123")) as { messages: unknown[] };
    expect(c1.messages.length).toBe(3);
    // consumer 2 (different sessionID, same process) ALSO sees all 3
    const c2 = (await call("fetch_updates", {}, "ses_zzzzzzzz999")) as { messages: unknown[] };
    expect(c2.messages.length).toBe(3);
    // consumer 1 again → nothing new
    const c1b = (await call("fetch_updates", {}, "ses_abcdefgh123")) as { messages: unknown[] };
    expect(c1b.messages.length).toBe(0);
  });

  test("client without _meta falls back to a pid-scoped consumer and still works", async () => {
    const r = (await call("fetch_updates", {})) as { messages: unknown[]; cursor: number };
    expect(Array.isArray(r.messages)).toBe(true);
    expect(r.cursor).toBeGreaterThan(0);
  });

  test("digest posting failure does not turn fetch_updates into a tool error", async () => {
    await call("share_update", { statement: "decided: digest failure probe", kind: "decision", topic: "t" }, "ses_abcdefgh123");
    await call("fetch_updates", {}, "ses_abcdefgh123"); // cache the message
    // force the gap so maybePostDigest attempts a post (pending = the cached message)
    process.env.SHARE_CONTEXT_DIGEST_MIN_MSGS = "1";
    store.setKv(`gap:${channelId2}`, "5"); // pending (0,4] includes the probe decision
    const bridgeSingleton = (globalThis as Record<string, unknown>).__bridgeSingleton as RelayBridge;
    const self = bridgeSingleton as unknown as { send: (msg: unknown, ch?: string) => Promise<{ seq: number; deduped: boolean }> };
    const original = self.send.bind(bridgeSingleton);
    self.send = async () => {
      throw new Error("relay down");
    };
    try {
      const r = (await call("fetch_updates", {}, "ses_abcdefgh123")) as { messages?: unknown[]; raw?: string; isError?: boolean };
      expect(r.isError).toBeUndefined();
      expect(Array.isArray(r.messages)).toBe(true);
    } finally {
      self.send = original;
      delete process.env.SHARE_CONTEXT_DIGEST_MIN_MSGS;
      store.setKv(`gap:${channelId2}`, "0");
    }
  });
});
