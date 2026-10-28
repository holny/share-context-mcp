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
import { applyKick } from "../src/routes";

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
  consumerId = "s/testcons01",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ch = await postJson(`/channels/${channelId}/challenge`, { memberName });
  if (ch.status !== 200) return { status: ch.status, body: (await ch.json()) as Record<string, unknown> };
  const { nonceB64 } = (await ch.json()) as { nonceB64: string };
  const proof = proofOf(verifyKeyB64Of(password, channelId), nonceB64);
  const res = await postJson(`/channels/${channelId}/join`, { memberName, proof, consumerId });
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

  test("activity receipts: auth required, timestamp stored, exposed via meta", async () => {    const channelId = randomBytes(8).toString("hex");
    const created = await postJson("/channels", {
      channelId,
      memberName: "alice",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
    });
    expect(created.status).toBe(200);
    const joined = await joinChannel(channelId, "alice", PASSWORD);
    expect(joined.status).toBe(200);
    const token = (joined.body as { token: string }).token;

    // no token → 401
    const noAuth = await postJson(`/channels/${channelId}/activity`, { lastActiveAt: new Date().toISOString() });
    expect(noAuth.status).toBe(401);

    // invalid timestamp → 400 (blind relay hygiene: validate metadata shape)
    const bad = await postJson(`/channels/${channelId}/activity`, { lastActiveAt: "not-a-date" }, token);
    expect(bad.status).toBe(400);

    // authenticated → 200, stored, exposed via meta
    const ts = new Date().toISOString();
    const act = await postJson(`/channels/${channelId}/activity`, { lastActiveAt: ts }, token);
    expect(act.status).toBe(200);
    const meta = await fetch(`${base}/channels/${channelId}/meta`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await meta.json()) as { members: Array<{ memberName: string; lastActiveAt: string | null }> };
    const me = body.members.find((m) => m.memberName === "alice");
    expect(me?.lastActiveAt).toBe(ts);
  });

  test("retention: count bound evicts oldest seqs as a contiguous prefix, minSeq reported", async () => {
    const r2 = await startRelay({ port: 0, maxMessages: 8 });
    try {
      const base2 = `http://127.0.0.1:${r2.port}`;
      const post = (p: string, b: unknown, t?: string) =>
        fetch(`${base2}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
          body: JSON.stringify(b),
        });
      const channelId = randomBytes(8).toString("hex");
      const created = await post("/channels", { channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
      expect(created.status).toBe(200);
      const ch = await post(`/channels/${channelId}/challenge`, { memberName: "alice" });
      const { nonceB64 } = (await ch.json()) as { nonceB64: string };
      const proof = proofOf(verifyKeyB64Of(PASSWORD, channelId), nonceB64);
      const joined = await post(`/channels/${channelId}/join`, { memberName: "alice", proof, consumerId: "s/test0001" });
      const token = ((await joined.json()) as { token: string }).token;

      // send 10 claims → count bound (8) evicts seqs 1-2
      for (let i = 1; i <= 10; i++) {
        const key = deriveChannelKey(PASSWORD, channelId);
        const validated = validateClaim({ ts: new Date().toISOString(), statement: `m${i}`, kind: "progress", topic: "t", provenance: { member: "alice", source: "agent" } });
        if (!validated.ok) throw new Error(validated.reason);
        const env = seal(validated.msg, key);
        const res = await post(`/channels/${channelId}/messages`, { nonce: env.nonce, ciphertext: env.ciphertext, idemKey: validated.msg.idempotencyKey }, token);
        expect(res.status).toBe(200);
      }
      const list = await fetch(`${base2}/channels/${channelId}/messages?since=0`, { headers: { authorization: `Bearer ${token}` } });
      const body = (await list.json()) as { messages: Array<{ seq: number }>; nextSeq: number; minSeq: number };
      // contiguous prefix from minSeq — no holes (Review Focus 3)
      expect(body.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
      expect(body.minSeq).toBe(3);
      expect(body.nextSeq).toBe(11);
    } finally {
      await r2.stop();
    }
  });

  test("retention: TTL bound evicts everything, minSeq = nextSeq (consumer cursor must jump)", async () => {
    const r3 = await startRelay({ port: 0, maxAgeDays: 0 });
    try {
      const base3 = `http://127.0.0.1:${r3.port}`;
      const post = (p: string, b: unknown, t?: string) =>
        fetch(`${base3}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
          body: JSON.stringify(b),
        });
      const channelId = randomBytes(8).toString("hex");
      await post("/channels", { channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
      const ch = await post(`/channels/${channelId}/challenge`, { memberName: "alice" });
      const { nonceB64 } = (await ch.json()) as { nonceB64: string };
      const proof = proofOf(verifyKeyB64Of(PASSWORD, channelId), nonceB64);
      const joined = await post(`/channels/${channelId}/join`, { memberName: "alice", proof, consumerId: "s/test0001" });
      const token = ((await joined.json()) as { token: string }).token;
      for (let i = 1; i <= 2; i++) {
        const key = deriveChannelKey(PASSWORD, channelId);
        const validated = validateClaim({ ts: new Date().toISOString(), statement: `m${i}`, kind: "progress", topic: "t", provenance: { member: "alice", source: "agent" } });
        if (!validated.ok) throw new Error(validated.reason);
        const env = seal(validated.msg, key);
        await post(`/channels/${channelId}/messages`, { nonce: env.nonce, ciphertext: env.ciphertext, idemKey: validated.msg.idempotencyKey }, token);
      }
      const list = await fetch(`${base3}/channels/${channelId}/messages?since=0`, { headers: { authorization: `Bearer ${token}` } });
      const body = (await list.json()) as { messages: unknown[]; nextSeq: number; minSeq: number };
      expect(body.messages).toEqual([]);
      expect(body.minSeq).toBe(body.nextSeq);
    } finally {
      await r3.stop();
    }
  });

  test("TTL sweep evicts on IDLE channels (no inserts) — count bound alone can't do it", async () => {
    const r4 = await startRelay({ port: 0, maxAgeDays: 0, sweepIntervalMs: 30 });
    try {
      const base4 = `http://127.0.0.1:${r4.port}`;
      const post = (p: string, b: unknown, t?: string) =>
        fetch(`${base4}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
          body: JSON.stringify(b),
        });
      const channelId = randomBytes(8).toString("hex");
      await post("/channels", { channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
      const ch = await post(`/channels/${channelId}/challenge`, { memberName: "alice" });
      const { nonceB64 } = (await ch.json()) as { nonceB64: string };
      const proof = proofOf(verifyKeyB64Of(PASSWORD, channelId), nonceB64);
      const joined = await post(`/channels/${channelId}/join`, { memberName: "alice", proof, consumerId: "s/test0001" });
      const token = ((await joined.json()) as { token: string }).token;
      for (let i = 1; i <= 2; i++) {
        const key = deriveChannelKey(PASSWORD, channelId);
        const validated = validateClaim({ ts: new Date().toISOString(), statement: `m${i}`, kind: "progress", topic: "t", provenance: { member: "alice", source: "agent" } });
        if (!validated.ok) throw new Error(validated.reason);
        const env = seal(validated.msg, key);
        await post(`/channels/${channelId}/messages`, { nonce: env.nonce, ciphertext: env.ciphertext, idemKey: validated.msg.idempotencyKey }, token);
      }
      // no further writes: only the periodic sweep can enforce the TTL bound
      await Bun.sleep(250);
      const list = await fetch(`${base4}/channels/${channelId}/messages?since=0`, { headers: { authorization: `Bearer ${token}` } });
      const body = (await list.json()) as { messages: unknown[]; nextSeq: number; minSeq: number };
      expect(body.messages).toEqual([]);
      expect(body.minSeq).toBe(body.nextSeq);
    } finally {
      await r4.stop();
    }
  });

  test("admission modes: public direct join, invite code gating, set-admission, directory", async () => {
    // --- public channel: direct join, no challenge/proof ---
    const pubId = randomBytes(8).toString("hex");
    const created = await postJson("/channels", {
      channelId: pubId,
      memberName: "alice",
      admissionMode: "public",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, pubId),
    });
    expect(created.status).toBe(200);
    const pubJoin = await postJson(`/channels/${pubId}/join`, { memberName: "bob", consumerId: "s/inv000001" });
    expect(pubJoin.status).toBe(200);
    const bobToken = ((await pubJoin.json()) as { token: string }).token;

    // --- invite channel: password-proof-only join rejected, code required ---
    const invId = randomBytes(8).toString("hex");
    await postJson("/channels", {
      channelId: invId,
      memberName: "carol",
      admissionMode: "invite",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, invId),
    });
    const carolJoined = await joinChannel(invId, "carol", PASSWORD);
    // creator join still works with password proof (admission credential)
    expect(carolJoined.status).toBe(200);
    const invToken = (carolJoined.body as { token: string }).token;
    // a second member WITHOUT a registered invite code → 403
    const ch2 = await postJson(`/channels/${invId}/challenge`, { memberName: "dave" });
    const dnonce = ((await ch2.json()) as { nonceB64: string }).nonceB64;
    const dproof = proofOf(verifyKeyB64Of(PASSWORD, invId), dnonce);
    const daveJoin = await postJson(`/channels/${invId}/join`, { memberName: "dave", proof: dproof, consumerId: "s/dave00001", inviteCodeId: "" });
    expect(daveJoin.status).toBe(403);

    // register an invite code for dave (owner carol), then join succeeds
    const reg = await postJson(`/channels/${invId}/invite-codes`, { codeId: "code-dave01", expiresAt: Date.now() + 86_400_000 }, invToken);
    expect(reg.status).toBe(200);
    const daveJoin2 = await postJson(`/channels/${invId}/join`, { memberName: "dave", proof: dproof, consumerId: "s/dave00001", inviteCodeId: "code-dave01" });
    expect(daveJoin2.status).toBe(200);
    const daveToken = ((await daveJoin2.json()) as { token: string }).token;
    // single-use: the same code cannot admit anyone else
    const eveJoin = await postJson(`/channels/${invId}/join`, { memberName: "eve", proof: dproof, consumerId: "s/eve000001", inviteCodeId: "code-dave01" });
    expect(eveJoin.status).toBe(403);

    // --- set-admission: manager-only, audit-logged ---
    const nonManager = await postJson(`/channels/${invId}/set-admission`, { mode: "public" }, daveToken);
    expect(nonManager.status).toBe(403);
    const switchRes = await postJson(`/channels/${invId}/set-admission`, { mode: "public" }, invToken);
    expect(switchRes.status).toBe(200);
    const meta = (await (await fetch(`${base}/channels/${invId}/meta`, { headers: { authorization: `Bearer ${invToken}` } })).json()) as { admissionMode: string };
    expect(meta.admissionMode).toBe("public");
    // switch took effect: a brand-new member joins WITHOUT any proof
    const eveJoin2 = await postJson(`/channels/${invId}/join`, { memberName: "eve2", consumerId: "s/eve000002" });
    expect(eveJoin2.status).toBe(200);

    // --- directory: public listed; password/invite hidden unless contact set ---
    const dir = (await (await fetch(`${base}/directory?q=`)).json()) as { channels: Array<{ channelId: string; contactInfo?: string }> };
    const pubEntry = dir.channels.find((c) => c.channelId === pubId);
    expect(pubEntry).toBeDefined();
    // password channel without contact info → hidden
    const pwdId = randomBytes(8).toString("hex");
    await postJson("/channels", { channelId: pwdId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, pwdId) });
    const dir2 = (await (await fetch(`${base}/directory?q=`)).json()) as { channels: Array<{ channelId: string }> };
    expect(dir2.channels.find((c) => c.channelId === pwdId)).toBeUndefined();
  });

  test("governance schema: creator/manager recorded at create+join, exposed via meta; audit rows written", async () => {    const channelId = randomBytes(8).toString("hex");
    const created = await postJson("/channels", {
      channelId,
      memberName: "alice",
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
    });
    expect(created.status).toBe(200);
    // reserved creator is already creator/manager before joining
    const meta0 = await fetch(`${base}/channels/${channelId}/meta`, { method: "GET" }).then((r) => r.status);
    // meta requires auth — join first
    const joined = await joinChannel(channelId, "alice", PASSWORD);
    expect(joined.status).toBe(200);
    const token = (joined.body as { token: string }).token;
    const meta = await fetch(`${base}/channels/${channelId}/meta`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await meta.json()) as {
      creatorMember: string;
      managerMember: string;
      admissionMode: string;
      invitePolicy: string;
    };
    expect(body.creatorMember).toBe("alice");
    expect(body.managerMember).toBe("alice");
    expect(body.admissionMode).toBe("password");
    expect(body.invitePolicy).toBe("everyone");
    // audit rows: channel.created + member.joined
    const rows = relay.db
      .prepare("SELECT action, actor, result FROM audit_log WHERE channel_id = ? ORDER BY ts")
      .all(channelId) as Array<{ action: string; actor: string; result: string }>;
    expect(rows.map((r) => r.action)).toContain("channel.created");
    expect(rows.map((r) => r.action)).toContain("member.joined");
  });

  test("tokens: consumer binding, ban enforcement, refresh rotation", async () => {
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", { channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
    const joined = await joinChannel(channelId, "alice", PASSWORD, "s/cons0001");
    const token = (joined.body as { token: string }).token;
    const authed = (p: string, t = token, consumer?: string) =>
      fetch(`${base}${p}`, { headers: { authorization: `Bearer ${t}`, ...(consumer ? { "x-scm-consumer": consumer } : {}) } });

    // additional consumer registration via /consumers
    const reg = await postJson(`/channels/${channelId}/consumers`, { consumerId: "s/cons0002" }, token);
    expect(reg.status).toBe(200);
    // both consumers valid
    expect((await authed(`/channels/${channelId}/meta`, token, "s/cons0001")).status).toBe(200);
    expect((await authed(`/channels/${channelId}/meta`, token, "s/cons0002")).status).toBe(200);
    // unregistered consumer on a token-authed request → auto-registered
    // (valid member token IS the membership proof); ban enforcement is the
    // separate banned-consumer check
    expect((await authed(`/channels/${channelId}/meta`, token, "s/unknown99")).status).toBe(200);

    // ban enforcement: member.status = banned → 403 even with valid token
    relay.db.prepare("UPDATE members SET status = 'banned' WHERE channel_id = ? AND name = 'alice'").run(channelId);
    expect((await authed(`/channels/${channelId}/meta`)).status).toBe(403);
    relay.db.prepare("UPDATE members SET status = 'active' WHERE channel_id = ? AND name = 'alice'").run(channelId);

    // consumer-level ban: banned consumer id rejected, other consumer still fine
    relay.db
      .prepare("UPDATE member_bans SET consumer_ids = ? WHERE channel_id = ? AND name = 'alice'")
      .run(JSON.stringify(["s/cons0001"]), channelId);
    relay.db
      .prepare("INSERT OR IGNORE INTO member_bans(channel_id, name, consumer_ids, banned_at, banned_by) VALUES (?, 'alice', ?, ?, 'manager')")
      .run(channelId, JSON.stringify(["s/cons0001"]), new Date().toISOString());
    expect((await authed(`/channels/${channelId}/meta`, token, "s/cons0001")).status).toBe(403);
    expect((await authed(`/channels/${channelId}/meta`, token, "s/cons0002")).status).toBe(200);
    relay.db.prepare("DELETE FROM member_bans WHERE channel_id = ? AND name = 'alice'").run(channelId);

    // token refresh: new token works, old revoked
    const ref = await postJson(`/channels/${channelId}/token-refresh`, {}, token);
    expect(ref.status).toBe(200);
    const newToken = ((await ref.json()) as { token: string }).token;
    expect(newToken).not.toBe(token);
    expect((await authed(`/channels/${channelId}/meta`, newToken)).status).toBe(200);
    expect((await authed(`/channels/${channelId}/meta`, token)).status).toBe(401);
  });

  test("token TTL: null = never expires (default)", async () => {
    const r2 = await startRelay({ port: 0, tokenTtlMs: null, dbPath: join(dir, "ttl.db") });
    try {
      const b2 = `http://127.0.0.1:${r2.port}`;
      const channelId = randomBytes(8).toString("hex");
      const created = await fetch(`${b2}/channels`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) }),
      });
      expect(created.status).toBe(200);
      const ch = await fetch(`${b2}/channels/${channelId}/challenge`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberName: "alice" }),
      });
      const { nonceB64 } = (await ch.json()) as { nonceB64: string };
      const proof = proofOf(verifyKeyB64Of(PASSWORD, channelId), nonceB64);
      const joined = await fetch(`${b2}/channels/${channelId}/join`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberName: "alice", proof, consumerId: "s/ttl00001" }),
      });
      const token = ((await joined.json()) as { token: string }).token;
      // simulate the passage of time: token_expires_at must be NULL (no expiry)
      const row = r2.db.prepare("SELECT token_expires_at FROM members WHERE channel_id = ? AND name = 'alice'").get(channelId) as { token_expires_at: number | null };
      expect(row.token_expires_at).toBeNull();
      const meta = await fetch(`${b2}/channels/${channelId}/meta`, { headers: { authorization: `Bearer ${token}` } });
      expect(meta.status).toBe(200);
    } finally {
      await r2.stop();
    }
  });

  test("roles: rotate is manager-only; leave/transfer/dissolve per succession table", async () => {    // manager (alice) + regular members bob, carol
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", { channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
    const aliceTok = ((await joinChannel(channelId, "alice", PASSWORD, "s/alice0001")).body as { token: string }).token;
    const bobTok = ((await joinChannel(channelId, "bob", PASSWORD, "s/bob000001")).body as { token: string }).token;
    const carolTok = ((await joinChannel(channelId, "carol", PASSWORD, "s/carol0001")).body as { token: string }).token;
    const meta = async (t: string) =>
      (await (await fetch(`${base}/channels/${channelId}/meta`, { headers: { authorization: `Bearer ${t}` } })).json()) as {
        creatorMember: string;
        managerMember: string;
      };

    // (a) rotate by non-manager → 403
    const vk = verifyKeyB64Of("new-pw-1", channelId);
    const badRotate = await postJson(`/channels/${channelId}/rotate`, { verifyKeyB64: vk }, bobTok);
    expect(badRotate.status).toBe(403);

    // (c) creator leaves WITHOUT transferTo → default rule: most messages in
    // trailing 7d excluding creator (bob: 2, carol: 1) → bob becomes creator
    await sendClaim(aliceTok, channelId, "a1", { topic: "t" });
    await sendClaim(bobTok, channelId, "b1", { topic: "t" });
    await sendClaim(bobTok, channelId, "b2", { topic: "t" });
    await sendClaim(carolTok, channelId, "c1", { topic: "t" });
    const leaveCreator = await postJson(`/channels/${channelId}/leave`, {}, aliceTok);
    expect(leaveCreator.status).toBe(200);
    expect((await meta(bobTok)).creatorMember).toBe("bob");
    expect((await meta(bobTok)).managerMember).toBe("bob");

    // manager (bob, now also creator) leaves WITH transferTo → carol takes both
    const leaveManager = await postJson(`/channels/${channelId}/leave`, { transferTo: "carol" }, bobTok);
    expect(leaveManager.status).toBe(200);
    const m3 = await meta(carolTok);
    expect(m3.creatorMember).toBe("carol");
    expect(m3.managerMember).toBe("carol");

    // last member (carol) leaves → dissolve: credential join → 404
    const lastLeave = await postJson(`/channels/${channelId}/leave`, {}, carolTok);
    expect(lastLeave.status).toBe(200);
    const ch = await postJson(`/channels/${channelId}/challenge`, { memberName: "carol" });
    expect(ch.status).toBe(404);
  });

  test("manager (not creator) leaves → manager reverts to creator", async () => {
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", { channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
    const aliceTok = ((await joinChannel(channelId, "alice", PASSWORD, "s/alice1001")).body as { token: string }).token;
    const bobTok = ((await joinChannel(channelId, "bob", PASSWORD, "s/bob100001")).body as { token: string }).token;
    const meta = async (t: string) =>
      (await (await fetch(`${base}/channels/${channelId}/meta`, { headers: { authorization: `Bearer ${t}` } })).json()) as {
        creatorMember: string;
        managerMember: string;
      };
    // explicit manager transfer (creator op)
    const xfer = await postJson(`/channels/${channelId}/transfer`, { to: "bob" }, aliceTok);
    expect(xfer.status).toBe(200);
    expect((await meta(bobTok)).managerMember).toBe("bob");
    // bob (manager, not creator) leaves → manager reverts to alice
    const leaveRes = await postJson(`/channels/${channelId}/leave`, {}, bobTok);
    expect(leaveRes.status).toBe(200);
    expect((await meta(aliceTok)).managerMember).toBe("alice");
  });

  test("applyKick: bans, credential invalidation, succession per spec table", async () => {
    // fixture helper: fresh channel + members
    const setup = async (names: string[]) => {
      const channelId = randomBytes(8).toString("hex");
      await postJson("/channels", { channelId, memberName: names[0], verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
      const tokens: Record<string, string> = {};
      for (const n of names) {
        const j = await joinChannel(channelId, n, PASSWORD, `s/${n.padEnd(8, "0")}`);
        tokens[n] = ((j.body as { token: string }).token);
      }
      return { channelId, tokens };
    };

    // (a) regular member kicked: banned + consumers blacklisted + credential invalidated
    {
      const { channelId, tokens } = await setup(["alice", "dave"]);
      const daveConsumer = "s/dave0000";
      await applyKick(relay.db, channelId, "dave", "alice");
      // dave's token dead → 403 banned
      const meta = await fetch(`${base}/channels/${channelId}/meta`, { headers: { authorization: `Bearer ${tokens.dave}` } });
      expect(meta.status).toBe(403);
      // rejoin under a NEW name but the SAME consumer id → rejected
      const ch = await postJson(`/channels/${channelId}/challenge`, { memberName: "dave2" });
      const nonce = ((await ch.json()) as { nonceB64: string }).nonceB64;
      const rejoin = await postJson(`/channels/${channelId}/join`, {
        memberName: "dave2",
        proof: proofOf(verifyKeyB64Of(PASSWORD, channelId), nonce),
        consumerId: daveConsumer,
      });
      expect(rejoin.status).toBe(403);
      // admission credential invalidated: old-credential challenge fails explicitly
      const chAlice = await postJson(`/channels/${channelId}/challenge`, { memberName: "newmember" });
      const nonce2 = ((await chAlice.json()) as { nonceB64: string }).nonceB64;
      const rejoin2 = await postJson(`/channels/${channelId}/join`, {
        memberName: "newmember",
        proof: proofOf(verifyKeyB64Of(PASSWORD, channelId), nonce2),
        consumerId: "s/newmem01",
      });
      expect(rejoin2.status).toBe(403);
      expect(((await rejoin2.json()) as { error: string }).error).toContain("admission credential revoked");
    }

    // (b) manager kicked (manager ≠ creator) → manager = initiator
    {
      const channelId2 = randomBytes(8).toString("hex");
      await postJson("/channels", { channelId: channelId2, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId2) });
      const aTok = ((await joinChannel(channelId2, "alice", PASSWORD, "s/a1000001")).body as { token: string }).token;
      await joinChannel(channelId2, "bob", PASSWORD, "s/b1000001");
      await joinChannel(channelId2, "carol", PASSWORD, "s/c1000001");
      // transfer manager to carol (manager ≠ creator ≠ initiator)
      await postJson(`/channels/${channelId2}/transfer`, { to: "carol" }, aTok);
      // kick bob (regular member) → no succession
      const res = applyKick(relay.db, channelId2, "bob", "alice");
      expect(res.succession).toBeNull();
      const m = relay.db.prepare("SELECT manager_member FROM channels WHERE id = ?").get(channelId2) as { manager_member: string };
      expect(m.manager_member).toBe("carol");
      // now kick the MANAGER (carol) — initiator alice → manager = alice
      const res2 = applyKick(relay.db, channelId2, "carol", "alice");
      expect(res2.succession).toBe("manager");
      const m2 = relay.db.prepare("SELECT manager_member FROM channels WHERE id = ?").get(channelId2) as { manager_member: string };
      expect(m2.manager_member).toBe("alice");
    }

    // (c) creator kicked → creator = initiator; (d) creator-as-manager kicked → initiator takes both
    {
      const { channelId } = await setup(["alice", "bob", "carol"]);
      // creator alice kicked by bob → creator = bob (initiator)
      const r1 = applyKick(relay.db, channelId, "alice", "bob");
      expect(r1.succession).toBe("creator");
      const m1 = relay.db.prepare("SELECT creator_member, manager_member FROM channels WHERE id = ?").get(channelId) as { creator_member: string; manager_member: string };
      expect(m1.creator_member).toBe("bob");
      // (d) bob (now manager AND creator via (c)) kicked by carol → both roles to carol (initiator)
      const r2 = applyKick(relay.db, channelId, "bob", "carol");
      expect(r2.succession).toBe("creator");
      const m2 = relay.db.prepare("SELECT creator_member, manager_member FROM channels WHERE id = ?").get(channelId) as { creator_member: string; manager_member: string };
      expect(m2.creator_member).toBe("carol");
      expect(m2.manager_member).toBe("carol");
    }
  });

  test("bans listing + unban: manager/creator gated; consumer ids surfaced; invite-rights toggle", async () => {
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", { channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
    const alice = (await joinChannel(channelId, "alice", PASSWORD, "s/alice0001")).body as { token: string };
    await joinChannel(channelId, "bob", PASSWORD, "s/bob000001");
    // ban bob directly (as via a settled vote)
    relay.db.prepare(
      "INSERT INTO member_bans(channel_id, name, consumer_ids, banned_at, banned_by) VALUES (?, 'bob', ?, ?, 'vote:alice')",
    ).run(channelId, JSON.stringify(["s/bob000001"]), new Date().toISOString());
    relay.db.prepare("UPDATE members SET status = 'banned' WHERE channel_id = ? AND name = 'bob'").run(channelId);

    // listing: any member can view (governance transparency)
    const bans = (await (await fetch(`${base}/channels/${channelId}/bans`, { headers: { authorization: `Bearer ${alice.token}` } })).json()) as {
      bans: Array<{ name: string; consumer_ids: string; banned_by: string }>;
    };
    expect(bans.bans).toHaveLength(1);
    expect(bans.bans[0].name).toBe("bob");
    expect(bans.bans[0].consumer_ids).toContain("s/bob000001");
    // non-manager member join (carol) — carol cannot unban
    const carol = (await joinChannel(channelId, "carol", PASSWORD, "s/carol0001")).body as { token: string };
    const badUnban = await postJson(`/channels/${channelId}/unban`, { name: "bob" }, carol.token);
    expect(badUnban.status).toBe(403);
    // unban by manager (alice) → bob can re-join (consumer id no longer banned)
    const unban = await postJson(`/channels/${channelId}/unban`, { name: "bob" }, alice.token);
    expect(unban.status).toBe(200);
    const rebob = await joinChannel(channelId, "bob", PASSWORD, "s/bob000002");
    expect(rebob.status).toBe(200);

    // invite-rights toggle: manager strips carol's right, restores it
    const rights = await postJson(`/channels/${channelId}/invite-rights`, { name: "carol", canInvite: 0 }, alice.token);
    expect(rights.status).toBe(200);
    const carolRow = relay.db.prepare("SELECT can_invite FROM members WHERE channel_id = ? AND name = 'carol'").get(channelId) as { can_invite: number };
    expect(carolRow.can_invite).toBe(0);
    const restore = await postJson(`/channels/${channelId}/invite-rights`, { name: "carol", canInvite: 1 }, alice.token);
    expect(restore.status).toBe(200);
    const restoredRow = relay.db.prepare("SELECT can_invite FROM members WHERE channel_id = ? AND name = 'carol'").get(channelId) as { can_invite: number };
    expect(restoredRow.can_invite).toBe(1);
  });

  test("member-stats: totals, share, per-day array from the sender column", async () => {
    const channelId = randomBytes(8).toString("hex");
    await postJson("/channels", { channelId, memberName: "alice", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
    const alice = (await joinChannel(channelId, "alice", PASSWORD, "s/alice0001")).body as { token: string };
    for (let i = 1; i <= 3; i++) await sendClaim(alice.token, channelId, `msg ${i}`, { topic: "t" });
    const stats = (await (
      await fetch(`${base}/channels/${channelId}/member-stats?name=alice`, { headers: { authorization: `Bearer ${alice.token}` } })
    ).json()) as { member: string; totalMessages: number; totalShare: number; perDay: Array<{ count: number }> };
    expect(stats.member).toBe("alice");
    expect(stats.totalMessages).toBe(3);
    expect(stats.totalShare).toBe(100);
    expect(stats.perDay).toHaveLength(7);
    expect(stats.perDay[6].count).toBe(3);
  });
});
