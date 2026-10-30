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
  test("manager toggles on and off; the key_version counter is untouched (v3: only rotate-key bumps it)", async () => {
    const { channelId, creatorToken } = await createChannel();
    expect((await meta(channelId, creatorToken)).encrypted).toBe(false);
    expect((await meta(channelId, creatorToken)).keyVersion).toBe(0);

    const on = await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, creatorToken);
    expect(on.status).toBe(200);
    expect(on.body.encrypted).toBe(true);
    expect(on.body.keyVersion).toBe(0); // no client-side minting anymore
    expect((await meta(channelId, creatorToken)).encrypted).toBe(true);
    expect((await meta(channelId, creatorToken)).keyVersion).toBe(0);

    // the version comes only from the owner's rotate-key
    expect((await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1 }, creatorToken)).status).toBe(200);
    expect((await meta(channelId, creatorToken)).keyVersion).toBe(1);

    const off = await postJson(`/channels/${channelId}/set-encryption`, { encrypted: false }, creatorToken);
    expect(off.status).toBe(200);
    expect(off.body.encrypted).toBe(false);
    expect(off.body.keyVersion).toBe(1); // counter never regresses
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
    // owner mints v1 (the ONLY key-material generation point besides creation)
    expect((await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1 }, creatorToken)).status).toBe(200);
    // encrypted phase: keyVersion required for a sealed row
    const missing = await postMessage(channelId, creatorToken, "idem-enc-missing");
    expect(missing.status).toBe(200); // plaintext send is allowed; stamped encrypted=0
    const ok = await postMessage(channelId, creatorToken, "idem-enc-001", { keyVersion: 1 });
    expect(ok.status).toBe(200);

    const rows = relay.db.prepare("SELECT seq, encrypted, key_version FROM messages WHERE channel_id = ? ORDER BY seq").all(channelId) as Array<{ seq: number; encrypted: number; key_version: number }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].encrypted).toBe(0);
    expect(rows[0].key_version).toBe(0);
    expect(rows[1].encrypted).toBe(0); // plaintext send on encrypted channel
    expect(rows[2].encrypted).toBe(1);
    expect(rows[2].key_version).toBe(1);

    // GET surfaces the stamps
    const page = await fetch(`${base}/channels/${channelId}/messages?since=0`, { headers: { authorization: `Bearer ${creatorToken}` } });
    const body = (await page.json()) as { messages: Array<{ encrypted: number; keyVersion: number }> };
    expect(body.messages[0].encrypted).toBe(0);
    expect(body.messages[2].encrypted).toBe(1);
    expect(body.messages[2].keyVersion).toBe(1);
  });

  test("toggling encryption is audited", async () => {
    const { channelId, creatorToken } = await createChannel();
    await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, creatorToken);
    const audit = await fetch(`${base}/channels/${channelId}/audit`, { headers: { authorization: `Bearer ${creatorToken}` } });
    const body = (await audit.json()) as { entries: Array<{ action: string }> };
    expect(body.entries.some((e) => e.action === "encryption.changed")).toBe(true);
  });
});

describe("key governance (v3) — owner-only rotate-key, relay-enforced key_version", () => {
  async function createEncryptedChannel(contact?: string): Promise<{ channelId: string; creatorToken: string; memberToken: string }> {
    const channelId = randomBytes(8).toString("hex");
    const created = await postJson("/channels", {
      channelId,
      memberName: "owner",
      contactInfo: contact,
      verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId),
    });
    expect(created.status).toBe(200);
    const creatorToken = await join(channelId, "owner");
    const memberToken = await join(channelId, "member");
    const on = await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, creatorToken);
    expect(on.status).toBe(200);
    return { channelId, creatorToken, memberToken };
  }

  test("set-encryption only flips the flag — key_version stays 0 until rotate-key", async () => {
    const { channelId, creatorToken } = await createEncryptedChannel();
    expect((await meta(channelId, creatorToken)).encrypted).toBe(true);
    expect((await meta(channelId, creatorToken)).keyVersion).toBe(0);
    // toggling on again does NOT mint a version either
    await postJson(`/channels/${channelId}/set-encryption`, { encrypted: true }, creatorToken);
    expect((await meta(channelId, creatorToken)).keyVersion).toBe(0);
  });

  test("stale key_version send → 409 with currentVersion + contact; matching version stored; unencrypted send still allowed", async () => {
    const { channelId, creatorToken, memberToken } = await createEncryptedChannel("ping owner on #ops");
    // owner rotates to v1
    const rot = await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1, sealedKey: "c2VhbGVkLWtleQ==" }, creatorToken);
    expect(rot.status).toBe(200);
    expect(rot.body.keyVersion).toBe(1);
    // the sealed copy is stored on the public tier
    expect(
      (relay.db.prepare("SELECT sealed_key FROM channels WHERE id = ?").get(channelId) as { sealed_key: string | null }).sealed_key,
    ).toBe("c2VhbGVkLWtleQ==");

    // matching version → stored, stamped encrypted=1
    const ok = await postMessage(channelId, memberToken, "idem-kg-001", { keyVersion: 1 });
    expect(ok.status).toBe(200);

    // unencrypted send on the encrypted channel — allowed (flag mismatch is a
    // client concern; the relay stamps the row plaintext)
    const plain = await postMessage(channelId, memberToken, "idem-kg-plain");
    expect(plain.status).toBe(200);
    const rows = relay.db.prepare("SELECT encrypted, key_version FROM messages WHERE channel_id = ? AND idem_key = ?").all(channelId, "idem-kg-plain") as Array<{ encrypted: number; key_version: number }>;
    expect(rows[0].encrypted).toBe(0);

    // owner rotates to v2 → the v1 send is now stale → 409 with actionable body
    const rot2 = await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 2 }, creatorToken);
    expect(rot2.status).toBe(200);
    const stale = await postMessage(channelId, memberToken, "idem-kg-stale", { keyVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("message key rotated");
    expect(stale.body.currentVersion).toBe(2);
    expect(stale.body.contact).toBe("ping owner on #ops");
    expect(typeof stale.body.rotatedAt).toBe("string");

    // the v2 send is accepted again
    const ok2 = await postMessage(channelId, memberToken, "idem-kg-002", { keyVersion: 2 });
    expect(ok2.status).toBe(200);

    // sealed_key tracks the LATEST rotation: the v1 deposit was dropped when
    // the owner rotated to v2 without depositing a new copy (spec §3.1: one
    // active key version — a stale sealed copy must not survive).
    const chRow = relay.db.prepare("SELECT sealed_key, key_rotated_at FROM channels WHERE id = ?").get(channelId) as { sealed_key: string | null; key_rotated_at: string | null };
    expect(chRow.sealed_key).toBeNull();
    expect(chRow.key_rotated_at).not.toBeNull();
  });

  test("rotate-key is creator-only: manager-who-is-not-creator and members get 403", async () => {
    const channelId = randomBytes(8).toString("hex");
    const created = await postJson("/channels", { channelId, memberName: "owner", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
    expect(created.status).toBe(200);
    const ownerToken = await join(channelId, "owner");
    const mgrToken = await join(channelId, "mgr");
    const memberToken = await join(channelId, "member");
    // promote mgr to manager (creator op)
    const xfer = await postJson(`/channels/${channelId}/transfer`, { to: "mgr" }, ownerToken);
    expect(xfer.status).toBe(200);
    // manager who is NOT the creator → 403
    const byMgr = await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1 }, mgrToken);
    expect(byMgr.status).toBe(403);
    // regular member → 403
    const byMember = await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1 }, memberToken);
    expect(byMember.status).toBe(403);
    // creator → ok, audited
    const byOwner = await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1 }, ownerToken);
    expect(byOwner.status).toBe(200);
    const auditRows = relay.db.prepare("SELECT action FROM audit_log WHERE channel_id = ?").all(channelId) as Array<{ action: string }>;
    expect(auditRows.some((r) => r.action === "rotate-key")).toBe(true);
  });

  test("rotate-key WS broadcast: {type:key_rotated, keyVersion, contact, rotatedAt} — never key material", async () => {
    const { channelId, creatorToken, memberToken } = await createEncryptedChannel("contact-x");
    const ws = new WebSocket(`${base.replace("http", "ws")}/channels/${channelId}/ws?token=${encodeURIComponent(memberToken)}`);
    const frames: Record<string, unknown>[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => resolve());
    });
    ws.addEventListener("message", (ev) => frames.push(JSON.parse(String((ev as MessageEvent).data))));
    const rot = await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1 }, creatorToken);
    expect(rot.status).toBe(200);
    await Bun.sleep(300);
    ws.close();
    const gov = frames.find((f) => f.type === "key_rotated");
    expect(gov).toBeDefined();
    expect(gov?.keyVersion).toBe(1);
    expect(gov?.contact).toBe("contact-x");
    expect(typeof gov?.rotatedAt).toBe("string");
    // the frame carries NO key material of any kind
    expect(JSON.stringify(gov)).not.toMatch(/sealed|key_material|keyData/i);
  });

  test("rotate-key rejects non-increasing versions and sealed keys on private channels", async () => {    const channelId = randomBytes(8).toString("hex");
    const created = await postJson("/channels", { channelId, memberName: "owner", verifyKeyB64: verifyKeyB64Of(PASSWORD, channelId) });
    expect(created.status).toBe(200);
    const ownerToken = await join(channelId, "owner");
    expect((await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 0 }, ownerToken)).status).toBe(400);
    expect((await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1 }, ownerToken)).status).toBe(200);
    // same or lower version after rotation → 409
    expect((await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 1 }, ownerToken)).status).toBe(409);
    // sealed key on a PRIVATE channel → 400 (relay must not hold keys there)
    expect(
      (await postJson(`/channels/${channelId}/set-admission`, { visibility: "private" }, ownerToken)).status,
    ).toBe(200);
    expect(
      (await postJson(`/channels/${channelId}/rotate-key`, { keyVersion: 2, sealedKey: "c2VhbGVk" }, ownerToken)).status,
    ).toBe(400);
  });
});

// silence unused-import lint for seal/validateClaim (used by server-side tests instead)
void seal;
void validateClaim;
