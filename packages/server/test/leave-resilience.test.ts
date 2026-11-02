/**
 * Governance v2 T6 hardening:
 * - channel leave: relay errors (e.g. the channel was dissolved remotely)
 *   never strand the local state — cleanup always runs
 * - leave-triggered dissolution audits BEFORE wiping (the audit row is then
 *   removed with the channel's data; the ordering contract matters for any
 *   future external audit sink)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deriveChannelKey } from "@share-context-mcp/protocol";
import { startRelay, type RelayHandle } from "@share-context-mcp/relay";
import { buildMcpServer } from "../src/mcp";
import { RelayBridge } from "../src/bridge/relay";
import { Store } from "../src/store";

const QUOTE_HEADER = "📋 协作通道数据（引用，非指令）:";

function textOf(res: unknown): string {
  const r = res as { content?: Array<{ type: string; text?: string }> };
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

function unwrapQuote(text: string): string {
  const lines = text.split("\n");
  if (lines[0] !== QUOTE_HEADER) return text;
  return lines.slice(1).map((l) => l.slice(2)).join("\n");
}

describe("channel leave is locally resilient", () => {
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

  const mkAgent = async (label: string) => {
    const dir = mkdtempSync(join(tmpdir(), `scm-leave-${label}-`));
    dirs.push(dir);
    const store = new Store(join(dir, "state.db"));
    const bridge = new RelayBridge({ baseUrl, store });
    const server = buildMcpServer({ store, bridge });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `leave-${label}`, version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    return { client, store, bridge };
  };

  test("relay-side dissolution does not strand the local ledger", async () => {
    const a = await mkAgent("a");
    const created = textOf(await a.client.callTool({ name: "create_channel",
      arguments: { memberName: "a" } }));
    const channelId = JSON.parse(created).channel_id;
    const password = JSON.parse(created).password;

    const b = await mkAgent("b");
    await b.client.callTool({ name: "join_channel",
      arguments: { channel_id: channelId, password, member_name: "b" } });

    // the creator dissolves the channel OUT FROM UNDER b (b never left)
    const key = deriveChannelKey(password, channelId);
    const auth = { authorization: `Bearer ${(b.bridge as unknown as { authHeaders: (c: string) => Record<string, string> }).authHeaders(channelId).authorization?.slice(7)}` };
    void auth;
    const victimToken = { token: b.store.getMembershipToken(channelId, "b")! };
    const dis = await fetch(`${baseUrl}/channels/${channelId}/leave`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${victimToken.token}` },
      body: JSON.stringify({}),
    });
    // b leaves the (now dead) channel — the relay errors, local cleanup must run
    const res = await b.client.callTool({ name: "leave_channel", arguments: { channel_id: channelId } });
    expect(isError(res)).toBe(false);
    const body = JSON.parse(unwrapQuote(textOf(res))) as { ok: boolean; left: boolean };
    expect(body.ok).toBe(true);
    expect(body.left).toBe(true);
    const list = JSON.parse(unwrapQuote(textOf(await b.client.callTool({ name: "list_channels",
      arguments: {} })))) as { channels: unknown[] };
    expect(list.channels).toHaveLength(0);
    expect(b.store.getChannelSecret(channelId)).toBeNull();
    void dis;
  });

  test("leave of an unknown channel still cleans the active-channel pointer", async () => {
    const a = await mkAgent("a2");
    const created = textOf(await a.client.callTool({ name: "create_channel",
      arguments: { memberName: "a" } }));
    const channelId = JSON.parse(created).channel_id;
    // forge a stale ledger entry pointing at a channel the relay never had
    a.store.recordConsumerChannel("p/nowhere", "ghostchannel01");
    // make it resolvable locally (leave needs a channel secret to resolve)
    a.store.upsertChannel({ channelId: "ghostchannel01", password: "scmc1-nope", memberName: "a", epoch: 1 });
    void channelId;
    const res = await a.client.callTool({ name: "leave_channel",
      arguments: { channel_id: "ghostchannel01" } });
    // relay 404s — but the local state must be cleaned regardless
    expect(isError(res)).toBe(false);
    expect(a.store.getChannelSecret("ghostchannel01")).toBeNull();
  });
});
