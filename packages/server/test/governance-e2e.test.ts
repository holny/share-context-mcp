/**
 * Governance v2 end-to-end: the full lifecycle across MCP tools + relay —
 * create → join (card) → message → vote → kick enforcement → encrypted
 * toggle → join blob → leave/dissolve. Real relay, two MCP server instances
 * over in-memory transport (the production tool path), raw HTTP for the
 * CLI-tier ops (vote start, dissolve) that deliberately have no MCP surface.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodeBlobEnvelope, parseBlobEnvelope, mintAdmissionCredential } from "@share-context-mcp/protocol";
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

describe("e2e governance: vote → kick → encryption → blob → dissolve", () => {
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
    const dir = mkdtempSync(join(tmpdir(), `scm-gov-${label}-`));
    dirs.push(dir);
    const store = new Store(join(dir, "state.db"));
    const bridge = new RelayBridge({ baseUrl, store });
    // distinct consumer id per agent: every bridge in THIS process would
    // otherwise share p/<pid> — a kicked member's observed consumer ids
    // would then consumer-ban every other agent in the test
    bridge.setConsumer(`s/gov-${label}`);
    const server = buildMcpServer({ store, bridge });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `gov-${label}`, version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    return { client, store, bridge };
  };

  test("full governance lifecycle", async () => {
    // ---- 1. alice creates; bob + carol + dave join ----
    const alice = await mkAgent("alice");
    const created = textOf(await alice.client.callTool({ name: "create_channel",
      arguments: { memberName: "alice", name: "governed" } }));
    const channelId = JSON.parse(created).channel_id;
    const password = JSON.parse(created).password;

    const mkJoin = async (label: string, memberName: string) => {
      const agent = await mkAgent(label);
      await agent.client.callTool({ name: "join_channel",
      arguments: { channel_id: channelId, password, member_name: memberName } });
      return agent;
    };
    const bob = await mkJoin("bob", "bob");
    const carol = await mkJoin("carol", "carol");
    const dave = await mkJoin("dave", "dave"); // the future kick target

    // ---- 2. channel_info: roles + membership from every angle ----
    const info = JSON.parse(unwrapQuote(textOf(await alice.client.callTool({ name: "channel_info", arguments: { channel_id: channelId } })))) as {
      creatorMember: string;
      managerMember: string;
      members: Array<{ memberName: string; role: string }>;
      openVotes: unknown[];
    };
    expect(info.creatorMember).toBe("alice");
    expect(info.managerMember).toBe("alice");
    expect(info.members.find((m) => m.memberName === "alice")?.role).toBe("creator");
    expect(info.openVotes).toEqual([]);

    // ---- 3. message round trip ----
    await alice.client.callTool({ name: "send_message", arguments: { channel_id: channelId, statement: "decided: governance rules apply", kind: "decision", topic: "gov"} });
    const fetched = JSON.parse(unwrapQuote(textOf(await bob.client.callTool({ name: "fetch_messages", arguments: { channel_id: channelId } })))) as {
      messages: Array<{ statement: string }>;
    };
    expect(fetched.messages.some((m) => m.statement.includes("governance rules apply"))).toBe(true);

    // ---- 4. kick vote opened via the CLI tier (raw HTTP; no MCP surface) ----
    const aliceToken = { token: alice.store.getMembershipToken(channelId, "alice")! };
    const voteRes = await fetch(`${baseUrl}/channels/${channelId}/votes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceToken.token}` },
      body: JSON.stringify({ type: "kick", target: "dave", reason: "spam" }),
    });
    expect(voteRes.status).toBe(200);
    const { voteId } = (await voteRes.json()) as { voteId: string };

    // ---- 5. agents PERCEIVE the open vote in fetch_messages, then cast ----
    const withVote = JSON.parse(unwrapQuote(textOf(await bob.client.callTool({ name: "fetch_messages", arguments: { channel_id: channelId } })))) as {
      openVotes: Array<{ id: string; type: string; target: string }>;
    };
    expect(withVote.openVotes.some((v) => v.id === voteId && v.target === "dave")).toBe(true);

    const carolToken = { token: carol.store.getMembershipToken(channelId, "carol")! };
    // dave (the target) cannot vote
    const daveBallot = await fetch(`${baseUrl}/channels/${channelId}/votes/${voteId}/ballot`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${dave.store.getMembershipToken(channelId, "dave")!}` },
      body: JSON.stringify({ choice: "no" }),
    });
    expect(daveBallot.status).toBe(403);
    await bob.client.callTool({ name: "cast_vote", arguments: { channel_id: channelId, vote_id: voteId, choice: "yes" } });
    // carol votes via raw HTTP (vote weight math is relay-side either way)
    await fetch(`${baseUrl}/channels/${channelId}/votes/${voteId}/ballot`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${carolToken.token}` },
      body: JSON.stringify({ choice: "yes" }),
    });
    // early resolution: eligible = 4 - 1 target = 3; regular pass = yes > 1/2 of cast
    // after 2 yes + 0 no of 3 eligible: yes(2) > (2+1)/2 → passes immediately

    // ---- 6. kick enforcement: dave's token answers 403 banned ----
    const daveToken = dave.store.getMembershipToken(channelId, "dave")!;
    const daveMeta = await fetch(`${baseUrl}/channels/${channelId}/meta`, {
      headers: { authorization: `Bearer ${daveToken}` },
    });
    expect(daveMeta.status).toBe(403);
    const daveMsgs = await fetch(`${baseUrl}/channels/${channelId}/messages?since=0`, {
      headers: { authorization: `Bearer ${daveToken}` },
    });
    expect(daveMsgs.status).toBe(403);

    // the vote history records the kick
    const votes = await (await fetch(`${baseUrl}/channels/${channelId}/votes`, {
      headers: { authorization: `Bearer ${aliceToken.token}` },
    })).json() as { history: Array<{ id: string; status: string }> };
    expect(votes.history.find((v) => v.id === voteId)?.status).toBe("passed");

    // ---- 7. credential rotation (kick revoked the password-tier credential) ----
    // A kick in password mode kills the admission credential: the manager
    // re-mints it (`rotate --mode access` — same message key, new wrapping)
    // before onboarding anyone new.
    const { credential: newCredential, verifyKeyB64 } = mintAdmissionCredential(alice.bridge.channelKey(channelId));
    const setCred = await fetch(`${baseUrl}/channels/${channelId}/set-credential`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceToken.token}` },
      body: JSON.stringify({ verifyKeyB64 }),
    });
    expect(setCred.status).toBe(200);
    alice.store.upsertChannel({ channelId, password: newCredential, memberName: "alice", epoch: 1 });

    // ---- 8. encrypted toggle: manager encrypts; a fresh joiner can't read ----
    await alice.bridge.setEncryption(channelId, true);
    await alice.client.callTool({ name: "send_message", arguments: { channel_id: channelId, statement: "sealed plan v1", kind: "decision", topic: "secret"} });

    const erin = await mkAgent("erin");
    await erin.client.callTool({ name: "join_channel",
      arguments: { channel_id: channelId, password: newCredential, member_name: "erin" } });
    await erin.client.callTool({ name: "fetch_messages", arguments: { channel_id: channelId } }); // drain join window
    await alice.client.callTool({ name: "send_message", arguments: { channel_id: channelId, statement: "sealed plan v2", kind: "decision", topic: "secret"} });
    const erinFetch = JSON.parse(unwrapQuote(textOf(await erin.client.callTool({ name: "fetch_messages", arguments: { channel_id: channelId } })))) as {
      encryptedCount: number;
      encryptedNote?: string;
      messages: Array<{ statement: string }>;
    };
    expect(erinFetch.encryptedCount).toBe(1);
    expect(erinFetch.encryptedNote).toContain("alice"); // manager holds the keys
    expect(erinFetch.messages).toHaveLength(0);

    // owner shares the v1 key blob → erin tops up and can read
    const v1Blob = JSON.parse(textOf(await alice.client.callTool({ name: "generate_share_blob", arguments: { channel_id: channelId } })));
    expect(parseBlobEnvelope(v1Blob.blob).type).toBe("join_key");
    const v1TopUp = await erin.client.callTool({ name: "join_channel", arguments: { blob: v1Blob.blob, member_name: "erin" } });
    expect(isError(v1TopUp)).toBe(false);
    expect(erin.store.messageKey(channelId, 1)).not.toBeNull();

    // ---- 9. join_from_blob: a new agent joins from one pasted string ----
    const blob = encodeBlobEnvelope({
      type: "join_password",
      payload: { relayUrl: baseUrl, channelId, password: newCredential, channelName: "governed", admissionMode: "password" },
    });
    const frank = await mkAgent("frank");
    const card = textOf(await frank.client.callTool({ name: "join_channel", arguments: { blob, member_name: "frank" } }));
    expect(card).toContain(channelId);
    expect(card).toContain("governed");

    // ---- 9. list + leave; dissolution when the last member leaves ----
    const listing = JSON.parse(unwrapQuote(textOf(await frank.client.callTool({ name: "list_channels",
      arguments: {} })))) as {
      channels: Array<{ channelId: string; memberName?: string }>;
    };
    expect(listing.channels).toHaveLength(1);
    expect(listing.channels[0].memberName).toBe("frank");

    // ---- 10. key rotation loop (spec §3.3): rotate → stale 409 → blob top-up → resume ----
    const before = alice.store.messageKey(channelId, 1)!;
    const newVersion = await alice.bridge.rotateKey(channelId);
    expect(newVersion).toBe(2);
    // erin still holds only v1 → the relay rejects her send with an actionable notice
    const stale = await erin.client.callTool({ name: "send_message", arguments: { channel_id: channelId, statement: "stale key send", kind: "progress", topic: "secret" } });
    expect(isError(stale)).toBe(true);
    expect(textOf(stale)).toContain("rotated");
    // fresh key-only blob from the owner → erin tops up without re-joining
    const keyBlob = JSON.parse(textOf(await alice.client.callTool({ name: "generate_share_blob", arguments: { channel_id: channelId } })));
    expect(parseBlobEnvelope(keyBlob.blob).type).toBe("join_key");
    const topUp = await erin.client.callTool({ name: "join_channel", arguments: { blob: keyBlob.blob, member_name: "erin" } });
    expect(isError(topUp)).toBe(false);
    expect(Buffer.from(erin.store.messageKey(channelId, 2)!).equals(alice.store.messageKey(channelId, 2)!)).toBe(true);
    expect(Buffer.from(alice.store.messageKey(channelId, 2)!).equals(before)).toBe(false); // genuinely a NEW key
    const resumed = await erin.client.callTool({ name: "send_message", arguments: { channel_id: channelId, statement: "resumed after rotation", kind: "progress", topic: "secret" } });
    expect(isError(resumed)).toBe(false);

    // everyone leaves — the LAST leave dissolves the channel
    for (const agent of [alice, bob, carol, erin, frank]) {
      const res = await agent.client.callTool({ name: "leave_channel", arguments: { channel_id: channelId } });
      expect(isError(res)).toBe(false);
    }
    const gone = await fetch(`${baseUrl}/channels/${channelId}/meta`, {
      headers: { authorization: `Bearer ${aliceToken.token}` },
    });
    expect(gone.status).toBe(404); // channel fully deleted at the relay
  }, 60_000);

  test("probation: non-invite joins land in the trial tier, invite joins skip it (spec §6)", async () => {
    const a = await mkAgent("prob-a");
    const created = JSON.parse(textOf(await a.client.callTool({
      name: "create_channel", arguments: { memberName: "a", name: "probationed", probationEnabled: true },
    })));
    const { channel_id, password } = created;
    const b = await mkAgent("prob-b");
    await b.client.callTool({ name: "join_channel", arguments: { channel_id, password, member_name: "b" } });
    const info = JSON.parse(unwrapQuote(textOf(await a.client.callTool({ name: "channel_info", arguments: { channel_id } })))) as {
      members: Array<{ memberName: string; role: string }>;
    };
    expect(info.members.find((m) => m.memberName === "b")?.role).toBe("trial");
    expect(info.members.find((m) => m.memberName === "a")?.role).toBe("creator");
  });

  test("vote survives target departure: pass bans the departed member at the gate (spec §7)", async () => {
    const a = await mkAgent("tv-a");
    const created = JSON.parse(textOf(await a.client.callTool({ name: "create_channel", arguments: { memberName: "a", name: "targetleaves" } })));
    const { channel_id, password } = created;
    const b = await mkAgent("tv-b");
    await b.client.callTool({ name: "join_channel", arguments: { channel_id, password, member_name: "b" } });
    const c = await mkAgent("tv-c");
    await c.client.callTool({ name: "join_channel", arguments: { channel_id, password, member_name: "c" } });
    // open the vote while b is still active, then b slips away mid-vote
    const opened = JSON.parse(unwrapQuote(textOf(await a.client.callTool({ name: "start_vote", arguments: { channel_id, type: "kick", target: "b", reason: "gone" } })))) as { voteId: string };
    await b.client.callTool({ name: "leave_channel", arguments: { channel_id } });
    await a.client.callTool({ name: "cast_vote", arguments: { channel_id, vote_id: opened.voteId, choice: "yes" } });
    await c.client.callTool({ name: "cast_vote", arguments: { channel_id, vote_id: opened.voteId, choice: "yes" } });
    // settled passed → ban row exists → b cannot re-join
    const rejoin = await b.client.callTool({ name: "join_channel", arguments: { channel_id, password, member_name: "b" } });
    expect(isError(rejoin)).toBe(true);
    const rejoinText = textOf(rejoin);
    expect(rejoinText).toMatch(/banned|403/);
  }, 60_000);
});
