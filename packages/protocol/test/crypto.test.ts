import { describe, expect, test } from "bun:test";
import { deriveChannelKey, seal, open, hmacProof, mintAdmissionCredential, parseAdmissionCredential, mintInviteCode, parseInviteCode, encodeJoinBlob, parseJoinBlob } from "../src/crypto";
import { validateClaim, type ClaimMessage } from "../src/schema";

function validInput() {
  return {
    ts: "2026-10-25T09:30:00Z",
    statement: "moved auth middleware to packages/server/src/auth.ts",
    kind: "progress" as const,
    topic: "auth-refactor",
    provenance: { member: "a", agent: "opencode-v2", source: "agent" as const },
  };
}

function sampleMsg(): ClaimMessage {
  const r = validateClaim(validInput());
  if (!r.ok) throw new Error(`fixture invalid: ${r.reason}`);
  return r.msg;
}

describe("deriveChannelKey", () => {
  test("is deterministic for the same password and channelId", () => {
    const a = deriveChannelKey("pw1", "ch1");
    const b = deriveChannelKey("pw1", "ch1");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("differs when channelId differs", () => {
    const a = deriveChannelKey("pw1", "ch1");
    const b = deriveChannelKey("pw1", "ch2");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("differs when password differs", () => {
    const a = deriveChannelKey("pw1", "ch1");
    const b = deriveChannelKey("pw2", "ch1");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("returns 32 bytes", () => {
    expect(deriveChannelKey("pw1", "ch1").length).toBe(32);
  });
});

describe("seal / open", () => {
  test("roundtrips a claim message", () => {
    const key = deriveChannelKey("pw1", "ch1");
    const msg = sampleMsg();
    const env = seal(msg, key);
    expect(typeof env.nonce).toBe("string");
    expect(typeof env.ciphertext).toBe("string");
    const opened = open(env, key);
    expect(opened).toEqual(msg);
  });

  test("nonce is 12 random bytes, base64-encoded", () => {
    const key = deriveChannelKey("pw1", "ch1");
    const e1 = seal(sampleMsg(), key);
    const e2 = seal(sampleMsg(), key);
    expect(Buffer.from(e1.nonce, "base64").length).toBe(12);
    // random nonce => two seals of the same message differ
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  test("throws 'decrypt failed' on tampered ciphertext", () => {
    const key = deriveChannelKey("pw1", "ch1");
    const env = seal(sampleMsg(), key);
    const raw = Buffer.from(env.ciphertext, "base64");
    raw[0] ^= 0xff;
    const tampered = { nonce: env.nonce, ciphertext: raw.toString("base64") };
    expect(() => open(tampered, key)).toThrow("decrypt failed");
  });

  test("throws 'decrypt failed' with the wrong key", () => {
    const env = seal(sampleMsg(), deriveChannelKey("pw1", "ch1"));
    expect(() => open(env, deriveChannelKey("pw1", "ch2"))).toThrow("decrypt failed");
  });
});

describe("hmacProof", () => {
  test("is deterministic and nonce-dependent", () => {
    const key = deriveChannelKey("pw1", "ch1");
    const n1 = Buffer.from("0123456789abcdef012345").toString("base64");
    const n2 = Buffer.from("fedcba9876543210012345").toString("base64");
    expect(hmacProof(key, n1)).toBe(hmacProof(key, n1));
    expect(hmacProof(key, n1)).not.toBe(hmacProof(key, n2));
  });

  test("throws on a wrongly-sized key (16 bytes)", () => {
    const shortKey = new Uint8Array(16);
    expect(() => hmacProof(shortKey, Buffer.alloc(12).toString("base64"))).toThrow("32 bytes");
  });

  test("is base64 of HMAC-SHA256 over the raw nonce bytes", async () => {
    const { createHmac } = await import("node:crypto");
    const key = deriveChannelKey("pw1", "ch1");
    const nonceB64 = Buffer.from("0123456789abcdef012345").toString("base64");
    const expected = createHmac("sha256", Buffer.from(key))
      .update(Buffer.from(nonceB64, "base64"))
      .digest("base64");
    expect(hmacProof(key, nonceB64)).toBe(expected);
  });
});

describe("self-contained credentials", () => {
  const channelKey = deriveChannelKey("test-password", "testchannel01");

  test("admission credential round trip unwraps the exact channel key", () => {
    const { credential, verifyKeyB64 } = mintAdmissionCredential(channelKey);
    expect(credential.startsWith("scmc1-")).toBe(true);
    const unwrapped = parseAdmissionCredential(credential);
    expect(Array.from(unwrapped)).toEqual(Array.from(channelKey));
    expect(verifyKeyB64).not.toBeNull();
  });

  test("message key never derives from the credential text", () => {
    const { credential } = mintAdmissionCredential(channelKey);
    const wrong = deriveChannelKey(credential, "testchannel01");
    expect(Array.from(wrong)).not.toEqual(Array.from(channelKey));
  });

  test("invite code round trip: code id, key, expiry", () => {
    const codeId = "code-abc12345";
    const { code, codeId: outId, expiresAt } = mintInviteCode(channelKey, codeId, 86_400_000);
    expect(outId).toBe(codeId);
    const parsed = parseInviteCode(code);
    expect(parsed.codeId).toBe(codeId);
    expect(Array.from(parsed.channelKey)).toEqual(Array.from(channelKey));
    expect(Math.abs((parsed.expiresAt ?? 0) - expiresAt)).toBeLessThan(2000);
  });

  test("parse rejects tampered/truncated credentials", () => {
    expect(() => parseAdmissionCredential("scmc1-garbage")).toThrow();
    expect(() => parseInviteCode("scmc1-garbage")).toThrow();
  });
});

describe("join blob (spec §14: copy-paste onboarding)", () => {
  test("encode → parse round trip preserves every field", () => {
    const params = {
      relayUrl: "https://relay.corp.internal:8931",
      channelId: "abc123def456",
      credential: "scmc1-aaaa-bbbb",
      channelName: "auth-refactor",
      admissionMode: "password",
    };
    const blob = encodeJoinBlob(params);
    expect(typeof blob).toBe("string");
    // base64(JSON), no whitespace surprises when pasted with surrounding text
    expect(blob).not.toMatch(/\s/);
    expect(parseJoinBlob(blob)).toEqual(params);
  });

  test("invite-code blobs round trip; credential optional per mode", () => {
    const params = {
      relayUrl: "http://127.0.0.1:8931",
      channelId: "ch-invite001",
      inviteCode: "scmc1-xxxx-yyyy",
      admissionMode: "invite",
    };
    expect(parseJoinBlob(encodeJoinBlob(params))).toEqual(params);
  });

  test("parse tolerates surrounding whitespace (copy-paste margin)", () => {
    const blob = encodeJoinBlob({ channelId: "abc123def456", credential: "scmc1-zzz" });
    expect(parseJoinBlob(`  ${blob}\n`)).toEqual({ channelId: "abc123def456", credential: "scmc1-zzz" });
  });

  test("malformed blobs fail with readable errors", () => {
    expect(() => parseJoinBlob("not-a-blob!!")).toThrow(/JSON/);
    expect(() => parseJoinBlob(Buffer.from("[1,2]", "utf8").toString("base64"))).toThrow(/JSON object/);
    expect(() => parseJoinBlob(Buffer.from(JSON.stringify({ channelName: "no id" }), "utf8").toString("base64"))).toThrow(/channelId/);
    expect(() =>
      parseJoinBlob(Buffer.from(JSON.stringify({ channelId: "abc" }), "utf8").toString("base64")),
    ).toThrow(/credential or inviteCode/);
  });
});
