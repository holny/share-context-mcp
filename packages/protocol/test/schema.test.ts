import { describe, expect, test } from "bun:test";
import { validateClaim, idempotencyKey, CREDENTIAL_PATTERNS } from "../src/schema";

const KINDS = [
  "progress",
  "decision",
  "contract",
  "spec",
  "howto",
  "env-fact",
  "negative-result",
  "question",
  "claim",
] as const;

function base(kind: string = "progress") {
  return {
    ts: "2026-10-25T09:30:00Z",
    statement: "chose sqlite for relay storage",
    kind,
    topic: "relay-design",
    provenance: { member: "a", source: "agent" },
  };
}

describe("validateClaim — statement length", () => {
  test("rejects a 501-character statement with reason mentioning 500", () => {
    const r = validateClaim({ ...base(), statement: "x".repeat(501) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("500");
  });

  test("accepts a 500-character statement", () => {
    const r = validateClaim({ ...base(), statement: "x".repeat(500) });
    expect(r.ok).toBe(true);
  });

  test("rejects an empty or whitespace-only statement", () => {
    expect(validateClaim({ ...base(), statement: "" }).ok).toBe(false);
    expect(validateClaim({ ...base(), statement: "   " }).ok).toBe(false);
  });

  test("normalizes by trimming the statement", () => {
    const r = validateClaim({ ...base(), statement: "  hello world  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg.statement).toBe("hello world");
  });
});

describe("validateClaim — credentials blacklist", () => {
  test("rejects statements containing a GitHub token", () => {
    const r = validateClaim({
      ...base(),
      statement: "use this token ghp_ABCDEFGHIJKLMNOPQRSTUVWXyz1234 please",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects password= assignments", () => {
    const r = validateClaim({ ...base(), statement: "the password=hunter2 works" });
    expect(r.ok).toBe(false);
  });

  test("rejects PEM private keys", () => {
    const r = validateClaim({
      ...base(),
      detail: "-----BEGIN RSA PRIVATE KEY-----",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects AWS access keys", () => {
    const r = validateClaim({ ...base(), statement: "AKIAIOSFODNN7EXAMPLE is live" });
    expect(r.ok).toBe(false);
  });

  test("rejects sk- keys", () => {
    const r = validateClaim({ ...base(), statement: "key: sk-abcdefghijklmnop1234" });
    expect(r.ok).toBe(false);
  });

  test("rejects a credential hidden in a scope value", () => {
    const r = validateClaim({
      ...base(),
      scope: { note: "rotate ghp_ABCDEFGHIJKLMNOPQRSTUVWXyz1234 soon" },
    });
    expect(r.ok).toBe(false);
  });

  test("rejects a credential hidden in a scope key without echoing it", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXyz1234";
    const r = validateClaim({ ...base(), scope: { [secret]: "v" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain("ghp_");
  });

  test("rejects a credential hidden in the to field", () => {
    const r = validateClaim({ ...base(), to: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXyz1234" });
    expect(r.ok).toBe(false);
  });

  test("rejects a credential hidden in provenance.agent", () => {
    const r = validateClaim({
      ...base(),
      provenance: { member: "a", agent: "sk-abcdefghijklmnop1234", source: "agent" },
    });
    expect(r.ok).toBe(false);
  });

  test("rejection reason names the pattern label and never echoes the secret", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXyz1234";
    const r = validateClaim({ ...base(), statement: `use ${secret} now` });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("GitHub token");
      expect(r.reason).not.toContain("ghp_");
      expect(r.reason).not.toContain("ABCDEFGHIJKLMNOP");
    }
  });

  test("blacklist is exported for reuse by the server", () => {
    expect(Array.isArray(CREDENTIAL_PATTERNS)).toBe(true);
    expect(CREDENTIAL_PATTERNS.length).toBeGreaterThanOrEqual(5);
    for (const entry of CREDENTIAL_PATTERNS) {
      expect(typeof entry.pattern).toBe("object"); // RegExp
      expect(typeof entry.label).toBe("string");
    }
  });
});

describe("validateClaim — kind enum", () => {
  test("accepts all 9 valid kinds", () => {
    for (const kind of KINDS) {
      const r = validateClaim(base(kind));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.msg.kind).toBe(kind);
    }
  });

  test('rejects "foo"', () => {
    const r = validateClaim(base("foo"));
    expect(r.ok).toBe(false);
  });
});

describe("validateClaim — other fields", () => {
  test("rejects detail over 2048 characters", () => {
    const r = validateClaim({ ...base(), detail: "y".repeat(2049) });
    expect(r.ok).toBe(false);
  });

  test("accepts detail up to 2048 characters", () => {
    const r = validateClaim({ ...base(), detail: "y".repeat(2048) });
    expect(r.ok).toBe(true);
  });

  test("rejects a topic over 64 characters or empty", () => {
    expect(validateClaim({ ...base(), topic: "t".repeat(65) }).ok).toBe(false);
    expect(validateClaim({ ...base(), topic: "" }).ok).toBe(false);
  });

  test("rejects scope with more than 5 keys, non-string values, or values over 120 chars", () => {
    const six: Record<string, string> = {};
    for (let i = 0; i < 6; i++) six[`k${i}`] = "v";
    expect(validateClaim({ ...base(), scope: six }).ok).toBe(false);
    expect(validateClaim({ ...base(), scope: { repo: 123 as unknown as string } }).ok).toBe(false);
    expect(validateClaim({ ...base(), scope: { repo: "v".repeat(121) } }).ok).toBe(false);
  });

  test("rejects an oversize scope key (over 64 chars)", () => {
    const r = validateClaim({ ...base(), scope: { ["k".repeat(65)]: "v" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("64");
      expect(r.reason).not.toContain("kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk");
    }
  });

  test("rejects oversize provenance.agent and session_ref (over 120 chars)", () => {
    const long = "z".repeat(121);
    expect(
      validateClaim({ ...base(), provenance: { member: "a", agent: long, source: "agent" } }).ok,
    ).toBe(false);
    expect(
      validateClaim({
        ...base(),
        provenance: { member: "a", session_ref: long, source: "agent" },
      }).ok,
    ).toBe(false);
  });

  test("rejects a to field over 32 characters", () => {
    expect(validateClaim({ ...base(), to: "b".repeat(33) }).ok).toBe(false);
  });

  test("requires provenance with member 1..32 and source in enum", () => {
    expect(validateClaim({ ...base(), provenance: undefined }).ok).toBe(false);
    expect(validateClaim({ ...base(), provenance: { member: "", source: "agent" } }).ok).toBe(false);
    expect(validateClaim({ ...base(), provenance: { member: "m".repeat(33), source: "agent" } }).ok).toBe(false);
    expect(validateClaim({ ...base(), provenance: { member: "a", source: "other" } }).ok).toBe(false);
  });

  test("accepts batch_import as provenance source", () => {
    const r = validateClaim({ ...base(), provenance: { member: "a", source: "batch_import" } });
    expect(r.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    expect(validateClaim(null).ok).toBe(false);
    expect(validateClaim("nope").ok).toBe(false);
    expect(validateClaim(42).ok).toBe(false);
  });
});

describe("validateClaim — idempotencyKey", () => {
  test("is filled with sha256 hex of statement+kind+topic", () => {
    const r = validateClaim(base("decision"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.msg.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
      expect(r.msg.idempotencyKey).toBe(idempotencyKey("chose sqlite for relay storage", "decision", "relay-design"));
    }
  });

  test("same statement+kind+topic yields the same key", () => {
    const a = validateClaim(base());
    const b = validateClaim(base());
    if (a.ok && b.ok) expect(a.msg.idempotencyKey).toBe(b.msg.idempotencyKey);
  });
});
