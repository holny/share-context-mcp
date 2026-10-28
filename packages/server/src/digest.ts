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

/** Code-point safe truncation (a naive slice can split a surrogate pair). */
function truncate(text: string, max: number): string {
  return Array.from(text)
    .slice(0, max)
    .join("");
}

type Line = { seq: number | null; text: string; collapsed?: boolean };

function digestLines(msgs: ReadonlyArray<ClaimMessage>): Line[] {
  const sorted = [...msgs].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const high = sorted.filter((m) => HIGH_VALUE_KINDS.has(m.kind));
  const lines: Line[] = [];
  if (high.length === 0) return lines;
  const collapsedCount = Math.max(0, high.length - VERBATIM_CAP);
  for (const m of high.slice(0, collapsedCount)) {
    lines.push({ seq: m.seq, text: `seq ${m.seq} (collapsed): ${truncate(m.statement, 60)}…`, collapsed: true });
  }
  for (const m of high.slice(collapsedCount)) {
    lines.push({ seq: m.seq, text: `seq ${m.seq} [${m.kind}] ${m.statement}` });
  }
  // counts for the remaining kinds (digests excluded — a digest must not
  // count earlier digests as channel content), one entry per line so the
  // chunker can split a long tail across blocks.
  const counts = new Map<string, number>();
  for (const m of sorted) {
    if (HIGH_VALUE_KINDS.has(m.kind) || m.kind === "digest") continue;
    const key = `${m.topic}/${m.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size > 0) {
    lines.push({ seq: null, text: "other kinds:" });
    for (const [k, n] of counts) lines.push({ seq: null, text: `  ${k}×${n}` });
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

  let runningLast: number | undefined; // last real seq seen in earlier blocks
  return blocks.map((block, i) => {
    const seqs = block.map((l) => l.seq).filter((s): s is number => s !== null);
    if (seqs.length > 0) runningLast = seqs[seqs.length - 1];
    const prevLast = runningLast;
    // chunks without their own seqs (e.g. a trailing counts-only line) extend
    // the previous chunk's span rather than claiming the whole range
    const from = i === 0 ? range.from : (seqs[0] ?? prevLast ?? range.from);
    const to = i === blocks.length - 1 ? range.to : (seqs[seqs.length - 1] ?? range.to);
    const detail = block.map((l) => l.text).join("\n");
    // statement: header + ALL of the chunk's verbatim lines while they fit —
    // the statement is what index cards and injections surface; anything that
    // overflows statementMax stays in the detail (fetchable via catch_up).
    const header = `channel digest seq ${from}-${to} (${block.length} entries)`;
    const verbatimLines = block.filter((l) => !l.collapsed && l.seq !== null).map((l) => l.text);
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

/** Single-chunk convenience: digest detail text, or null when nothing high-value exists. */
function buildDigestText(msgs: ReadonlyArray<ClaimMessage>, range: DigestRange): string | null {
  const built = buildDigestMessages(msgs, range);
  return built.length > 0 ? built[0].detail : null;
}
