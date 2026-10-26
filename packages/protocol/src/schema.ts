/**
 * Claim message schema — the single shared message model (spec §5.2).
 * Consumed by the relay (blind, sees only ciphertext), the MCP server
 * (validates + seals), and tests.
 */

export const CLAIM_KINDS = [
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

export type ClaimKind = (typeof CLAIM_KINDS)[number];

export type ClaimSource = "agent" | "batch_import";

export interface ClaimProvenance {
  member: string;
  agent?: string;
  session_ref?: string;
  source: ClaimSource;
}

export interface ClaimMessage {
  seq: number | null;
  ts: string;
  statement: string;
  detail?: string;
  kind: ClaimKind;
  scope?: Record<string, string>;
  topic: string;
  to?: string;
  provenance: ClaimProvenance;
  idempotencyKey: string;
}

/** Field limits (exported so the server can reuse them in tool descriptions). */
export const LIMITS = {
  statementMax: 500,
  detailMax: 2048,
  topicMax: 64,
  scopeMaxKeys: 5,
  scopeKeyMax: 64,
  scopeValueMax: 120,
  toMax: 32,
  memberMax: 32,
  provenanceOptionalMax: 120,
} as const;

export interface CredentialPattern {
  pattern: RegExp;
  /** Human-readable pattern name — used in rejection reasons so the
   * matched secret text itself is never echoed into errors/logs. */
  label: string;
}

/**
 * Credentials blacklist — reject on match with an actionable reason.
 * Exported (single array) so the MCP server can reuse it.
 * At minimum catches: password=... assignments, PEM private keys,
 * AWS access keys (AKIA...), GitHub tokens (ghp_/ghs_), and sk- keys.
 */
export const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  { pattern: /(?:password|passwd|pwd|api[_-]?key)\s*[=:]\s*\S+/i, label: "password or API-key assignment" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key" },
  { pattern: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { pattern: /gh[ps]_[A-Za-z0-9]{20,}/, label: "GitHub token" },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/, label: "GitHub token" },
  { pattern: /sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/, label: "generic secret key" },
];

export function idempotencyKey(statement: string, kind: ClaimKind, topic: string): string {
  return createHash("sha256").update(`${statement}\n${kind}\n${topic}`).digest("hex");
}

import { createHash } from "node:crypto";

/** Returns the matching pattern's LABEL (never the matched text) or null. */
function scanForCredentials(text: string): string | null {
  for (const { pattern, label } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type ValidateResult =
  | { ok: true; msg: ClaimMessage }
  | { ok: false; reason: string };

/**
 * Validate and normalize a claim input into a ClaimMessage.
 * - statement: 1..500 chars after trim
 * - detail: optional, <=2048 chars
 * - kind: one of the 9-value enum
 * - topic: non-empty, <=64 chars
 * - scope: optional object string->string, <=5 keys, values <=120 chars
 * - to: optional, <=32 chars
 * - provenance: required; member 1..32 chars, source in {agent, batch_import}
 * Returns the normalized message with idempotencyKey filled
 * (sha256 hex of statement+kind+topic).
 */
export function validateClaim(input: unknown): ValidateResult {
  if (!isRecord(input)) {
    return { ok: false, reason: "claim must be a JSON object" };
  }

  // statement
  if (typeof input.statement !== "string") {
    return { ok: false, reason: "statement is required and must be a string" };
  }
  const statement = input.statement.trim();
  if (statement.length < 1 || statement.length > LIMITS.statementMax) {
    return {
      ok: false,
      reason: `statement must be 1..${LIMITS.statementMax} characters after trim (got ${statement.length})`,
    };
  }

  // detail
  let detail: string | undefined;
  if (input.detail !== undefined && input.detail !== null) {
    if (typeof input.detail !== "string") {
      return { ok: false, reason: "detail must be a string when present" };
    }
    const trimmed = input.detail.trim();
    if (trimmed.length > LIMITS.detailMax) {
      return {
        ok: false,
        reason: `detail must be at most ${LIMITS.detailMax} characters (got ${trimmed.length})`,
      };
    }
    if (trimmed.length > 0) detail = trimmed;
  }

  // kind
  const kind = input.kind;
  if (typeof kind !== "string" || !CLAIM_KINDS.includes(kind as ClaimKind)) {
    return {
      ok: false,
      reason: `kind must be one of: ${CLAIM_KINDS.join(", ")} (got ${JSON.stringify(kind)})`,
    };
  }

  // topic
  if (typeof input.topic !== "string") {
    return { ok: false, reason: "topic is required and must be a string" };
  }
  const topic = input.topic.trim();
  if (topic.length < 1 || topic.length > LIMITS.topicMax) {
    return {
      ok: false,
      reason: `topic must be 1..${LIMITS.topicMax} characters after trim (got ${topic.length})`,
    };
  }

  // scope — field names in errors/scan use index only, never the key text
  // (a scope key could itself carry a credential; see scan below)
  const scanned: Array<[string, string]> = [["statement", statement]];
  if (detail !== undefined) scanned.push(["detail", detail]);
  scanned.push(["topic", topic]);
  let scope: Record<string, string> | undefined;
  if (input.scope !== undefined && input.scope !== null) {
    if (!isRecord(input.scope)) {
      return { ok: false, reason: "scope must be an object of string -> string" };
    }
    const keys = Object.keys(input.scope);
    if (keys.length > LIMITS.scopeMaxKeys) {
      return {
        ok: false,
        reason: `scope must have at most ${LIMITS.scopeMaxKeys} keys (got ${keys.length})`,
      };
    }
    scope = {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.length > LIMITS.scopeKeyMax) {
        return {
          ok: false,
          reason: `scope key #${i} must be at most ${LIMITS.scopeKeyMax} characters (got ${k.length})`,
        };
      }
      const v = input.scope[k];
      if (typeof v !== "string") {
        return { ok: false, reason: `scope key #${i} value must be a string` };
      }
      if (v.length > LIMITS.scopeValueMax) {
        return {
          ok: false,
          reason: `scope key #${i} value must be at most ${LIMITS.scopeValueMax} characters (got ${v.length})`,
        };
      }
      scope[k] = v;
      scanned.push([`scope key #${i}`, k], [`scope key #${i} value`, v]);
    }
  }

  // to
  let to: string | undefined;
  if (input.to !== undefined && input.to !== null) {
    if (typeof input.to !== "string") {
      return { ok: false, reason: "to must be a string when present" };
    }
    const trimmedTo = input.to.trim();
    if (trimmedTo.length > LIMITS.toMax) {
      return {
        ok: false,
        reason: `to must be at most ${LIMITS.toMax} characters (got ${trimmedTo.length})`,
      };
    }
    if (trimmedTo.length > 0) to = trimmedTo;
  }
  if (to !== undefined) scanned.push(["to", to]);

  // provenance
  if (!isRecord(input.provenance)) {
    return { ok: false, reason: "provenance is required (member, source)" };
  }
  const prov = input.provenance;
  if (typeof prov.member !== "string" || prov.member.trim().length < 1 || prov.member.trim().length > LIMITS.memberMax) {
    return {
      ok: false,
      reason: `provenance.member must be 1..${LIMITS.memberMax} characters`,
    };
  }
  if (prov.source !== "agent" && prov.source !== "batch_import") {
    return {
      ok: false,
      reason: `provenance.source must be "agent" or "batch_import" (got ${JSON.stringify(prov.source)})`,
    };
  }
  const provenance: ClaimProvenance = { member: prov.member.trim(), source: prov.source };
  scanned.push(["provenance.member", provenance.member]);
  if (typeof prov.agent === "string" && prov.agent.trim().length > 0) {
    if (prov.agent.trim().length > LIMITS.provenanceOptionalMax) {
      return {
        ok: false,
        reason: `provenance.agent must be at most ${LIMITS.provenanceOptionalMax} characters (got ${prov.agent.trim().length})`,
      };
    }
    provenance.agent = prov.agent.trim();
    scanned.push(["provenance.agent", provenance.agent]);
  }
  if (typeof prov.session_ref === "string" && prov.session_ref.trim().length > 0) {
    if (prov.session_ref.trim().length > LIMITS.provenanceOptionalMax) {
      return {
        ok: false,
        reason: `provenance.session_ref must be at most ${LIMITS.provenanceOptionalMax} characters (got ${prov.session_ref.trim().length})`,
      };
    }
    provenance.session_ref = prov.session_ref.trim();
    scanned.push(["provenance.session_ref", provenance.session_ref]);
  }

  // credentials blacklist — EVERY string field of the claim
  for (const [field, text] of scanned) {
    const label = scanForCredentials(text);
    if (label) {
      return {
        ok: false,
        reason: `${field} rejected: looks like a credential (${label}). Remove the secret and re-send; never share credentials on the channel`,
      };
    }
  }

  // seq / ts
  const seq =
    typeof input.seq === "number" && Number.isInteger(input.seq) && input.seq >= 0 ? input.seq : null;
  const ts =
    typeof input.ts === "string" && input.ts.trim().length > 0
      ? input.ts.trim()
      : new Date().toISOString();

  const msg: ClaimMessage = {
    seq,
    ts,
    statement,
    detail,
    kind: kind as ClaimKind,
    scope,
    topic,
    to,
    provenance,
    idempotencyKey: idempotencyKey(statement, kind as ClaimKind, topic),
  };
  return { ok: true, msg };
}
