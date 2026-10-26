/**
 * RelayBridge integration tests (task-4 brief Step 1): run a REAL relay on an
 * ephemeral port, drive two independent bridge instances (store A / store B)
 * through create → join → send → poll, plus failure paths (wrong password,
 * duplicate member, validation, rotate epoch transition).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type RelayHandle } from "@share-context-mcp/relay";
import { validateClaim, type ClaimMessage } from "@share-context-mcp/protocol";
import { RelayBridge } from "../src/bridge/relay";
import { Store } from "../src/store";

function claim(statement: string, member: string, extra: Record<string, unknown> = {}): ClaimMessage {
  const result = validateClaim({
    statement,
    kind: "progress",
    topic: "t1",
    provenance: { member, source: "agent" },
    ...extra,
  });
  if (!result.ok) throw new Error(`test helper claim invalid: ${result.reason}`);
  return result.msg;
}

describe("RelayBridge against a real relay", () => {
  let relay: RelayHandle;
  let baseUrl: string;
  let dirA: string;
  let dirB: string;
  let storeA: Store;
  let storeB: Store;
  let mbA: RelayBridge;
  let mbB: RelayBridge;

  beforeEach(async () => {
    relay = await startRelay({ port: 0 });
    baseUrl = `http://127.0.0.1:${relay.port}`;
    dirA = mkdtempSync(join(tmpdir(), "scm-mb-a-"));
    dirB = mkdtempSync(join(tmpdir(), "scm-mb-b-"));
    storeA = new Store(join(dirA, "state.db"));
    storeB = new Store(join(dirB, "state.db"));
    mbA = new RelayBridge({ baseUrl, store: storeA });
    mbB = new RelayBridge({ baseUrl, store: storeB });
  });

  afterEach(async () => {
    await relay.stop();
    storeA.close();
    storeB.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  test("create → join → send×3 → poll decrypts in seq order and advances cursor", async () => {
    const { channelId, password } = await mbA.createChannel({ memberName: "a" });
    expect(channelId).toMatch(/^[a-z0-9]{12}$/);
    // grouped human-copyable password: 20 chars of [a-z0-9] in 4-char groups
    expect(password).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){4}$/);
    expect(storeA.listChannels()).toContain(channelId);

    await mbB.join(channelId, password, "b");
    expect(storeB.listChannels()).toContain(channelId);

    for (const s of ["one", "two", "three"]) {
      const res = await mbA.send(claim(s, "a"));
      expect(res.deduped).toBe(false);
    }

    const got = await mbB.poll(channelId, 0);
    expect(got.messages.map((m) => m.statement)).toEqual(["one", "two", "three"]);
    expect(got.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(got.skipped).toBe(0);
    expect(storeB.getCursor(channelId)).toBe(3);

    // incremental poll from the cursor is empty
    expect(await mbB.poll(channelId, 3)).toEqual({ messages: [], skipped: 0 });
    // empty poll must not regress the cursor
    expect(storeB.getCursor(channelId)).toBe(3);
  });

  test("wrong-password join throws 'wrong password' and leaves no store residue", async () => {
    const { channelId } = await mbA.createChannel({ memberName: "a" });

    let caught: unknown;
    try {
      await mbB.join(channelId, "totally-wrong-pass", "b");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("wrong password");
    expect(storeB.listChannels()).not.toContain(channelId);
  });

  test("duplicate live member name is rejected with 409 and nothing persisted", async () => {
    const { channelId, password } = await mbA.createChannel({ memberName: "a" });
    await mbB.join(channelId, password, "b");

    const storeC = new Store(join(mkdtempSync(join(tmpdir(), "scm-mb-c-")), "state.db"));
    try {
      const mbC = new RelayBridge({ baseUrl, store: storeC });
      await expect(mbC.join(channelId, password, "b")).rejects.toThrow("member name already taken");
      expect(storeC.listChannels()).toEqual([]);
    } finally {
      storeC.close();
    }
  });

  test("send dedupes by idempotency key: same claim returns the original seq", async () => {
    await mbA.createChannel({ memberName: "a" });
    const first = await mbA.send(claim("identical payload", "a"));
    const second = await mbA.send(claim("identical payload", "a"));
    expect(first).toEqual({ seq: 1, deduped: false });
    expect(second).toEqual({ seq: 1, deduped: true });
  });

  test("send validates locally: invalid claim throws without touching the relay", async () => {
    const { channelId } = await mbA.createChannel({ memberName: "a" });
    const bad = { statement: "x", kind: "bogus-kind", topic: "t1", provenance: { member: "a", source: "agent" } } as unknown as ClaimMessage;
    await expect(mbA.send(bad)).rejects.toThrow("kind must be one of");
    const meta = await mbA.meta(channelId);
    expect(meta.nextSeq).toBe(1); // nothing reached the relay
  });

  test("send on an unknown channel throws and does not persist", async () => {
    await expect(mbA.send(claim("x", "a"), "nonexistent12")).rejects.toThrow("unknown channel");
  });

  test("meta lists members and nextSeq", async () => {
    const { channelId, password } = await mbA.createChannel({ memberName: "a" });
    await mbB.join(channelId, password, "b");
    await mbA.send(claim("hello", "a"));

    const meta = await mbB.meta(channelId);
    expect(meta.nextSeq).toBe(2);
    expect(meta.members.map((m) => m.memberName).sort()).toEqual(["a", "b"]);
  });

  test("rotate: old tokens die, re-join with the new password works, new epoch flows", async () => {
    const { channelId, password } = await mbA.createChannel({ memberName: "a" });
    await mbB.join(channelId, password, "b");
    await mbA.send(claim("before rotate", "a"));

    await mbA.rotate(channelId, "brand-new-password");

    // B's old token is dead (epoch bumped, all tokens invalidated)
    await expect(mbB.poll(channelId, 0)).rejects.toThrow("unauthorized");

    // B re-joins with the NEW password; store records the new password + epoch
    await mbB.join(channelId, "brand-new-password", "b");
    expect(storeB.getChannelSecret(channelId)?.epoch).toBe(2);

    // A must also re-join to speak in the new epoch (its token died too)
    await mbA.join(channelId, "brand-new-password", "a");
    await mbA.send(claim("after rotate", "a"));

    // B polls from 0: the old-epoch envelope (seq 1) decrypts via the RETAINED
    // epoch-1 key (spec §5.5: a local holder of the old password keeps reading
    // old-epoch ciphertext after re-joining with the new one); nothing skipped.
    const got = await mbB.poll(channelId, 0);
    expect(got.messages.map((m) => m.statement)).toEqual(["before rotate", "after rotate"]);
    expect(got.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(got.skipped).toBe(0);
    expect(storeB.getCursor(channelId)).toBe(2);
  });

  test("I-2: old-key retention — a member who re-joins with the new password keeps reading old-epoch messages", async () => {
    const { channelId, password } = await mbA.createChannel({ memberName: "a" });
    await mbB.join(channelId, password, "b");
    await mbA.send(claim("epoch 1 decision", "a"));
    await mbA.send(claim("epoch 1 howto", "a"));

    await mbA.rotate(channelId, "brand-new-password");
    // B re-joins: the new password overwrites the channel row, but the epoch-1
    // password must be retired into epoch_keys, not lost
    await mbB.join(channelId, "brand-new-password", "b");
    expect(storeB.getChannelSecret(channelId)?.password).toBe("brand-new-password");
    expect(storeB.epochPasswords(channelId).map((k) => k.epoch)).toEqual([1]);
    expect(storeB.epochPasswords(channelId)[0]?.password).toBe(password);

    await mbA.join(channelId, "brand-new-password", "a");
    await mbA.send(claim("epoch 2 begins", "a"));

    const got = await mbB.poll(channelId, 0);
    expect(got.messages.map((m) => m.statement)).toEqual([
      "epoch 1 decision",
      "epoch 1 howto",
      "epoch 2 begins",
    ]);
    expect(got.skipped).toBe(0);
    expect(storeB.getCursor(channelId)).toBe(3);
  });

  test("I-2: epoch key retention is bounded to the last 5 epochs", async () => {
    const { channelId } = await mbA.createChannel({ memberName: "a" });
    // rotate epochs 1→8; each retire step must prune keys older than epoch-5
    for (let epoch = 2; epoch <= 8; epoch++) {
      await mbA.rotate(channelId, `pw-epoch-${epoch}`);
      await mbA.join(channelId, `pw-epoch-${epoch}`, "a");
    }
    expect(storeA.getChannelSecret(channelId)?.epoch).toBe(8);
    expect(storeA.epochPasswords(channelId).map((k) => k.epoch)).toEqual([4, 5, 6, 7]);
  });

  test("C-1: cursor high-waters over the relay window — 201 old-epoch envelopes cannot livelock or block a fresh member", async () => {
    const { channelId } = await mbA.createChannel({ memberName: "a" });
    for (let i = 1; i <= 201; i++) await mbA.send(claim(`old epoch ${i}`, "a"));
    await mbA.rotate(channelId, "brand-new-password");
    await mbA.join(channelId, "brand-new-password", "a");
    const newMsg = await mbA.send(claim("new epoch begins", "a"));

    // fresh member holds ONLY the new password — the 201 old-epoch envelopes
    // are permanently undecryptable for it
    const dirC = mkdtempSync(join(tmpdir(), "scm-mb-c1-"));
    const storeC = new Store(join(dirC, "state.db"));
    try {
      const mbC = new RelayBridge({ baseUrl, store: storeC });
      await mbC.join(channelId, "brand-new-password", "c");

      // page cap: the relay returns at most 200 envelopes per window. Page 1
      // is entirely old-epoch ciphertext — the cursor must STILL advance to
      // the window's high-water (200), or this page would refetch forever.
      const page1 = await mbC.poll(channelId, 0);
      expect(page1.messages).toEqual([]);
      expect(page1.skipped).toBe(200);
      expect(storeC.getCursor(channelId)).toBe(200);

      // page 2 delivers the new-epoch message; the cursor lands on 202
      const page2 = await mbC.poll(channelId, storeC.getCursor(channelId));
      expect(page2.messages.map((m) => m.statement)).toEqual(["new epoch begins"]);
      expect(page2.messages[0]?.seq).toBe(newMsg.seq);
      expect(page2.skipped).toBe(1);
      expect(storeC.getCursor(channelId)).toBe(202);
    } finally {
      storeC.close();
      rmSync(dirC, { recursive: true, force: true });
    }
  });

  test("leave removes the channel from the local store", async () => {
    const { channelId, password } = await mbA.createChannel({ memberName: "a" });
    await mbB.join(channelId, password, "b");
    await mbB.leave(channelId);
    expect(storeB.listChannels()).toEqual([]);
    expect(storeB.getChannelSecret(channelId)).toBeNull();
  });
});
