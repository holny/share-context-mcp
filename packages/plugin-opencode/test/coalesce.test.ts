/**
 * Coalesce/render tests (task-4 brief Step 1, Review Focus #3): card merging
 * for the plugin-side pending slot and digest card rendering in the M1 style
 * ("用 fetch_updates 展开" hint, @你 count, skipped suffix, bullet cap).
 */
import { describe, expect, test } from "bun:test";
import {
  CARD_SEPARATOR,
  MAX_BULLET_LINES,
  mergeCards,
  mentionsCount,
  renderDigestCard,
  type DigestCard,
} from "../src/coalesce";

function card(extra: Partial<DigestCard> = {}): DigestCard {
  return {
    type: "digest",
    channelId: "ch-1",
    cardKind: "digest",
    skipped: 0,
    lines: [
      { seq: 12, kind: "decision", topic: "auth", from: "alice", statement: "use JWT rotation" },
    ],
    ...extra,
  };
}

describe("mergeCards", () => {
  test("empty input yields null", () => {
    expect(mergeCards([])).toBeNull();
  });

  test("single card passes through unchanged", () => {
    const c = card();
    expect(mergeCards([c])).toEqual(c);
  });

  test("merges lines in seq order and sums skipped", () => {
    const a = card({
      lines: [{ seq: 20, kind: "progress", topic: "t", from: "bob", statement: "b" }],
      skipped: 2,
    });
    const b = card({
      lines: [
        { seq: 5, kind: "howto", topic: "x", from: "carol", statement: "c" },
        { seq: 20, kind: "progress", topic: "t", from: "bob", statement: "b-dup" },
      ],
      skipped: 1,
    });
    const merged = mergeCards([a, b]);
    expect(merged).not.toBeNull();
    expect(merged!.cardKind).toBe("digest");
    expect(merged!.skipped).toBe(3);
    // seq 5 first, and the duplicate seq 20 collapsed (first occurrence wins).
    expect(merged!.lines.map((l) => l.seq)).toEqual([5, 20]);
    expect(merged!.lines[1].statement).toBe("b");
  });

  test("merged card keeps urgent kind when any card is urgent", () => {
    const merged = mergeCards([card(), card({ cardKind: "urgent" })]);
    expect(merged!.cardKind).toBe("urgent");
  });
});

describe("mentionsCount", () => {
  test("counts only directed lines", () => {
    expect(
      mentionsCount([
        { seq: 1, kind: "question", topic: "t", from: "a", statement: "s" },
        { seq: 2, kind: "question", topic: "t", from: "a", to: "me", statement: "s" },
        { seq: 3, kind: "question", topic: "t", from: "a", to: "me", statement: "s" },
      ]),
    ).toBe(2);
  });
});

describe("renderDigestCard", () => {
  test("digest card renders header with counts, bullets, and the expand hint", () => {
    const c = card({
      lines: [
        { seq: 12, kind: "decision", topic: "auth", from: "alice", statement: "use JWT rotation" },
        { seq: 13, kind: "howto", topic: "db", from: "bob", to: "me", statement: "index the cursor" },
      ],
      skipped: 1,
    });
    const text = renderDigestCard(c);
    expect(text).toContain("📋 协作通道：2 条新消息（1 条 @你）");
    expect(text).toContain("> #12·decision·auth alice: use JWT rotation");
    expect(text).toContain("> #13·howto·db bob: index the cursor");
    expect(text).toContain("另有 1 条未能解密。");
    expect(text).toContain("用 fetch_updates 展开详情");
    // No piggyback separator inside the body — the injection site adds it.
    expect(text.startsWith(CARD_SEPARATOR)).toBe(false);
  });

  test("header omits the mention count when zero", () => {
    const text = renderDigestCard(card());
    expect(text).toContain("📋 协作通道：1 条新消息");
    expect(text).not.toContain("@你）");
  });

  test("urgent card uses the urgent header", () => {
    const text = renderDigestCard(
      card({ cardKind: "urgent", lines: [{ seq: 9, kind: "question", topic: "api", from: "carol", to: "me", statement: "breaking change?" }] }),
    );
    expect(text).toContain("📬 协作通道紧急消息（@你）");
    expect(text).toContain("carol");
    expect(text).toContain("用 fetch_updates 展开详情");
  });

  test(`caps bullets at ${MAX_BULLET_LINES} and marks truncation`, () => {
    const lines = Array.from({ length: MAX_BULLET_LINES + 3 }, (_, i) => ({
      seq: i + 1,
      kind: "progress",
      topic: "t",
      from: "u",
      statement: `s${i}`,
    }));
    const text = renderDigestCard(card({ lines }));
    expect(text).toContain(`📋 协作通道：${MAX_BULLET_LINES + 3} 条新消息`);
    expect(text).toContain(`s${MAX_BULLET_LINES - 1}`);
    expect(text).not.toContain(`s${MAX_BULLET_LINES}`);
    expect(text).toContain(`…（其余 ${3} 条略）`);
  });

  test("statements are never truncated again beyond the 80-char server cap", () => {
    const statement = "x".repeat(80);
    const text = renderDigestCard(card({ lines: [{ seq: 1, kind: "progress", topic: "t", from: "u", statement }] }));
    expect(text).toContain(statement);
  });
});
