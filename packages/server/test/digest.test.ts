/**
 * Structural digest messages (Task 7): when the relay evicts a history
 * prefix, the local server aggregates the evicted range into kind="digest"
 * messages (verbatim high-value statements + counts) and posts them back to
 * the channel so late joiners can still see what happened. Zero LLM.
 */
import { describe, expect, test } from "bun:test";
import { LIMITS, type ClaimMessage } from "@share-context-mcp/protocol";
import { buildDigestMessages, buildDigestText } from "../src/digest";

let seq = 0;
const msg = (statement: string, kind: ClaimMessage["kind"], topic = "t"): ClaimMessage => ({
  seq: ++seq,
  ts: "2026-10-28T00:00:00Z",
  statement,
  kind,
  topic,
  provenance: { member: "a", source: "agent" },
  idempotencyKey: `k${seq}`,
});

const RANGE = { channelId: "ch0000000000", from: 1, to: 10 };

describe("buildDigestMessages", () => {
  test("keeps decision/contract/negative-result/question statements verbatim, counts the rest", () => {
    const msgs = [
      msg("decided: sliding window", "decision", "auth"),
      msg("contract v2 frozen", "contract", "export-api"),
      msg("bun upgrade breaks build", "negative-result", "build"),
      msg("what about rotate?", "question", "auth"),
      msg("progress one", "progress", "auth"),
      msg("progress two", "progress", "auth"),
      msg("env fact", "env-fact", "misc"),
    ];
    const built = buildDigestMessages(msgs, RANGE, LIMITS);
    expect(built.length).toBe(1);
    const d = built[0];
    expect(d.statement).toContain("decided: sliding window");
    expect(d.statement).toContain("contract v2 frozen");
    expect(d.statement).toContain("bun upgrade breaks build");
    expect(d.statement).toContain("what about rotate?");
    expect(d.statement).not.toContain("progress one");
    expect(d.detail).toContain("progress×2");
    expect(d.detail).toContain("env-fact×1");
    expect(d.covers).toBe("1-10");
  });

  test("returns nothing (null text / empty array) when zero high-value messages", () => {
    const msgs = [msg("progress one", "progress"), msg("howto two", "howto")];
    expect(buildDigestMessages(msgs, RANGE, LIMITS)).toEqual([]);
    expect(buildDigestText(msgs, RANGE)).toBeNull();
  });

  test("collapses statements beyond the verbatim cap to one-line entries", () => {
    const msgs = Array.from({ length: 120 }, (_, i) => msg(`decision number ${i + 1} ${"d".repeat(80)}`, "decision"));
    const built = buildDigestMessages(msgs, { channelId: "ch0000000000", from: 1, to: 120 }, LIMITS);
    const text = built.map((b) => b.detail).join("\n");
    // most recent 100 (numbers 21..120) verbatim; oldest 20 collapsed to truncated pointers
    expect(text).toContain(`decision number 120 ${"d".repeat(80)}`);
    expect(text).toContain(`decision number 21 ${"d".repeat(80)}`);
    expect(text).not.toContain(`decision number 2 ${"d".repeat(80)}`); // collapsed → truncated pointer only
  });

  test("chunks output so each message respects statement/detail limits", () => {
    const small = { ...LIMITS, statementMax: 300, detailMax: 400 };
    const msgs = Array.from({ length: 30 }, (_, i) => msg(`decision ${i + 1} ${"x".repeat(80)}`, "decision"));
    const built = buildDigestMessages(msgs, { channelId: "ch0000000000", from: 1, to: 30 }, small);
    expect(built.length).toBeGreaterThan(1);
    for (const b of built) {
      expect(b.statement.length).toBeLessThanOrEqual(small.statementMax);
      expect(b.detail.length).toBeLessThanOrEqual(small.detailMax);
      expect(b.covers).toMatch(/^\d+-\d+$/);
    }
    // ranges are contiguous and cover the whole input range
    expect(built[0].covers.startsWith("1-")).toBe(true);
    expect(built[built.length - 1].covers.endsWith("-30")).toBe(true);
  });
});
