/**
 * Store unit tests (task-4 brief Step 1): machine-key at-rest encryption,
 * per-channel cursor isolation, cache upsert, and `a&b,c&d` search semantics.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { idempotencyKey, type ClaimKind, type ClaimMessage } from "@share-context-mcp/protocol";
import { Store } from "../src/store";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scm-store-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mkMsg(
  seq: number,
  statement: string,
  extra: Partial<ClaimMessage> = {},
): ClaimMessage {
  const base: ClaimMessage = {
    seq,
    ts: "2026-10-25T00:00:00Z",
    statement,
    kind: "progress",
    topic: "t1",
    provenance: { member: "a", source: "agent" },
    idempotencyKey: idempotencyKey(statement, "progress", "t1"),
    ...extra,
  };
  return base;
}

describe("Store", () => {
  test("machine key is created on first run with 0600 and reused after", () => {
    const dbPath = join(dir, "state.db");
    const s1 = new Store(dbPath);
    const keyPath = join(dir, "machine.key");
    const stat = statSync(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(keyPath).length).toBe(32);
    const first = readFileSync(keyPath);
    s1.close();

    const s2 = new Store(dbPath);
    expect(readFileSync(keyPath).equals(first)).toBe(true);
    s2.close();
  });

  test("channel secret roundtrip: password encrypted at rest, decrypts back", () => {
    const store = new Store(join(dir, "state.db"));
    store.upsertChannel({
      channelId: "chabcdefgh12",
      password: "abcd-efgh-ijkl-mnop-qrst",
      memberName: "a",
      epoch: 1,
    });
    const secret = store.getChannelSecret("chabcdefgh12");
    expect(secret).toEqual({
      password: "abcd-efgh-ijkl-mnop-qrst",
      memberName: "a",
      epoch: 1,
    });
    expect(store.getChannelSecret("missingchannel")).toBeNull();

    // at-rest: the raw row must not contain the plaintext password
    const raw = new Database(join(dir, "state.db"));
    const row = raw
      .prepare("SELECT password_enc FROM channels WHERE channel_id = ?")
      .get("chabcdefgh12") as { password_enc: string };
    raw.close();
    expect(row.password_enc).not.toContain("abcd-efgh");
    store.close();
  });

  test("cursors are isolated per channel", () => {
    const store = new Store(join(dir, "state.db"));
    store.upsertChannel({ channelId: "channelone01", password: "p1", memberName: "a", epoch: 1 });
    store.upsertChannel({ channelId: "channeltwo02", password: "p2", memberName: "b", epoch: 1 });

    store.setCursor("channelone01", 5);
    store.setCursor("channeltwo02", 9);
    expect(store.getCursor("channelone01")).toBe(5);
    expect(store.getCursor("channeltwo02")).toBe(9);

    store.setCursor("channelone01", 7);
    expect(store.getCursor("channelone01")).toBe(7);
    expect(store.getCursor("channeltwo02")).toBe(9);

    // unknown channel defaults to 0
    expect(store.getCursor("nosuchchannel")).toBe(0);
    store.close();
  });

  test("cacheMessages upserts by (channel, seq) and searchCache reconstructs newest-first", () => {
    const store = new Store(join(dir, "state.db"));
    const ch = "chabcdefgh12";
    store.upsertChannel({ channelId: ch, password: "p", memberName: "a", epoch: 1 });
    store.cacheMessages(ch, [
      mkMsg(1, "first message"),
      mkMsg(2, "second message", { detail: "long version" }),
      mkMsg(3, "third message", {
        scope: { repo: "share-context-mcp", module: "server" },
        to: "b",
        kind: "decision" as ClaimKind,
      }),
    ]);
    // upsert: seq 2 re-cached with a different statement — no duplicate row
    store.cacheMessages(ch, [mkMsg(2, "second message edited", { detail: "long version" })]);

    const all = store.searchCache(ch, "");
    expect(all.map((m) => m.seq)).toEqual([3, 2, 1]);
    const m2 = all.find((m) => m.seq === 2)!;
    expect(m2.statement).toBe("second message edited");
    expect(m2.detail).toBe("long version");
    const m3 = all.find((m) => m.seq === 3)!;
    expect(m3.scope).toEqual({ repo: "share-context-mcp", module: "server" });
    expect(m3.to).toBe("b");
    expect(m3.kind).toBe("decision");
    expect(m3.provenance).toEqual({ member: "a", source: "agent" });
    expect(m3.idempotencyKey).toBe(idempotencyKey("third message", "decision", "t1"));

    // cache is scoped per channel
    store.upsertChannel({ channelId: "otherchannel", password: "p", memberName: "a", epoch: 1 });
    expect(store.searchCache("otherchannel", "")).toEqual([]);
    store.close();
  });

  test("searchCache implements `a&b,c&d` = (a AND b) OR (c AND d), case-insensitive", () => {
    const store = new Store(join(dir, "state.db"));
    const ch = "chabcdefgh12";
    store.upsertChannel({ channelId: ch, password: "p", memberName: "a", epoch: 1 });
    store.cacheMessages(ch, [
      mkMsg(1, "foo bar"),
      mkMsg(2, "baz qux"),
      mkMsg(3, "other thing", { detail: "has baz inside" }),
      mkMsg(4, "FOO and BAR mixed"),
    ]);

    // (foo AND bar) OR (baz) → m1, m4, m2, m3 — newest first
    const hits = store.searchCache(ch, "foo&bar,baz");
    expect(hits.map((m) => m.seq)).toEqual([4, 3, 2, 1]);

    // (foo AND baz) → no message has both → empty
    expect(store.searchCache(ch, "foo&baz")).toEqual([]);

    // c-group alone: qux → m2 only
    expect(store.searchCache(ch, "qux,missingword").map((m) => m.seq)).toEqual([2]);

    // AND within a group: foo&bar → m1, m4 (both contain both terms)
    expect(store.searchCache(ch, "foo&bar").map((m) => m.seq)).toEqual([4, 1]);
    store.close();
  });

  test("listChannels and rejoinable", () => {
    const store = new Store(join(dir, "state.db"));
    expect(store.listChannels()).toEqual([]);
    store.upsertChannel({ channelId: "channelone01", password: "p1", memberName: "a", epoch: 1 });
    store.upsertChannel({ channelId: "channeltwo02", password: "p2", memberName: "b", epoch: 1 });
    expect(store.listChannels().sort()).toEqual(["channelone01", "channeltwo02"]);
    expect(store.rejoinable().sort()).toEqual(["channelone01", "channeltwo02"]);

    store.removeChannel("channelone01");
    expect(store.listChannels()).toEqual(["channeltwo02"]);
    expect(store.getChannelSecret("channelone01")).toBeNull();
    store.close();
  });

  test("recordCursorFromMessages advances cursor to the max seq seen", () => {
    const store = new Store(join(dir, "state.db"));
    const ch = "chabcdefgh12";
    store.upsertChannel({ channelId: ch, password: "p", memberName: "a", epoch: 1 });
    store.recordCursorFromMessages(ch, []);
    expect(store.getCursor(ch)).toBe(0);
    store.recordCursorFromMessages(ch, [mkMsg(1, "a"), mkMsg(3, "c")]);
    expect(store.getCursor(ch)).toBe(3);
    // never regresses on older re-deliveries
    store.recordCursorFromMessages(ch, [mkMsg(2, "b")]);
    expect(store.getCursor(ch)).toBe(3);
    store.close();
  });
});
