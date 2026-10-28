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
