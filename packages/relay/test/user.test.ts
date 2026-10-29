/**
 * User / Consumer formal model (governance v2 §3):
 * - users are relay-global identities (token binds to the USER, not channel)
 * - consumers (agent processes/sessions) auto-register under a user on any
 *   valid-token write
 * - one user, many consumers, many channel memberships
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { deriveChannelKey, hmacProof } from "@share-context-mcp/protocol";
import { startRelay, type RelayHandle } from "../src/index";

const PASSWORD = "test-password-1234";

let dir: string;
let relay: RelayHandle;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), "relay-user-"));
  relay = await startRelay({ port: 0, dbPath: joinPath(dir, "relay.db") });
  base = `http://127.0.0.1:${relay.port}`;
});

afterAll(async () => {
  await relay?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function verifyKeyB64Of(password: string, channelId: string): string {
  const key = deriveChannelKey(password, channelId);
  return createHmac("sha256", Buffer.from(key)).update("verify", "utf8").digest("base64");
}

function proofOf(verifyKeyB64: string, nonceB64: string): string {
  return hmacProof(new Uint8Array(Buffer.from(verifyKeyB64, "base64")), nonceB64);
}

async function postJson(
  path: string,
  body: unknown,
  opts: { token?: string; consumer?: string; ip?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.consumer ? { "x-scm-consumer": opts.consumer } : {}),
      ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function createChannel(memberName?: string): Promise<{ channelId: string; token: string }> {
  const channelId = randomBytes(8).toString("hex");
  const key = deriveChannelKey(PASSWORD, channelId);
  const verifyKeyB64 = createHmac("sha256", Buffer.from(key)).update("verify", "utf8").digest("base64");
  const created = await postJson("/channels", { channelId, memberName: memberName ?? "founder", verifyKeyB64 });
  expect(created.status).toBe(200);
  // creator claims the reserved name via a normal credential join
  const j = await join(channelId, memberName ?? "founder", PASSWORD);
  return { channelId, token: (j.body as { token: string }).token };
}

async function join(
  channelId: string,
  memberName: string,
  password: string,
  opts: {
    consumerId?: string;
    user?: { name?: string; osType?: string; osVersion?: string; mcpVersion?: string };
    agentType?: string;
    agentVersion?: string;
    sessionId?: string;
    ip?: string;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ch = await postJson(`/channels/${channelId}/challenge`, { memberName });
  if (ch.status !== 200) return { status: ch.status, body: ch.body };
  const { nonceB64 } = ch.body as { nonceB64: string };
  const proof = proofOf(verifyKeyB64Of(password, channelId), nonceB64);
  return postJson(`/channels/${channelId}/join`, {
    memberName,
    proof,
    consumerId: opts.consumerId ?? "s/default0001",
    ...(opts.user ? { user: opts.user } : {}),
    ...(opts.agentType ? { agentType: opts.agentType } : {}),
    ...(opts.agentVersion ? { agentVersion: opts.agentVersion } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  }, { ip: opts.ip });
}

async function getMe(channelId: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/channels/${channelId}/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("user / consumer model", () => {
  let seq = 0;
  const uniq = (prefix: string): string => `${prefix}-${(seq++).toString(36)}${randomBytes(3).toString("hex")}`;

  test("join with a user spec creates a user, binds the token, registers the consumer", async () => {
    const { channelId } = await createChannel(uniq("founder"));
    const machineName = uniq("dev-machine-1");
    const j = await join(channelId, "alice", PASSWORD, {
      consumerId: "s/ses_alice001",
      user: { name: machineName, osType: "darwin", osVersion: "26.0", mcpVersion: "0.1.0" },
      agentType: "opencode",
      agentVersion: "2.0.32",
      sessionId: "ses_alice",
      ip: "10.1.2.3",
    });
    expect(j.status).toBe(200);
    const userId = (j.body as { userId: string }).userId;
    expect(typeof userId).toBe("string");
    expect(userId).toMatch(/^u/);

    // query the ledger with ALICE's own token (the creator is a separate user)
    const me = await getMe(channelId, (j.body as { token: string }).token);
    expect(me.status).toBe(200);
    const user = me.body.user as Record<string, unknown>;
    expect(user.userId).toBe(userId);
    expect(user.name).toBe(machineName);
    expect(user.osType).toBe("darwin");
    expect(user.osVersion).toBe("26.0");
    expect(user.mcpVersion).toBe("0.1.0");
    expect(user.ip).toBe("10.1.2.3");
    expect(typeof user.registeredAt).toBe("string");
    expect(typeof user.lastActiveAt).toBe("string");

    const consumers = me.body.consumers as Array<Record<string, unknown>>;
    expect(consumers).toHaveLength(1);
    expect(consumers[0].consumerId).toBe("s/ses_alice001");
    expect(consumers[0].agentType).toBe("opencode");
    expect(consumers[0].agentVersion).toBe("2.0.32");
    expect(consumers[0].sessionId).toBe("ses_alice");
  });

  test("a second member from the same machine reuses the same user row", async () => {
    const { channelId } = await createChannel(uniq("founder"));
    const machine = uniq("shared-machine");
    const alice = await join(channelId, "alice", PASSWORD, {
      consumerId: "s/ses_alice001",
      user: { name: machine, osType: "darwin" },
    });
    const bob = await join(channelId, "bob", PASSWORD, {
      consumerId: "s/ses_bob00001",
      user: { name: machine, osType: "darwin" },
    });
    expect(bob.status).toBe(200);
    expect((bob.body as { userId: string }).userId).toBe((alice.body as { userId: string }).userId);
  });

  test("consumer auto-registers under the user on any valid-token write", async () => {
    const { channelId } = await createChannel(uniq("founder"));
    const j = await join(channelId, "alice", PASSWORD, {
      consumerId: "s/ses_first001",
      user: { name: uniq("auto-reg-machine") },
    });
    // a NEW consumer id (a fresh agent session on the same machine) performs
    // a write carrying only the token + x-scm-consumer — it must appear in
    // the user's consumer ledger without an explicit registration call
    await postJson(`/channels/${channelId}/activity`, { lastActiveAt: new Date().toISOString() }, {
      token: (j.body as { token: string }).token,
      consumer: "s/ses_second02",
    });
    const me = await getMe(channelId, (j.body as { token: string }).token);
    const consumers = me.body.consumers as Array<Record<string, unknown>>;
    const ids = consumers.map((c) => c.consumerId).sort();
    expect(ids).toEqual(["s/ses_first001", "s/ses_second02"]);
  });

  test("multi-consumer per user: explicit registration of extra agent sessions", async () => {
    const { channelId } = await createChannel(uniq("founder"));
    const j = await join(channelId, "alice", PASSWORD, {
      consumerId: "s/ses_main0001",
      user: { name: uniq("multi-consumer") },
      agentType: "opencode",
    });
    const aliceToken = (j.body as { token: string }).token;
    const reg = await postJson(`/channels/${channelId}/consumers`, { consumerId: "s/ses_side0002", agentType: "pi", agentVersion: "0.9", sessionId: "ses_side" }, { token: aliceToken });
    expect(reg.status).toBe(200);
    await postJson(`/channels/${channelId}/consumers`, { consumerId: "s/ses_third0003" }, { token: aliceToken });
    const me = await getMe(channelId, aliceToken);
    const consumers = me.body.consumers as Array<Record<string, unknown>>;
    expect(consumers).toHaveLength(3);
    const byId = new Map(consumers.map((c) => [c.consumerId, c]));
    expect((byId.get("s/ses_main0001") as { agentType?: string }).agentType).toBe("opencode");
    expect((byId.get("s/ses_side0002") as { agentType?: string }).agentType).toBe("pi");
    expect((byId.get("s/ses_side0002") as { sessionId?: string }).sessionId).toBe("ses_side");
    expect((byId.get("s/ses_third0003") as { agentType?: string }).agentType).toBeUndefined();
  });

  test("legacy join without a user spec still works (user falls back to memberName)", async () => {
    const { channelId, token } = await createChannel(uniq("founder"));
    const j = await join(channelId, "carol", PASSWORD, { consumerId: "s/legacy00001" });
    expect(j.status).toBe(200);
    expect(typeof (j.body as { userId: string }).userId).toBe("string");
    const me = await getMe(channelId, token);
    expect(me.status).toBe(200);
    expect(((me.body.user as Record<string, unknown>).name as string).length).toBeGreaterThan(0);
  });

  test("token refresh rebinds the user token; the old one stops authenticating", async () => {
    const { channelId, token } = await createChannel(uniq("founder"));
    const refreshed = await postJson(`/channels/${channelId}/token-refresh`, {}, { token, consumer: "s/refresh0001" });
    expect(refreshed.status).toBe(200);
    const newToken = (refreshed.body as { token: string }).token;
    const me = await getMe(channelId, newToken);
    expect(me.status).toBe(200);
    const old = await getMe(channelId, token);
    expect(old.status).toBe(401);
  });
});
