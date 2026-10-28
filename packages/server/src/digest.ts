/**
 * Structural digest messages (spec §history): when the relay evicts a history
 * prefix, the local server aggregates the evicted range into kind="digest"
 * messages and posts them back to the channel so late joiners can still see
 * what happened. Zero LLM: high-value statements (decision / contract /
 * negative-result / question) are kept VERBATIM — they are self-contained
 * ≤500-char claims by protocol invariant — everything else is counted per
 * topic. Chunks respect LIMITS so each digest is an ordinary valid message.
 */
import type { ClaimMessage } from "@share-context-mcp/protocol";
import { LIMITS } from "@share-context-mcp/protocol";

export interface DigestRange {
  channelId: string;
  from: number;
  to: number;
}

export interface DigestBuild {
  statement: string;
  detail: string;
  covers: string;
}

const HIGH_VALUE_KINDS: ReadonlySet<ClaimMessage["kind"]> = new Set([
  "decision",
  "contract",
  "negative-result",
  "question",
]);

const VERBATIM_CAP = 100;

type Line = { seq: number | null; text: string };

function digestLines(msgs: ReadonlyArray<ClaimMessage>): Line[] {
  const sorted = [...msgs].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const high = sorted.filter((m) => HIGH_VALUE_KINDS.has(m.kind));
  const lines: Line[] = [];
  if (high.length === 0) return lines;
  const collapsedCount = Math.max(0, high.length - VERBATIM_CAP);
  for (const m of high.slice(0, collapsedCount)) {
    lines.push({ seq: m.seq, text: `seq ${m.seq} (collapsed): ${m.statement.slice(0, 60)}…` });
  }
  for (const m of high.slice(collapsedCount)) {
    lines.push({ seq: m.seq, text: `seq ${m.seq} [${m.kind}] ${m.statement}` });
  }
  // counts for the remaining kinds, per topic
  const counts = new Map<string, number>();
  for (const m of sorted) {
    if (HIGH_VALUE_KINDS.has(m.kind)) continue;
    const key = `${m.topic}/${m.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size > 0) {
    lines.push({
      seq: null,
      text: `other kinds: ${[...counts.entries()].map(([k, n]) => `${k}×${n}`).join(", ")}`,
    });
  }
  return lines;
}

/**
 * Build digest message(s) covering `range`. Returns [] when the range holds
 * zero high-value messages (a digest with nothing worth keeping is noise).
 * Chunking: lines are packed greedily into detail blocks ≤ detailMax; each
 * block becomes one message whose covers is the seq span of its lines.
 */
export function buildDigestMessages(
  msgs: ReadonlyArray<ClaimMessage>,
  range: DigestRange,
  limits: { statementMax: number; detailMax: number } = LIMITS,
): DigestBuild[] {
  const lines = digestLines(msgs);
  if (lines.length === 0) return [];

  const blocks: Line[][] = [];
  let current: Line[] = [];
  let size = 0;
  for (const line of lines) {
    // +1 for the join newline; keep 32 chars headroom for the header line
    if (current.length > 0 && size + line.text.length + 1 > limits.detailMax - 32) {
      blocks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.text.length + 1;
  }
  if (current.length > 0) blocks.push(current);

  return blocks.map((block, i) => {
    const seqs = block.map((l) => l.seq).filter((s): s is number => s !== null);
    const from = i === 0 ? range.from : (seqs[0] ?? range.from);
    const to = i === blocks.length - 1 ? range.to : (seqs[seqs.length - 1] ?? range.to);
    const detail = block.map((l) => l.text).join("\n");
    // statement: header + ALL of the chunk's verbatim lines while they fit —
    // the statement is what index cards and injections surface; anything that
    // overflows statementMax stays in the detail (fetchable via catch_up).
    const header = `channel digest seq ${from}-${to} (${block.length} entries)`;
    const verbatimLines = block
      .filter((l) => l.seq !== null && !l.text.includes("(collapsed)"))
      .map((l) => l.text);
    let body = "";
    for (const line of verbatimLines) {
      const candidate = body === "" ? line : `${body}\n${line}`;
      if (candidate.length > limits.statementMax - header.length - 2) break;
      body = candidate;
    }
    const statement = body !== "" ? `${header}\n${body}` : header.slice(0, limits.statementMax);
    return { statement, detail, covers: `${from}-${to}` };
  });
}

/** Single-chunk convenience wrapper: null when nothing high-value exists. */
export function buildDigestText(msgs: ReadonlyArray<ClaimMessage>, range: DigestRange): string | null {
  const built = buildDigestMessages(msgs, range);
  return built.length > 0 ? built[0].detail : null;
}
