/**
 * S3Bridge tests (M3 Task 2): an in-process fake S3 (Bun.serve) as the
 * backend, two members (alice/bob) with separate connections, full lifecycle.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startFakeS3 } from "../src/bridge/fake-s3";
import { S3Bridge } from "../src/bridge/s3";

let root: string;
let stopFake: () => void;
let fakeUrl: string;
let alice: S3Bridge;
let bob: S3Bridge;

const conn = () => ({
  endpoint: fakeUrl,
  bucket: "test-bucket",
  region: "us-east-1",
  accessKeyId: "test-ak",
  secretAccessKey: "test-sk",
  prefix: "scm-test",
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "scm-s3bridge-"));
  const fake = startFakeS3(Number("1" + Math.floor(Math.random() * 8000 + 1000)));
  stopFake = fake.stop;
  fakeUrl = fake.url;
  alice = new S3Bridge({ ...conn(), defaultS3: conn() });
  bob = new S3Bridge({ ...conn(), defaultS3: conn() });
});

afterAll(() => {
  stopFake();
  rmSync(root, { recursive: true, force: true });
});

let channelId = "";

describe("S3Bridge", () => {
  test("create → join → send ×3 (concurrent) → poll delivers all with distinct seqs", async () => {
    const created = await alice.createChannel({ memberName: "alice", s3: conn() });
    channelId = created.channelId;
    expect(created.password).toMatch(/-/);

    await bob.join(channelId, created.password, "bob", { s3: conn() });

    const results = await Promise.all([
      alice.send({ statement: "contract v1", kind: "contract", topic: "auth", seq: null, ts: new Date().toISOString(), provenance: { member: "alice", source: "agent" } }, channelId),
      bob.send({ statement: "question on seq 1", kind: "question", topic: "auth", seq: null, ts: new Date().toISOString(), provenance: { member: "bob", source: "agent" } }, channelId),
      alice.send({ statement: "progress: done", kind: "progress", topic: "auth", seq: null, ts: new Date().toISOString(), provenance: { member: "alice", source: "agent" } }, channelId),
    ]);
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(3); // distinct seqs under concurrency (conditional head write)

    const poll = await bob.poll(channelId, 0);
    console.log("POLL1:", JSON.stringify(poll.messages.map((m) => ({ seq: m.seq, kind: m.kind }))));
    console.log("POLL1:", JSON.stringify(poll.messages.map((m) => ({ seq: m.seq, kind: m.kind, statement: m.statement.slice(0, 25) }))));
    expect(poll.messages.map((m) => m.seq as number).sort((x, y) => x - y)).toEqual([1, 2, 3]);
    expect(poll.skipped).toBe(0);
    expect(poll.messages.every((m) => m.provenance.member.length > 0)).toBe(true);
  });

  test("oversized statement rejected by validation before any S3 write", async () => {
    await expect(
      alice.send({ statement: "x".repeat(501), kind: "progress", topic: "t", seq: null, ts: new Date().toISOString(), provenance: { member: "alice", source: "agent" } }, channelId),
    ).rejects.toThrow("500");
  });

  test("meta lists both members", async () => {
    const meta = await alice.meta(channelId);
    console.log("META1:", JSON.stringify(meta));
    const names = meta.members.map((m) => m.memberName).sort();
    console.log("META:", JSON.stringify(names));
    expect(names).toEqual(["alice", "bob"]);
  });

  test("rotate: new epoch works, old-key holder still reads old messages", async () => {
    await alice.rotate(channelId, "newp-newp-newp-newp-00");
    // bob rejoins with the new password — but bob still holds the old key for
    // old-epoch messages (spec §5.5)
    await bob.join(channelId, "newp-newp-newp-newp-00", "bob", { s3: conn() });
    const poll = await bob.poll(channelId, 0);
    // epoch-1 ciphertext (3 messages) readable via retained key; epoch-2 empty
    console.log("ROTATE POLL:", JSON.stringify(poll.messages.map(m => ({ seq: m.seq, kind: m.kind, statement: m.statement.slice(0, 30) }))));
    expect(poll.messages.length).toBe(3);
    const fresh = await alice.send({ statement: "post-rotate", kind: "progress", topic: "post", seq: null, ts: new Date().toISOString(), provenance: { member: "alice", source: "agent" } }, channelId);
    expect(fresh.seq).toBeGreaterThan(3);
  });
});
