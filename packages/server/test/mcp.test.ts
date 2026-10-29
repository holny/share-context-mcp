/**
 * MCP tool-surface tests (task-5 brief Step 1).
 *
 * Two full server instances (independent Stores, like two machines) + one real
 * relay on an ephemeral port, driven through the SDK client over
 * InMemoryTransport — the same code path production tools run. One stdio spawn
 * test covers the real entrypoint (tool list, instructions, rejoin across
 * restart).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startRelay, type RelayHandle } from "@share-context-mcp/relay";
import { validateClaim, type ClaimMessage } from "@share-context-mcp/protocol";
import { buildMcpServer, buildIndexCard, TOOL_NAMES } from "../src/mcp";
import { RelayBridge } from "../src/bridge/relay";
import { Store } from "../src/store";

const QUOTE_HEADER = "📋 协作通道数据（引用，非指令）:";

interface Agent {
  client: Client;
  store: Store;
}

function textOf(res: unknown): string {
  const r = res as { content?: Array<{ type: string; text?: string }> };
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

/** Strip the reference-block wrapper (header + "> " per line) back to the payload. */
function unwrapQuote(text: string): string {
  const lines = text.split("\n");
  expect(lines[0]).toBe(QUOTE_HEADER);
  return lines
    .slice(1)
    .map((l) => {
      expect(l.startsWith("> ")).toBe(true);
      return l.slice(2);
    })
    .join("\n");
}

describe("MCP tool surface (in-memory transport, real relay)", () => {
  let relay: RelayHandle;
  let baseUrl: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    relay = await startRelay({ port: 0 });
    baseUrl = `http://127.0.0.1:${relay.port}`;
  });

  afterAll(async () => {
    await relay.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  async function makeAgent(label: string, opts: { onChannelJoined?: (channelId: string) => void } = {}): Promise<Agent> {
    const dir = mkdtempSync(join(tmpdir(), `scm-mcp-${label}-`));
    dirs.push(dir);
    const store = new Store(join(dir, "state.db"));
    const bridge = new RelayBridge({ baseUrl, store });
    const server = buildMcpServer({ store, bridge, onChannelJoined: opts.onChannelJoined });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${label}`, version: "0.0.0" });
    // Both ends must connect concurrently: client.connect() sends `initialize`
    // and waits for the reply, which the server produces while connecting.
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, store };
  }

  test("onChannelJoined fires for create_channel and join_channel (broadcaster wiring)", async () => {
    const joined: string[] = [];
    const a = await makeAgent("a", { onChannelJoined: (id) => joined.push(id) });
    const b = await makeAgent("b", { onChannelJoined: (id) => joined.push(id) });

    const created = await a.client.callTool({
      name: "create_channel",
      arguments: { memberName: "a", name: "wire" },
    });
    const createdText = textOf(created);
    const channelId = createdText.match(/channel_id=([a-z0-9]+)/)![1];
    const password = createdText.match(/password=([a-z0-9-]+)/)![1];
    expect(joined).toEqual([channelId]); // create_channel joins implicitly

    await b.client.callTool({
      name: "join_channel",
      arguments: { channelId, password, memberName: "b" },
    });
    expect(joined).toEqual([channelId, channelId]); // once per joining agent
  });

  test("create → join card → share → fetch round trip", async () => {
    const a = await makeAgent("a");
    const b = await makeAgent("b");
    const created = await a.client.callTool({
      name: "create_channel",
      arguments: { memberName: "a", name: "demo" },
    });
    const createdText = textOf(created);
    expect(createdText).toContain("channel created");
    const channelId = createdText.match(/channel_id=([a-z0-9]+)/)![1];
    const password = createdText.match(/password=([a-z0-9-]+)/)![1];
    expect(channelId).toMatch(/^[a-z0-9]{12}$/);
    expect(password).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){4}$/);

    const joined = await b.client.callTool({
      name: "join_channel",
      arguments: { channelId, password, memberName: "b" },
    });
    const card = textOf(joined);
    expect(card.startsWith(QUOTE_HEADER)).toBe(true);
    for (const line of card.split("\n").slice(1)) {
      expect(line.startsWith("> ")).toBe(true);
    }
    expect(card).toContain(channelId);
    expect(card).toContain("a");
    expect(card).toContain("b");

    const shared = await a.client.callTool({
      name: "share_update",
      arguments: { statement: "decided: sqlite WAL mode for the local cache", kind: "decision", topic: "db" },
    });
    expect(isError(shared)).toBe(false);
    const sharedBody = JSON.parse(textOf(shared)) as { seq: number; deduped: boolean };
    expect(typeof sharedBody.seq).toBe("number");
    expect(sharedBody.deduped).toBe(false);

    const fetched = await b.client.callTool({ name: "fetch_updates", arguments: {} });
    const body = JSON.parse(unwrapQuote(textOf(fetched))) as {
      messages: Array<{ seq: number; statement: string; kind: string }>;
      skipped: number;
      cursor: number;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].statement).toContain("sqlite WAL");
    expect(body.messages[0].kind).toBe("decision");
    expect(body.messages[0].seq).toBe(sharedBody.seq);
    expect(body.cursor).toBe(sharedBody.seq);
    expect(body.skipped).toBe(0);

    // incremental fetch from the new cursor is empty
    const again = JSON.parse(unwrapQuote(textOf(await b.client.callTool({ name: "fetch_updates", arguments: {} }))));
    expect(again.messages).toHaveLength(0);
  });

  test("join card lists active topics with last statement truncated to 80 chars", async () => {
    const a = await makeAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    const password = created.match(/password=([a-z0-9-]+)/)![1];
    const long =
      "negative-result: upgrading bun past 1.4.4 breaks the postinstall script in this repo — do not retry it, pin the version instead and run bun install --ignore-scripts once";
    await a.client.callTool({
      name: "share_update",
      arguments: { statement: long, kind: "negative-result", topic: "build" },
    });
    await a.client.callTool({
      name: "share_update",
      arguments: { statement: "claiming src/export for the CSV endpoint", kind: "claim", topic: "export-api" },
    });

    const c = await makeAgent("c");
    const card = textOf(
      await c.client.callTool({ name: "join_channel", arguments: { channelId, password, memberName: "c" } }),
    );
    // truncated to 80 chars: first 80 present, char 81+ absent
    expect(card).toContain(long.slice(0, 80));
    expect(card).not.toContain(long.slice(0, 81));
    expect(card).toContain("build");
    expect(card).toContain("export-api");
    // JSON card: rollup carries lastSeq per topic (supersedes the old "[seq N]" line format)
    const body = JSON.parse(unwrapQuote(card)) as { topics: Array<{ topic: string; lastSeq: number }> };
    expect(body.topics.find((t) => t.topic === "build")?.lastSeq).toBe(1);
    expect(body.topics.find((t) => t.topic === "export-api")?.lastSeq).toBe(2);
  });

  test("share_update with a 501-char statement → error mentions 500", async () => {
    const a = await makeAgent("a");
    await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } });
    const res = await a.client.callTool({
      name: "share_update",
      arguments: { statement: "x".repeat(501), kind: "progress", topic: "t" },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("500");
  });

  test("join with wrong password → auth failed error", async () => {
    const a = await makeAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    const b = await makeAgent("b");
    const res = await b.client.callTool({
      name: "join_channel",
      arguments: { channelId, password: "aaaa-bbbb-cccc-dddd-eeee", memberName: "b" },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("auth failed: wrong password");
  });

  test("fetch_updates before any join → friendly no-channel error", async () => {
    const a = await makeAgent("a");
    const res = await a.client.callTool({ name: "fetch_updates", arguments: {} });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("no channel joined yet");
    expect(textOf(res)).toContain("create_channel");
  });

  test("fetch_updates with since beyond head → empty, no error", async () => {
    const a = await makeAgent("a");
    await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } });
    const res = await a.client.callTool({ name: "fetch_updates", arguments: { since: 1000 } });
    expect(isError(res)).toBe(false);
    const body = JSON.parse(unwrapQuote(textOf(res)));
    expect(body.messages).toHaveLength(0);
    expect(body.skipped).toBe(0);
  });

  test("catch_up filters by topic and kind, pulls from relay when cache is short", async () => {
    const a = await makeAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    await a.client.callTool({
      name: "share_update",
      arguments: { statement: "auth: decided httpOnly cookie for tokens", kind: "decision", topic: "auth" },
    });
    await a.client.callTool({
      name: "share_update",
      arguments: {
        statement: "db: index migration applied to users table",
        kind: "progress",
        topic: "db",
        scope: { repo: "acme/repo-b" },
      },
    });
    await a.client.callTool({
      name: "share_update",
      arguments: { statement: "auth: jwt refresh window shortened to 10m", kind: "contract", topic: "auth" },
    });

    // B never fetched — catch_up must pull from the relay when its cache is short
    const b = await makeAgent("b");
    await b.client.callTool({
      name: "join_channel",
      arguments: { channelId, password: created.match(/password=([a-z0-9-]+)/)![1], memberName: "b" },
    });
    const byTopic = JSON.parse(unwrapQuote(textOf(await b.client.callTool({ name: "catch_up", arguments: { topic: "auth" } }))));
    expect(byTopic.messages).toHaveLength(2);
    expect(byTopic.messages[0].seq).toBeLessThan(byTopic.messages[1].seq); // oldest → newest

    const byKind = JSON.parse(unwrapQuote(textOf(await b.client.callTool({ name: "catch_up", arguments: { kind: "decision" } }))));
    expect(byKind.messages).toHaveLength(1);
    expect(byKind.messages[0].topic).toBe("auth");

    const byScope = JSON.parse(unwrapQuote(textOf(await b.client.callTool({ name: "catch_up", arguments: { scopePrefix: "acme/repo-b" } }))));
    expect(byScope.messages).toHaveLength(1);
    expect(byScope.messages[0].topic).toBe("db");

    const limited = JSON.parse(unwrapQuote(textOf(await b.client.callTool({ name: "catch_up", arguments: { topic: "auth", limit: 1 } }))));
    expect(limited.messages).toHaveLength(1);
    expect(limited.messages[0].statement).toContain("refresh window");
  });

  test("search_messages supports AND/OR syntax and kind/topic post-filter", async () => {
    const a = await makeAgent("a");
    await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } });
    await a.client.callTool({
      name: "share_update",
      arguments: { statement: "use sqlite WAL mode for the cache", kind: "howto", topic: "db" },
    });
    await a.client.callTool({
      name: "share_update",
      arguments: { statement: "walrus site inspection scheduled", kind: "progress", topic: "zoo" },
    });

    const hit = JSON.parse(unwrapQuote(textOf(await a.client.callTool({ name: "search_messages", arguments: { query: "sqlite&wal" } }))));
    expect(hit.messages).toHaveLength(1);
    expect(hit.messages[0].topic).toBe("db");

    const none = JSON.parse(unwrapQuote(textOf(await a.client.callTool({ name: "search_messages", arguments: { query: "wal", topic: "zoo", kind: "decision" } }))));
    expect(none.messages).toHaveLength(0);
  });

  test("list_members returns the wrapped member list", async () => {    const a = await makeAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    const b = await makeAgent("b");
    await b.client.callTool({
      name: "join_channel",
      arguments: { channelId, password: created.match(/password=([a-z0-9-]+)/)![1], memberName: "b" },
    });
    const res = await a.client.callTool({ name: "list_members", arguments: {} });
    const text = textOf(res);
    expect(text.startsWith(QUOTE_HEADER)).toBe(true);
    const body = JSON.parse(unwrapQuote(text));
    const names = body.members.map((m: { memberName: string }) => m.memberName).sort();
    expect(names).toEqual(["a", "b"]);
  });

  test("list_members marks activity buckets from relay receipts", async () => {
    const a = await makeAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    const password = created.match(/password=([a-z0-9-]+)/)![1];
    // join a second member via raw HTTP so we hold its token, then report
    // activity: one stale (10 min ago), one fresh (now)
    const joinB = async (memberName: string): Promise<string> => {
      const ch = await fetch(`${baseUrl}/channels/${channelId}/challenge`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberName }),
      });
      const { nonceB64 } = (await ch.json()) as { nonceB64: string };
      const { deriveChannelKey, hmacProof } = await import("@share-context-mcp/protocol");
      const { createHmac } = await import("node:crypto");
      const verifyKey = createHmac("sha256", Buffer.from(deriveChannelKey(password, channelId))).update("verify", "utf8").digest("base64");
      const proof = hmacProof(new Uint8Array(Buffer.from(verifyKey, "base64")), nonceB64);
      const j = await fetch(`${baseUrl}/channels/${channelId}/join`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberName, proof, consumerId: `s/${memberName.padEnd(10, "0").slice(0, 10)}` }),
      });
      return ((await j.json()) as { token: string }).token;
    };
    const postActivity = (token: string, lastActiveAt: string) =>
      fetch(`${baseUrl}/channels/${channelId}/activity`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ lastActiveAt }),
      });
    const staleToken = await joinB("stale-member1");
    await postActivity(staleToken, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const freshToken = await joinB("fresh-member");
    await postActivity(freshToken, new Date().toISOString());

    const res = await a.client.callTool({ name: "list_members", arguments: {} });
    const body = JSON.parse(unwrapQuote(textOf(res))) as {
      members: Array<{ memberName: string; activity?: string }>;
    };
    const byName = new Map(body.members.map((m) => [m.memberName, m]));
    expect(byName.get("stale-member1")?.activity).toBe("idle");
    expect(byName.get("fresh-member")?.activity).toBe("recently-active");
    // a's own list_members call IS activity (resolved the channel) → fresh bucket
    expect(byName.get("a")?.activity).toBe("recently-active");
  });

  test("set_subscription persists filters per channel", async () => {
    const a = await makeAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    const filters = [{ kinds: ["decision", "contract"] }, { topic: "auth" }];
    const res = await a.client.callTool({ name: "set_subscription", arguments: { filters } });
    expect(JSON.parse(textOf(res))).toEqual({ ok: true, filters, channelId });
    expect(a.store.getKv(`subscription:${channelId}`)).toBe(JSON.stringify(filters));
  });

  test("channelId defaults to the most recently used channel", async () => {
    const a = await makeAgent("a");
    const c1 = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const ch1 = c1.match(/channel_id=([a-z0-9]+)/)![1];
    const pw1 = c1.match(/password=([a-z0-9-]+)/)![1];
    const c2 = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const ch2 = c2.match(/channel_id=([a-z0-9]+)/)![1];
    expect(ch2).not.toBe(ch1);

    // no channelId → lands in ch2 (most recent), NOT ch1
    await a.client.callTool({
      name: "share_update",
      arguments: { statement: "routed to the most recent channel", kind: "progress", topic: "t" },
    });
    const b = await makeAgent("b");
    await b.client.callTool({ name: "join_channel", arguments: { channelId: ch1, password: pw1, memberName: "b" } });
    const body = JSON.parse(unwrapQuote(textOf(await b.client.callTool({ name: "fetch_updates", arguments: {} }))));
    expect(body.messages).toHaveLength(0);

    // explicit channelId still reaches the older channel
    await a.client.callTool({
      name: "share_update",
      arguments: { statement: "explicitly routed to channel one", kind: "progress", topic: "t", channelId: ch1 },
    });
    const body2 = JSON.parse(unwrapQuote(textOf(await b.client.callTool({ name: "fetch_updates", arguments: {} }))));
    expect(body2.messages).toHaveLength(1);
    expect(body2.messages[0].statement).toBe("explicitly routed to channel one");
  });
});

describe("session-token adoption on 409 (identity binding)", () => {
  let relay: RelayHandle;
  let baseUrl: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    relay = await startRelay({ port: 0 });
    baseUrl = `http://127.0.0.1:${relay.port}`;
  });

  afterAll(async () => {
    await relay.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function claimFor(statement: string, member: string): ClaimMessage {
    const r = validateClaim({
      statement,
      kind: "progress",
      topic: "t",
      provenance: { member, source: "agent" },
    });
    if (!r.ok) throw new Error(`test helper claim invalid: ${r.reason}`);
    return r.msg;
  }

  async function makeAgent(label: string): Promise<Agent> {
    const dir = mkdtempSync(join(tmpdir(), `scm-mcp-${label}-`));
    dirs.push(dir);
    const store = new Store(join(dir, "state.db"));
    const bridge = new RelayBridge({ baseUrl, store });
    const server = buildMcpServer({ store, bridge });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${label}`, version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, store };
  }

  test("re-join with the SAME memberName on 409 adopts the live session and works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scm-mcp-adopt-"));
    dirs.push(dir);
    const store = new Store(join(dir, "state.db"));
    const m1 = new RelayBridge({ baseUrl, store });
    const { channelId, password } = await m1.createChannel({ memberName: "alice" });

    // fresh instance over the SAME store, memory empty → restart simulation;
    // relay 409s (alice's token is live) → adoption must kick in
    const m2 = new RelayBridge({ baseUrl, store });
    await m2.join(channelId, password, "alice");
    const sent = await m2.send(claimFor("sent through the adopted session", "alice"), channelId);
    expect(sent.seq).toBeGreaterThan(0);
    expect(store.getChannelSecret(channelId)?.memberName).toBe("alice");
    store.close();
  });

  test("re-join with a DIFFERENT live memberName surfaces 409, local identity unchanged", async () => {
    // machine A: live session as alice; machine B: live session as bob
    const dirA = mkdtempSync(join(tmpdir(), "scm-mcp-adopt-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "scm-mcp-adopt-b-"));
    dirs.push(dirA, dirB);
    const storeA = new Store(join(dirA, "state.db"));
    const storeB = new Store(join(dirB, "state.db"));
    const mA = new RelayBridge({ baseUrl, store: storeA });
    const { channelId, password } = await mA.createChannel({ memberName: "alice" });
    const mB = new RelayBridge({ baseUrl, store: storeB });
    await mB.join(channelId, password, "bob");

    // restart simulation on machine A, but requesting bob's (live) name:
    // adoption must refuse (stored session is alice's) and the 409 surfaces
    const mA2 = new RelayBridge({ baseUrl, store: storeA });
    expect(mA2.join(channelId, password, "bob")).rejects.toThrow("member name already taken");
    expect(storeA.getChannelSecret(channelId)?.memberName).toBe("alice");
    storeA.close();
    storeB.close();
  });

  test("join_channel tool: mismatched live memberName → readable error, identity preserved", async () => {
    const a = await makeAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    const password = created.match(/password=([a-z0-9-]+)/)![1];
    const b = await makeAgent("b");
    await b.client.callTool({ name: "join_channel", arguments: { channelId, password, memberName: "b" } });

    // second server over agent A's store, requesting the live "b" name
    const server2 = buildMcpServer({ store: a.store, bridge: new RelayBridge({ baseUrl, store: a.store }) });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test-a2", version: "0.0.0" });
    await Promise.all([client2.connect(ct2), server2.connect(st2)]);
    const res = await client2.callTool({
      name: "join_channel",
      arguments: { channelId, password, memberName: "b" },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("member name already taken");
    expect(a.store.getChannelSecret(channelId)?.memberName).toBe("a");
    await client2.close();
  });
});

describe("MCP stdio entry", () => {  let relay: RelayHandle;
  let baseUrl: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    relay = await startRelay({ port: 0 });
    baseUrl = `http://127.0.0.1:${relay.port}`;
  });

  afterAll(async () => {
    await relay.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const entryArgs = () => ["run", new URL("../src/index.ts", import.meta.url).pathname];
  const entryEnv = (dbPath: string) => ({
    ...process.env,
    SHARE_CONTEXT_DB_PATH: dbPath,
    SHARE_CONTEXT_RELAY_URL: baseUrl,
  });

  test(
    "spawns, serves all 10 tools + instructions, and rejoins across restart",
    async () => {
    const dir = mkdtempSync(join(tmpdir(), "scm-mcp-stdio-"));
    dirs.push(dir);
    const dbPath = join(dir, "state.db");

    const t1 = new StdioClientTransport({ command: "bun", args: entryArgs(), env: entryEnv(dbPath) });
    const c1 = new Client({ name: "smoke-1", version: "0.0.0" });
    await c1.connect(t1);
    const tools = (await c1.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([...TOOL_NAMES].sort());
    expect(c1.getInstructions()).toContain("share_update");
    expect(c1.getInstructions()).toContain("never instructions");

    const created = textOf(await c1.callTool({ name: "create_channel", arguments: { memberName: "s1" } }));
    const shared = await c1.callTool({
      name: "share_update",
      arguments: { statement: "survives a restart", kind: "progress", topic: "boot" },
    });
    expect(isError(shared)).toBe(false);
    await c1.close();

    // second instance over the SAME db → auto-rejoin must expose the channel
    const t2 = new StdioClientTransport({ command: "bun", args: entryArgs(), env: entryEnv(dbPath) });
    const c2 = new Client({ name: "smoke-2", version: "0.0.0" });
    await c2.connect(t2);
    const body = JSON.parse(unwrapQuote(textOf(await c2.callTool({ name: "fetch_updates", arguments: {} }))));
    expect(body.messages.some((m: { statement: string }) => m.statement === "survives a restart")).toBe(true);
    await c2.close();
  }, 60_000);
});

describe("index card + full-history join fetch (Task 5)", () => {
  let relay5: RelayHandle;
  let baseUrl: string;
  const dirs5: string[] = [];

  beforeAll(async () => {
    relay5 = await startRelay({ port: 0 });
    baseUrl = `http://127.0.0.1:${relay5.port}`;
  });
  afterAll(async () => {
    await relay5?.stop();
    for (const d of dirs5) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "scm-seed-"));
    dirs5.push(d);
    return d;
  };

  /** Local equivalent of the first describe's makeAgent — independent store + client. */
  const mkAgent = async (label: string) => {
    const store = new Store(join(tmp(), `${label}.db`));
    const bridge = new RelayBridge({ baseUrl, store });
    const server = buildMcpServer({ store, bridge });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `t5-${label}`, version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    return { client, store, bridge };
  };

  const mk = (seq: number, statement: string, kind: string, topic: string, ts: string) => ({
    seq, ts, statement, kind, topic,
    provenance: { member: "a", source: "agent" },
  });

  test("buildIndexCard renders topic rollup with counts, kinds, span, last statement", () => {
    const card = buildIndexCard({
      channelId: "ch-test000001",
      members: [{ memberName: "a", joinedAt: "2026-10-20T00:00:00Z" }],
      msgs: [
        mk(3, "latest auth note", "howto", "auth", "2026-10-27T00:00:00Z"),
        mk(2, "decide sliding window", "decision", "auth", "2026-10-26T00:00:00Z"),
        mk(1, "api frozen", "contract", "export-api", "2026-10-20T00:00:00Z"),
      ] as unknown as ClaimMessage[],
      pendingQuestions: 2,
    });
    expect(card).toContain("auth");
    expect(card).toContain("export-api");
    expect(card).toContain("decision×1");
    expect(card).toContain("2");
    expect(card).toContain("latest auth note");
    expect(card).toContain("questionsTotal\":2");
  });

  test("buildIndexCard: empty channel renders the none-yet copy", () => {
    const card = buildIndexCard({
      channelId: "ch-test000002",
      members: [],
      msgs: [],
      pendingQuestions: 0,
    });
    expect(card).toContain("none yet");
  });

  test("join fetches FULL history (beyond the old 200 window) into the local cache", async () => {
    // seed 250 messages through a dedicated bridge (one channel)
    const seedStore = new Store(join(tmp(), "seed.db"));
    const seeder = new RelayBridge({ baseUrl, store: seedStore });
    const { channelId, password } = await seeder.createChannel({ memberName: "seed" });
    for (let i = 1; i <= 250; i++) {
      await seeder.send({ statement: `seed message ${i}`, kind: "progress", topic: i <= 200 ? "early" : "late", seq: null, ts: new Date().toISOString(), provenance: { member: "seed", source: "agent" } }, channelId);
    }
    // a fresh MCP agent joins → must cache ALL 250 (relay page cap is 200)
    const a = await mkAgent("fulljoiner");
    const card = textOf(await a.client.callTool({ name: "join_channel", arguments: { channelId, password, memberName: "fulljoiner" } }));
    expect(a.store.searchCache(channelId, "").length).toBe(250);
    const body = JSON.parse(unwrapQuote(card));
    const topics = body.topics as Array<{ topic: string; count: number }>;
    expect(topics.find((t) => t.topic === "early")?.count).toBe(200);
    expect(topics.find((t) => t.topic === "late")?.count).toBe(50);
  }, 60_000);

  test("re-join does not move the cursor backward or duplicate cached rows", async () => {
    const seedStore = new Store(join(tmp(), "seed.db"));    const seeder = new RelayBridge({ baseUrl, store: seedStore });
    const { channelId, password } = await seeder.createChannel({ memberName: "seed2" });
    await seeder.send({ statement: "only message", kind: "progress", topic: "t", seq: null, ts: new Date().toISOString(), provenance: { member: "seed2", source: "agent" } }, channelId);
    const a = await mkAgent("rejoiner");
    await a.client.callTool({ name: "join_channel", arguments: { channelId, password, memberName: "rejoiner" } });
    const cursorAfterFirst = a.store.getCursor(channelId);
    // re-join with fresh messages posted between joins
    await seeder.send({ statement: "second message", kind: "progress", topic: "t", seq: null, ts: new Date().toISOString(), provenance: { member: "seed2", source: "agent" } }, channelId);
    await a.client.callTool({ name: "join_channel", arguments: { channelId, password, memberName: "rejoiner" } });
    expect(a.store.getCursor(channelId)).toBeGreaterThanOrEqual(cursorAfterFirst);
    expect(a.store.searchCache(channelId, "").length).toBe(2); // no duplicates
  }, 60_000);
});

describe("structural digest posting (Task 7)", () => {
  let relay7: RelayHandle;
  let baseUrl: string;
  const dirs7: string[] = [];
  let prevThreshold: string | undefined;

  beforeAll(async () => {
    relay7 = await startRelay({ port: 0, maxMessages: 3 });
    baseUrl = `http://127.0.0.1:${relay7.port}`;
    prevThreshold = process.env.SHARE_CONTEXT_DIGEST_MIN_MSGS;
    process.env.SHARE_CONTEXT_DIGEST_MIN_MSGS = "3"; // force the watermark with a tiny fixture
  });
  afterAll(async () => {
    if (prevThreshold === undefined) delete process.env.SHARE_CONTEXT_DIGEST_MIN_MSGS;
    else process.env.SHARE_CONTEXT_DIGEST_MIN_MSGS = prevThreshold;
    await relay7?.stop();
    for (const d of dirs7) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "scm-digest-"));
    dirs7.push(d);
    return d;
  };
  const mkAgent = async (label: string) => {
    const store = new Store(join(tmp(), `${label}.db`));
    const bridge = new RelayBridge({ baseUrl, store });
    const server = buildMcpServer({ store, bridge });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `t7-${label}`, version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    return { client, store, bridge };
  };

  test("evicted range with decisions → one digest posted, no duplicate on refetch", async () => {
    const a = await mkAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    // 6 messages: 1 decision + 5 progress; relay retains only the last 3 →
    // minSeq advances to 4, so the evicted-but-cached pending range (0,3]
    // holds 3 messages = the env-tuned watermark. The member caches as it
    // goes (fetch between sends) — a digest can only cover what this server
    // has actually seen.
    await a.client.callTool({ name: "share_update", arguments: { statement: "decided: WAL mode for cache", kind: "decision", topic: "db" } });
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    for (let i = 1; i <= 5; i++) {
      await a.client.callTool({ name: "share_update", arguments: { statement: `chatter ${i}`, kind: "progress", topic: "db" } });
      if (i <= 2) await a.client.callTool({ name: "fetch_updates", arguments: {} });
    }
    // fetch → gap kv advances → watermark (3 evicted-but-cached ≥ 3) → digest
    // posted; the digest lands on the relay AFTER this poll, so the NEXT
    // fetch is what caches it locally.
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    const digests = a.store.searchCache(channelId, "digest").filter((m) => m.kind === "digest");
    expect(digests.length).toBe(1);
    expect(digests[0].statement).toContain("decided: WAL mode for cache");
    expect((digests[0].scope as Record<string, string>).covers).toBe("1-3");
    // refetch → no duplicate (digested watermark + covers dedupe)
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    expect(a.store.searchCache(channelId, "digest").filter((m) => m.kind === "digest").length).toBe(1);
  }, 60_000);

  test("evicted range with zero high-value messages → no digest posted", async () => {
    const a = await mkAgent("b");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "b" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    for (let i = 1; i <= 4; i++) {
      await a.client.callTool({ name: "share_update", arguments: { statement: `chatter ${i}`, kind: "progress", topic: "t" } });
    }
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    expect(a.store.searchCache(channelId, "digest").filter((m) => m.kind === "digest").length).toBe(0);
  }, 60_000);

  test("second member does not re-post a digest covering the same range (covers dedupe)", async () => {
    const a = await mkAgent("dd-a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "dd-a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    const password = created.match(/password=([a-z0-9-]+)/)![1];
    // both members cache the range that will be evicted
    await a.client.callTool({ name: "share_update", arguments: { statement: "decided: dedupe probe", kind: "decision", topic: "t" } });
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    const b = await mkAgent("dd-b");
    await b.client.callTool({ name: "join_channel", arguments: { channelId, password, memberName: "dd-b" } });
    await b.client.callTool({ name: "fetch_updates", arguments: {} });
    // seqs 2-3 sent and fetched by BOTH (before eviction)
    for (let i = 1; i <= 2; i++) {
      await a.client.callTool({ name: "share_update", arguments: { statement: `chatter ${i}`, kind: "progress", topic: "t" } });
    }
    await b.client.callTool({ name: "fetch_updates", arguments: {} });
    // eviction pushes minSeq to 4; both hold seqs 1-3 cached
    for (let i = 3; i <= 5; i++) {
      await a.client.callTool({ name: "share_update", arguments: { statement: `chatter ${i}`, kind: "progress", topic: "t" } });
    }
    // A crosses the watermark first → posts the digest
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    // B's next fetch sees A's digest (poll caches it) → must NOT re-post;
    // one more fetch pulls back anything B itself posted, so the count is honest
    await b.client.callTool({ name: "fetch_updates", arguments: {} });
    await b.client.callTool({ name: "fetch_updates", arguments: {} });
    const bDigests = b.store.searchCache(channelId, "digest").filter((m) => m.kind === "digest");
    expect(bDigests.length).toBe(1);
    expect(bDigests[0].statement).toContain("decided: dedupe probe");
  }, 60_000);

  test("digest covers only the span its author actually cached (no overstatement)", async () => {
    const a = await mkAgent("cv-a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "cv-a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    const password = created.match(/password=([a-z0-9-]+)/)![1];
    // a sends 5 with the decision at seq 3, fetches → relay evicts 1-2, retains 3-5
    await a.client.callTool({ name: "share_update", arguments: { statement: "chatter 1", kind: "progress", topic: "t" } });
    await a.client.callTool({ name: "share_update", arguments: { statement: "chatter 2", kind: "progress", topic: "t" } });
    await a.client.callTool({ name: "share_update", arguments: { statement: "decided: covers probe", kind: "decision", topic: "t" } });
    await a.client.callTool({ name: "share_update", arguments: { statement: "chatter 4", kind: "progress", topic: "t" } });
    await a.client.callTool({ name: "share_update", arguments: { statement: "chatter 5", kind: "progress", topic: "t" } });
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    // late joiner caches ONLY 3-5 (1-2 already evicted relay-side)
    const late = await mkAgent("cv-late");
    await late.client.callTool({ name: "join_channel", arguments: { channelId, password, memberName: "cv-late" } });
    // eviction advances to minSeq 6 → late's pending evicted-but-cached = 3-5
    for (let i = 6; i <= 8; i++) {
      await a.client.callTool({ name: "share_update", arguments: { statement: `chatter ${i}`, kind: "progress", topic: "t" } });
    }
    await late.client.callTool({ name: "fetch_updates", arguments: {} });
    await late.client.callTool({ name: "fetch_updates", arguments: {} });
    const digests = late.store.searchCache(channelId, "digest").filter((m) => m.kind === "digest");
    expect(digests.length).toBe(1);
    // covers 3-5 (what the author saw), NOT 1-5 (what the range implies)
    expect((digests[0].scope as Record<string, string>).covers).toBe("3-5");
  }, 60_000);

  test("partial coverage: only the un-digested subrange is posted (per-range dirty set)", async () => {
    const a = await mkAgent("pc-a");
    const created = textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "pc-a" } }));
    const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
    // decision at seq 3; digested ledger says 0-2 was already covered →
    // only seq 3 (the decision) may be digested
    await a.client.callTool({ name: "share_update", arguments: { statement: "chatter 1", kind: "progress", topic: "t" } });
    await a.client.callTool({ name: "share_update", arguments: { statement: "chatter 2", kind: "progress", topic: "t" } });
    await a.client.callTool({ name: "share_update", arguments: { statement: "decided: late decision", kind: "decision", topic: "t" } });
    await a.client.callTool({ name: "fetch_updates", arguments: {} });
    process.env.SHARE_CONTEXT_DIGEST_MIN_MSGS = "1";
    a.store.setKv(`digested:${channelId}`, JSON.stringify([[0, 2]]));
    a.store.setKv(`gap:${channelId}`, "4");
    let postedCovers: string | undefined;
    const self = a.bridge as unknown as {
      send: (msg: { scope?: Record<string, string> }, ch?: string) => Promise<{ seq: number; deduped: boolean }>;
    };
    const original = self.send.bind(a.bridge);
    self.send = async (msg) => {
      postedCovers = (msg as { scope?: Record<string, string> }).scope?.covers;
      return original(msg, channelId);
    };
    try {
      await a.client.callTool({ name: "fetch_updates", arguments: {} });
      // ledger now covers 0-3 (old 0-2 + new 3-3), merged
      expect(a.store.getKv(`digested:${channelId}`)).toBe(JSON.stringify([[0, 3]]));
    } finally {
      self.send = original;
      delete process.env.SHARE_CONTEXT_DIGEST_MIN_MSGS;
    }
    expect(postedCovers).toBe("3-3");
  }, 60_000);
});
