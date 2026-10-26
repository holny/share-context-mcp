/**
 * Pure digest-card coalescing and rendering for the plugin's pending slot
 * (spec §5.4). The server-side broadcaster already coalesces per channel
 * window; this module merges the cards that accumulated in the plugin's
 * pending slot (several windows can pass between two tool calls) and renders
 * the summary card text in the M1 style: concise one-liner + per-line
 * bullets + "用 fetch_updates 展开详情" hint.
 *
 * No mutation, no I/O — fully unit-testable.
 */

/** One sanitized digest line — mirrors the broadcaster's locked whitelist. */
export interface DigestLine {
  seq: number;
  kind: string;
  topic: string;
  from: string;
  to?: string;
  statement: string;
}

/** The locked event shape the broadcaster writes to the IPC socket. */
export interface DigestCard {
  type: "digest";
  channelId: string;
  cardKind: "digest" | "urgent";
  lines: DigestLine[];
  skipped: number;
}

/** Piggyback separator prepended when a card is appended to a tool result. */
export const CARD_SEPARATOR = "\n\n---\n";

/** Bullets per card beyond which the render collapses to the one-liner. */
export const MAX_BULLET_LINES = 8;

/** Expand hint — the M1 tool name the agent should call to see full text. */
export const EXPAND_HINT = "用 fetch_updates 展开详情";

/**
 * Merge cards accumulated in the pending slot: lines in seq order with
 * duplicates collapsed (first occurrence wins — the earliest card that
 * carried a seq keeps its text), skipped counts summed, kind escalates to
 * "urgent" if any card was urgent.
 */
export function mergeCards(cards: DigestCard[]): DigestCard | null {
  if (cards.length === 0) return null;
  const seen = new Set<number>();
  const lines: DigestLine[] = [];
  let skipped = 0;
  let urgent = false;
  for (const card of cards) {
    skipped += card.skipped;
    if (card.cardKind === "urgent") urgent = true;
    for (const line of card.lines) {
      if (seen.has(line.seq)) continue;
      seen.add(line.seq);
      lines.push(line);
    }
  }
  lines.sort((a, b) => a.seq - b.seq);
  return { type: "digest", channelId: cards[0].channelId, cardKind: urgent ? "urgent" : "digest", lines, skipped };
}

/** Count directed lines ("@你" — the broadcaster only keeps to === me). */
export function mentionsCount(lines: DigestLine[]): number {
  return lines.filter((l) => l.to !== undefined).length;
}

function head(card: DigestCard, total: number): string {
  if (card.cardKind === "urgent") return "📬 协作通道紧急消息（@你）";
  const mentions = mentionsCount(card.lines);
  return `📋 协作通道：${total} 条新消息${mentions > 0 ? `（${mentions} 条 @你）` : ""}`;
}

/**
 * Render the card body WITHOUT the piggyback separator (the injection site
 * adds "\n\n---\n" when appending to a tool result; urgent steer injection
 * uses the body directly).
 */
export function renderDigestCard(card: DigestCard): string {
  const total = card.lines.length;
  const parts: string[] = [head(card, total)];
  if (total > 0 && total <= MAX_BULLET_LINES) {
    for (const line of card.lines) {
      parts.push(`- [#${line.seq}·${line.kind}·${line.topic}] ${line.from}: ${line.statement}`);
    }
  } else if (total > MAX_BULLET_LINES) {
    for (const line of card.lines.slice(0, MAX_BULLET_LINES)) {
      parts.push(`- [#${line.seq}·${line.kind}·${line.topic}] ${line.from}: ${line.statement}`);
    }
    parts.push(`…（其余 ${total - MAX_BULLET_LINES} 条略）`);
  }
  if (card.skipped > 0) parts.push(`另有 ${card.skipped} 条未能解密。`);
  parts.push(EXPAND_HINT);
  return parts.join("\n");
}
