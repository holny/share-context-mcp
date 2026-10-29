/**
 * Encrypted toggle (governance v2 §11): a channel-level `encrypted` boolean +
 * `key_version` counter, independent of admission mode. Manager/creator only.
 * Messages carry per-row encrypted + key_version stamps so members without
 * the current keyring entry can be told exactly how many messages they cannot
 * read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { deriveChannelKey, hmacProof, seal, validateClaim } from "@share-context-mcp/protocol";
import { startRelay, type RelayHandle } from "../src/index";

const PASSWORD = "enc-toggle-pass-1";

let dir: string;
let relay: RelayHandle;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), "relay-enc-"));
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

async function postJson(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function join(channelId: string, memberName: string): Promise<string> {
  const ch = await postJson(`/channels/${channelId}/challenge`, { memberName });
  const { nonceB64 } = ch.body as { nonceB64: string };
  const proof = hmacProof(new Uint8Array(Buffer.from(verifyKeyB64Of(PASSWORD, channelId), "base64")), nonceB64);
  const j = await postJson(`/channels/${channelId}/join`, { memberName, proof, consumerId: "s/enc0000001" });
  return (j.body as { token: string }).token;
}

async function createChannel(): Promise<{ channelId: string; creatorToken: string; memberToken: string }> {
  const channelId = randomBytes(8).toString("hex");
  const created = await postJson("/channels", { channelId, memberName: "mgr", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
  expect(created.status).toBe(200);
  const creatorToken = await join(channelId, "mgr");
  const memberToken = await join(channelId, "member");
  return { channelId, creatorToken, memberToken };
}

async function meta(channelId: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/channels/${channelId}/meta`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as Record<string, unknown>;
}

/** Post a claim-shaped opaque payload; returns the relay response. */
async function postMessage(
  channelId: string,
  token: string,
  idemKey: string,
  opts: { keyVersion?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return postJson(`/channels/${channelId}/messages`, {
    nonce: randomBytes(12).toString("base64"),
    ciphertext: randomBytes(64).toString("base64"),
    idemKey,
    ...(opts.keyVersion !== undefined ? { keyVersion: opts.keyVersion } : {}),
  }, token);
}

describe("encrypted toggle — relay side", () => {
  test("manager toggles on (key_version bumps), off (counter preserved)", async () => {
    const { channelId, creatorToken } = await createChannel();
    expect((await meta(channelId, creatorToken)).encrypted).toBe(false);
    expect((await meta(channelId, creatorToken)).keyVersion).toBe(0);

    const on = await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, creatorToken);
    expect(on.status).toBe(200);
    expect(on.body.encrypted).toBe(true);
    expect(on.body.keyVersion).toBe(1);
    expect((await meta(channelId, creatorToken)).encrypted).toBe(true);
    expect((await meta(channelId, creatorToken)).keyVersion).toBe(1);

    // toggling on again mints a NEW key version
    const on2 = await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, creatorToken);
    expect(on2.body.keyVersion).toBe(2);

    const off = await postJson(`/channels/${channelId}/set-encryption`, { encrypted: false }, creatorToken);
    expect(off.status).toBe(200);
    expect(off.body.encrypted).toBe(false);
    expect(off.body.keyVersion).toBe(2); // counter never regresses
    expect((await meta(channelId, creatorToken)).encrypted).toBe(false);
  });

  test("non-manager members are rejected (403)", async () => {
    const { channelId, memberToken } = await createChannel();
    const res = await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, memberToken);
    expect(res.status).toBe(403);
  });

  test("messages posted while encrypted carry the key version; plaintext channels stamp 0", async () => {
    const { channelId, creatorToken } = await createChannel();

    // plaintext phase: no keyVersion required, row stamped encrypted=0
    const plain = await postMessage(channelId, creatorToken, "idem-plain-001");
    expect(plain.status).toBe(200);

    await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, creatorToken);
    // encrypted phase: keyVersion required
    const missing = await postMessage(channelId, creatorToken, "idem-enc-missing");
    expect(missing.status).toBe(400);
    const ok = await postMessage(channelId, creatorToken, "idem-enc-001", { keyVersion: 1 });
    expect(ok.status).toBe(200);

    const rows = relay.db.prepare("SELECT seq, encrypted, key_version FROM messages WHERE channel_id = ? ORDER BY seq").all(channelId) as Array<{ seq: number; encrypted: number; key_version: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].encrypted).toBe(0);
    expect(rows[0].key_version).toBe(0);
    expect(rows[1].encrypted).toBe(1);
    expect(rows[1].key_version).toBe(1);

    // GET surfaces the stamps
    const page = await fetch(`${base}/channels/${channelId}/messages?since=0`, { headers: { authorization: `Bearer ${creatorToken}` } });
    const body = (await page.json()) as { messages: Array<{ encrypted: number; keyVersion: number }> };
    expect(body.messages[0].encrypted).toBe(0);
    expect(body.messages[1].encrypted).toBe(1);
    expect(body.messages[1].keyVersion).toBe(1);
  });

  test("toggling encryption is audited", async () => {
    const { channelId, creatorToken } = await createChannel();
    await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, creatorToken);
    const audit = await fetch(`${base}/channels/${channelId}/audit`, { headers: { authorization: `Bearer ${creatorToken}` } });
    const body = (await audit.json()) as { entries: Array<{ action: string }> };
    expect(body.entries.some((e) => e.action === "encryption.changed")).toBe(true);
  });
});

// silence unused-import lint for seal/validateClaim (used by server-side tests instead)
void seal;
void validateClaim;
