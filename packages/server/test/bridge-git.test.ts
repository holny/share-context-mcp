/**
 * GitBridge tests (M3 Task 1): a temp `git init --bare` repo as the remote,
 * two members (alice/bob) over separate working copies, full lifecycle.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GitBridge } from "../src/bridge/git";
import { Store } from "../src/store";

let root: string;
let bare: string;
let alice: GitBridge;
let bob: GitBridge;
const dirs: string[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "scm-gitbridge-"));
  dirs.push(root);
  bare = join(root, "remote.git");
  spawnSync("git", ["init", "--bare", "-b", "main", bare]);
  const aliceDir = join(root, "alice");
  const bobDir = join(root, "bob");
  dirs.push(aliceDir, bobDir);
  const storeA = new Store(join(aliceDir, "state.db"));
  const storeB = new Store(join(bobDir, "state.db"));
  alice = new GitBridge({ remoteRoot: bare, workRoot: aliceDir });
  // GitBridge doesn't use Store, but the constructor signature parity keeps
  // the test honest about two isolated machines.
  void storeA;
  void storeB;
  alice = new GitBridge({ remoteRoot: bare, workRoot: aliceDir });
  bob = new GitBridge({ remoteRoot: bare, workRoot: bobDir });
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function gitUrl(): string {
  return bare;
}

let channelId = "";
let alicePassword = "";

describe("GitBridge", () => {
  test("create → join → send ×3 → poll delivers all → meta lists both members", async () => {
    const created = await alice.createChannel({ memberName: "alice", gitUrl: gitUrl() });
    channelId = created.channelId;
    alicePassword = created.password;
    expect(channelId.length).toBeGreaterThan(3);
    expect(alicePassword).toMatch(/-/);

    await bob.join(channelId, alicePassword, "bob", { gitUrl: gitUrl() });

    const r1 = await alice.send({ statement: "contract v1", kind: "contract", topic: "auth", seq: null, ts: new Date().toISOString(), provenance: { member: "tester", source: "agent" } }, channelId);
    const r2 = await bob.send({ statement: "question about seq 1", kind: "question", topic: "auth", seq: null, ts: new Date().toISOString(), provenance: { member: "tester", source: "agent" } }, channelId);
    const r3 = await alice.send({ statement: "pitfall: node 26 breaks X", kind: "negative-result", topic: "env", seq: null, ts: new Date().toISOString(), provenance: { member: "tester", source: "agent" } }, channelId);
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(r3.seq).toBe(3);

    const bPoll = await bob.poll(channelId, 0);
    expect(bPoll.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(bPoll.skipped).toBe(0);
    const aPoll = await alice.poll(channelId, 0);
    expect(aPoll.messages.length).toBe(3);

    const meta = await bob.meta(channelId);
    const names = meta.members.map((m) => m.memberName).sort();
    expect(names).toEqual(["alice", "bob"]);
  });

  test("send validates and rejects an oversized statement", async () => {
    await expect(
      alice.send({ statement: "x".repeat(501), kind: "progress", topic: "t", seq: null, ts: new Date().toISOString(), provenance: { member: "tester", source: "agent" } }, channelId),
    ).rejects.toThrow("500");
  });

  test("rotate: new password works, old epoch messages still readable by holder", async () => {
    await alice.rotate(channelId, "newp-newp-newp-newp-n0");
    // Realistic rotation flow: teammates learn the new password out-of-band
    // and re-join; bob keeps his epoch-1 key retained, so he still reads the
    // old epoch while sending into the new one.
    await bob.join(channelId, "newp-newp-newp-newp-n0", "bob", { gitUrl: gitUrl() });
    const poll = await alice.poll(channelId, 0);
    expect(poll.messages.length).toBeGreaterThanOrEqual(3);
    const bobPoll = await bob.poll(channelId, 0);
    expect(bobPoll.messages.length).toBeGreaterThanOrEqual(3);
  });

  test("sequential raced sends: seqs stay unique and no message is lost (C2)", async () => {
    // Realistic rotation flow: teammates learn the new password out-of-band
    // (that is what rotation means) — bob re-joins with it before sending.
    await bob.join(channelId, "newp-newp-newp-newp-n0", "bob");
    const r1 = await bob.send({ statement: "bob first", kind: "progress", topic: "race2", seq: null, ts: new Date().toISOString(), provenance: { member: "bob", source: "agent" } }, channelId);
    const r2 = await alice.send({ statement: "alice second", kind: "progress", topic: "race2", seq: null, ts: new Date().toISOString(), provenance: { member: "alice", source: "agent" } }, channelId);
    const r3 = await bob.send({ statement: "bob third", kind: "progress", topic: "race2", seq: null, ts: new Date().toISOString(), provenance: { member: "bob", source: "agent" } }, channelId);
    const seqs = [r1.seq, r2.seq, r3.seq];
    expect(new Set(seqs).size).toBe(3);
    const poll = await alice.poll(channelId, 0);
    console.log("RACE:", r1.seq, r2.seq, r3.seq, "| all:", JSON.stringify(poll.messages.map((m) => m.seq)));
    const all = poll.messages.map((m) => m.seq as number);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain(r1.seq);
    expect(all).toContain(r2.seq);
    expect(all).toContain(r3.seq);
  });
});
