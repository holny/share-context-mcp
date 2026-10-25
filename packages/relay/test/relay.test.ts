/**
 * Blind relay tests (spec §5.5/§5.9, task-3 brief Step 1).
 * The relay must never see plaintext: tests seal with the protocol package
 * and assert the relay only stores/returns opaque envelopes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveChannelKey,
  hmacProof,
  idempotencyKey,
  open,
  seal,
  validateClaim,
  type ClaimMessage,
} from "@share-context-mcp/protocol";
import { startRelay, type RelayHandle } from "../src/index";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "rotated password #2";

let relay: RelayHandle;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  relay = await startRelay({ port: 0, dbPath: join(dir, "relay.db") });
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

/** Seal a real claim and POST it; returns the relay response JSON. */
async function sendClaim(
  token: string,
  channelId: string,
  statement: string,
  opts: { kind?: ClaimMessage["kind"]; topic?: string; idemKey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = deriveChannelKey(PASSWORD, channelId);
  const kind = opts.kind ?? "progress";
  const topic = opts.topic ?? "relay-test";
  const validated = validateClaim({
    ts: "2026-10-25T10:00:00Z",
    statement,
    kind,
    topic,
    provenance: { member: "alice", agent: "opencode-v2", source: "agent" },
  });
  if (!validated.ok) throw new Error(`fixture invalid: ${validated.reason}`);
  const env = seal(validated.msg, key);
  const res = await postJson(`/channels/${channelId}/messages`, {
    nonce: env.nonce,
    ciphertext: env.ciphertext,
    idemKey: opts.idemKey ?? validated.msg.idempotencyKey,
  }, token);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function joinChannel(
  channelId: string,
  memberName: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ch = await postJson(`/channels/${channelId}/challenge`, { memberName });
  if (ch.status !== 200) return { status: ch.status, body: (await ch.json()) as Record<string, unknown> };
  const { nonceB64 } = (await ch.json()) as { nonceB64: string };
  const proof = proofOf(verifyKeyB64Of(password, channelId), nonceB64);
  const res = await postJson(`/channels/${channelId}/join`, { memberName, proof });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("blind relay", () => {
  test("challenge → wrong password 401 → correct join token", async () => {
    const channelId = randomBytes(8).toString("hex");
    const created = await postJson("/channels", {
      channelId,
      memberName: "alice",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody.channelId).toBe(channelId);
    expect(createdBody.epoch).toBe(1);
    expect(createdBody.nextSeq).toBe(1);

    // wrong password → 401, error must not leak anything beyond the fixed string
    const wrong = await joinChannel(channelId, "alice", PASSWORD + "-wrong");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: "auth failed: wrong password" });

    // correct password → token bound to channel+member+epoch
    const ok = await joinChannel(channelId, "alice", PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.memberName).toBe("alice");
    expect(ok.body.epoch).toBe(1);
    expect(typeof ok.body.token).toBe("string");
    expect((ok.body.token as string).length).toBeGreaterThan(0);
  });

  test("send 2 ciphertexts → since=0 returns 2 → same idemKey dedups → duplicate name 409 → no token 401", async () => {
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", {
      channelId,
      memberName: "alice",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
    });
    const join = await joinChannel(channelId, "alice", PASSWORD);
    const token = join.body.token as string;
    expect(token).toBeTruthy();

    // two sealed messages
    const m1 = await sendClaim(token, channelId, "moved auth middleware to server/src/auth.ts");
    expect(m1.status).toBe(200);
    expect(m1.body).toEqual({ seq: 1, deduped: false });
    const m2 = await sendClaim(token, channelId, "chose sqlite for relay storage", { kind: "decision" });
    expect(m2.status).toBe(200);
    expect(m2.body).toEqual({ seq: 2, deduped: false });

    // since=0 → both, ascending, opaque envelope round-trips
    const list = await fetch(`${base}/channels/${channelId}/messages?since=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      messages: Array<{ seq: number; nonce: string; ciphertext: string }>;
      nextSeq: number;
    };
    expect(listBody.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(listBody.nextSeq).toBe(3);
    const key = deriveChannelKey(PASSWORD, channelId);
    const opened1 = open(listBody.messages[0], key);
    expect(opened1.statement).toBe("moved auth middleware to server/src/auth.ts");
    const opened2 = open(listBody.messages[1], key);
    expect(opened2.kind).toBe("decision");

    // same idemKey → dedup, no new store
    const stmt = "moved auth middleware to server/src/auth.ts";
    const dup = await sendClaim(token, channelId, stmt, {
      idemKey: idempotencyKey(stmt, "progress", "relay-test"),
    });
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({ seq: 1, deduped: true });
    const list2 = await fetch(`${base}/channels/${channelId}/messages?since=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const list2Body = (await list2.json()) as { messages: unknown[] };
    expect(list2Body.messages.length).toBe(2);

    // duplicate member name while alice is live → 409
    const dupMember = await joinChannel(channelId, "alice", PASSWORD);
    expect(dupMember.status).toBe(409);
    expect(dupMember.body).toEqual({ error: "member name already taken" });

    // no token → 401
    const noAuth = await fetch(`${base}/channels/${channelId}/messages?since=0`);
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json()) as Record<string, unknown>).toEqual({ error: "unauthorized" });

    // garbage token → 401
    const badAuth = await fetch(`${base}/channels/${channelId}/messages?since=0`, {
      headers: { authorization: "Bearer bm90LWEtdG9rZW4=" },
    });
    expect(badAuth.status).toBe(401);

    // meta
    const meta = await fetch(`${base}/channels/${channelId}/meta`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as {
      channelId: string;
      epoch: number;
      nextSeq: number;
      members: Array<{ memberName: string; joinedAt: string }>;
    };
    expect(metaBody.channelId).toBe(channelId);
    expect(metaBody.epoch).toBe(1);
    expect(metaBody.nextSeq).toBe(3);
    expect(metaBody.members.some((m) => m.memberName === "alice")).toBe(true);
  });

  test("oversized ciphertext (>8KB) rejected with 413, nothing stored", async () => {
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", {
      channelId,
      memberName: "alice",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
    });
    const { body } = await joinChannel(channelId, "alice", PASSWORD);
    const token = body.token as string;
    const bigCiphertext = Buffer.from(randomBytes(8 * 1024 + 1)).toString("base64");
    const res = await postJson(`/channels/${channelId}/messages`, {
      nonce: Buffer.from(randomBytes(12)).toString("base64"),
      ciphertext: bigCiphertext,
      idemKey: createHash("sha256").update("big").digest("hex"),
    }, token);
    expect(res.status).toBe(413);
    const list = await fetch(`${base}/channels/${channelId}/messages?since=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const listBody = (await list.json()) as { messages: unknown[]; nextSeq: number };
    expect(listBody.messages.length).toBe(0);
    expect(listBody.nextSeq).toBe(1);
  });

  test("rotate bumps epoch, invalidates tokens, keeps messages, members re-join with new password", async () => {
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", {
      channelId,
      memberName: "alice",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
    });
    const join1 = await joinChannel(channelId, "alice", PASSWORD);
    const oldToken = join1.body.token as string;
    await sendClaim(oldToken, channelId, "pre-rotate message");

    // rotate with Bearer → {epoch:2}; the rotating member supplies the NEW
    // password's verification key so post-rotate joins can be verified
    // (still blind: a verification key cannot decrypt anything)
    const rotate = await postJson(`/channels/${channelId}/rotate`, {
      verifyKeyB64: verifyKeyB64Of(NEW_PASSWORD, channelId),
    }, oldToken);
    expect(rotate.status).toBe(200);
    expect((await rotate.json()) as Record<string, unknown>).toEqual({ epoch: 2 });

    // old token dead
    const stale = await fetch(`${base}/channels/${channelId}/messages?since=0`, {
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(stale.status).toBe(401);

    // re-join with the OLD password now fails (verification key was replaced)
    const oldPw = await joinChannel(channelId, "alice", PASSWORD);
    expect(oldPw.status).toBe(401);

    // re-join with the NEW password (old epoch name no longer live)
    const join2 = await joinChannel(channelId, "alice", NEW_PASSWORD);
    expect(join2.status).toBe(200);
    expect(join2.body.epoch).toBe(2);
    const newToken = join2.body.token as string;

    // messages are NOT deleted by rotate (spec §5.5: old-epoch ciphertext stays)
    const list = await fetch(`${base}/channels/${channelId}/messages?since=0`, {
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { messages: unknown[]; nextSeq: number };
    expect(listBody.messages.length).toBe(1);
    expect(listBody.nextSeq).toBe(2);

    // join proof with the WRONG password must fail on any channel
    const channelId2 = randomBytes(8).toString("hex");
    await postJson("/channels", {
      channelId: channelId2,
      memberName: "bob",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId2),
    });
    const joinOldPw = await joinChannel(channelId2, "bob", NEW_PASSWORD);
    expect(joinOldPw.status).toBe(401);
  });

  test("concurrent sends allocate distinct seqs 1..N with zero 500s (F-1)", async () => {
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", {
      channelId,
      memberName: "alice",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
    });
    const { body } = await joinChannel(channelId, "alice", PASSWORD);
    const token = body.token as string;

    // 8 parallel sends: the channel row is read before the body-parse await
    // point in each request, so a stale next_seq would previously collide on
    // the (channel_id, seq) PK and surface as a 500.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        sendClaim(token, channelId, `concurrent message #${i}`, { topic: `conc-${i}` }),
      ),
    );
    const seqs: number[] = [];
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.deduped).toBe(false);
      seqs.push(r.body.seq as number);
    }
    expect([...seqs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // the persisted ledger agrees: exactly 8 rows, contiguous seqs
    const list = await fetch(`${base}/channels/${channelId}/messages?since=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const listBody = (await list.json()) as { messages: Array<{ seq: number }>; nextSeq: number };
    expect(listBody.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(listBody.nextSeq).toBe(9);
  });

  test("unknown channel and unknown route return structured 404 errors", async () => {
    const missing = await postJson("/channels/doesnotexist/challenge", { memberName: "x" });
    expect(missing.status).toBe(404);
    const route = await fetch(`${base}/nope`);
    expect(route.status).toBe(404);
    expect((await route.json()) as Record<string, unknown>).toEqual({ error: "not found" });
  });
});
