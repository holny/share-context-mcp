/**
 * Broadcaster tests (task-3 brief Step 1): fake mailbox + real Store, tiny
 * coalescing window (30ms) for determinism. Covers: coalescing, @me urgent
 * bypass, subscription filtering, event payload whitelist (Review Focus #2),
 * cursor advancement during the window (#4), and multi-client fan-out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateClaim, type ClaimMessage } from "@share-context-mcp/protocol";
import type { Mailbox, MailboxListener, PollResult } from "../src/mailbox/types";
import { Broadcaster, passesFilters } from "../src/broadcaster";
import { Store } from "../src/store";

const WINDOW_MS = 30;

function claim(statement: string, member: string, extra: Record<string, unknown> = {}): ClaimMessage {
  const result = validateClaim({
    statement,
    kind: "progress",
    topic: "t1",
    provenance: { member, source: "agent" },
    ...extra,
  });
  if (!result.ok) throw new Error(`test helper claim invalid: ${result.reason}`);
  return result.msg;
}

/**
 * Fake mailbox: Broadcaster consumes only poll() + listen(); poll mimics the
 * real RelayMailbox contract — return window messages and high-water the
 * store cursor over the whole returned batch BEFORE any downstream filtering.
 */
class FakeMailbox implements Pick<Mailbox, "poll" | "listen"> {
  private readonly queues = new Map<string, ClaimMessage[]>();
  private readonly handlers = new Map<string, (seq: number) => void>();
  private readonly skippedByChannel = new Map<string, number>();
  /** Number of listen() registrations (per channel) — for idempotency asserts. */
  readonly listenCalls = new Map<string, number>();
  private stopped = false;

  constructor(private readonly store: Store) {}

  enqueue(channelId: string, msg: ClaimMessage): void {
    const q = this.queues.get(channelId) ?? [];
    q.push(msg);
    this.queues.set(channelId, q);
  }

  markSkipped(channelId: string, n: number): void {
    this.skippedByChannel.set(channelId, (this.skippedByChannel.get(channelId) ?? 0) + n);
  }

  /** Simulate a wake hint (may fire with a stale seq — never gates correctness). */
  notify(channelId: string): void {
    this.handlers.get(channelId)?.(0);
  }

  async poll(channelId: string, since: number): Promise<PollResult> {
    const q = this.queues.get(channelId) ?? [];
    const messages = q.filter((m) => typeof m.seq === "number" && (m.seq as number) > since);
    // Real mailbox contract: cache + advance the cursor over the whole window.
    if (messages.length > 0) this.store.recordCursorFromMessages(channelId, messages);
    return { messages, skipped: this.skippedByChannel.get(channelId) ?? 0 };
  }

  listen(channelId: string, onNotify: (seq: number) => void): MailboxListener {
    this.listenCalls.set(channelId, (this.listenCalls.get(channelId) ?? 0) + 1);
    this.handlers.set(channelId, onNotify);
    return {
      stop: async () => {
        this.stopped = true;
        this.handlers.delete(channelId);
      },
      markActivity: () => {},
      get state() {
        return "poll" as const;
      },
      closeForTest: () => {},
    };
  }

  wasStopped(): boolean {
    return this.stopped;
  }
}

/** Line-oriented Unix-socket client collecting parsed events. */
class IpcClient {
  private readonly socket: net.Socket;
  private buffer = "";
  readonly events: Array<Record<string, unknown>> = [];

  constructor(socketPath: string) {
    this.socket = net.connect(socketPath);
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim().length > 0) this.events.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  async ready(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.removeListener("error", () => {});
  }

  close(): void {
    this.socket.destroy();
  }
}

async function waitFor<T>(probe: () => T | undefined | null, what: string, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Broadcaster", () => {
  let dir: string;
  let store: Store;
  let mailbox: FakeMailbox;
  let clients: IpcClient[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scm-bc-"));
    store = new Store(join(dir, "state.db"));
    store.upsertChannel({ channelId: "ch1", password: "pw-one", memberName: "me", epoch: 1 });
    mailbox = new FakeMailbox(store);
    clients = [];
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(opts: { socketPath?: string } = {}) {
    const handle = await new Broadcaster({
      socketPath: opts.socketPath ?? join(dir, "ipc.sock"),
      windowMs: WINDOW_MS,
    }).start({ store, mailbox });
    return handle;
  }

  async function connectClient(socketPath: string): Promise<IpcClient> {
    const c = new IpcClient(socketPath);
    await c.ready();
    clients.push(c);
    return c;
  }

  test("3 messages in one window coalesce into a single digest card with lines in seq order", async () => {
    const { socketPath, stop } = await start();
    const client = await connectClient(socketPath);

    mailbox.enqueue("ch1", claim("one", "alice", { seq: 1 }));
    mailbox.enqueue("ch1", claim("two", "bob", { seq: 2 }));
    mailbox.enqueue("ch1", claim("three", "carol", { seq: 3 }));
    mailbox.notify("ch1");

    const evt = (await waitFor(() => client.events[0], "digest card")) as {
      type: string;
      channelId: string;
      cardKind: string;
      lines: Array<{ seq: number; statement: string; from: string }>;
      skipped: number;
    };
    expect(evt.type).toBe("digest");
    expect(evt.channelId).toBe("ch1");
    expect(evt.cardKind).toBe("digest");
    expect(evt.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(evt.lines.map((l) => l.statement)).toEqual(["one", "two", "three"]);
    expect(evt.lines.map((l) => l.from)).toEqual(["alice", "bob", "carol"]);
    expect(evt.skipped).toBe(0);

    // a second batch after the window produces a NEW card, not a merge
    mailbox.enqueue("ch1", claim("four", "alice", { seq: 4 }));
    mailbox.notify("ch1");
    const evt2 = await waitFor(() => client.events[1], "second digest card");
    expect((evt2.lines as Array<{ seq: number }>).map((l) => l.seq)).toEqual([4]);

    await stop();
  });

  test("@me message emits an immediate urgent card bypassing the window", async () => {
    const { socketPath, stop } = await start();
    const client = await connectClient(socketPath);

    mailbox.enqueue("ch1", claim("help me", "alice", { seq: 1, to: "me" }));
    mailbox.notify("ch1");

    const evt = (await waitFor(() => client.events[0], "urgent card")) as {
      cardKind: string;
      lines: Array<{ seq: number; to?: string }>;
    };
    expect(evt.cardKind).toBe("urgent");
    expect(evt.lines).toHaveLength(1);
    expect(evt.lines[0].seq).toBe(1);
    expect(evt.lines[0].to).toBe("me");
    await stop();
  });

  test("urgent arriving during a pending window flushes the digest card first", async () => {
    const { socketPath, stop } = await start();
    const client = await connectClient(socketPath);

    mailbox.enqueue("ch1", claim("normal", "alice", { seq: 1 }));
    mailbox.notify("ch1");
    // urgent lands while the 30ms window is still pending
    mailbox.enqueue("ch1", claim("urgent!", "bob", { seq: 2, to: "me" }));
    mailbox.notify("ch1");

    const first = await waitFor(() => client.events[0], "flushed digest card");
    expect(first.cardKind).toBe("digest");
    expect((first.lines as Array<{ seq: number }>).map((l) => l.seq)).toEqual([1]);
    const second = await waitFor(() => client.events[1], "urgent card");
    expect(second.cardKind).toBe("urgent");
    expect((second.lines as Array<{ seq: number }>).map((l) => l.seq)).toEqual([2]);
    await stop();
  });

  test("subscription kind filter drops unmatched kinds and messages aimed at others", async () => {
    store.setSubscription("ch1", [{ kinds: ["question"] }]);
    const { socketPath, stop } = await start();
    const client = await connectClient(socketPath);

    mailbox.enqueue("ch1", claim("noisy progress", "alice", { seq: 1, kind: "progress" }));
    mailbox.enqueue("ch1", claim("for someone else", "alice", { seq: 2, kind: "question", to: "alice" }));
    mailbox.notify("ch1");
    await new Promise((r) => setTimeout(r, WINDOW_MS * 4));
    expect(client.events).toHaveLength(0);

    // @me passes regardless of the subscription
    mailbox.enqueue("ch1", claim("at me", "bob", { seq: 3, kind: "progress", to: "me" }));
    mailbox.notify("ch1");
    const urgent = await waitFor(() => client.events[0], "urgent card despite filter");
    expect(urgent.cardKind).toBe("urgent");

    // matching kind passes
    mailbox.enqueue("ch1", claim("a question", "carol", { seq: 4, kind: "question" }));
    mailbox.notify("ch1");
    const digest = await waitFor(() => client.events[1], "filtered digest card");
    expect(digest.cardKind).toBe("digest");
    expect((digest.lines as Array<{ statement: string }>).map((l) => l.statement)).toEqual(["a question"]);
    await stop();
  });

  test("event payload whitelist: exact key sets, statement truncation, no password/ciphertext", async () => {
    const { socketPath, stop } = await start();
    const client = await connectClient(socketPath);

    const long = "x".repeat(200);
    mailbox.enqueue(
      "ch1",
      claim(long, "alice", {
        seq: 1,
        kind: "decision",
        topic: "auth",
        detail: "internal detail that must never leak",
        scope: { repo: "share-context-mcp" },
        to: "me",
      }),
    );
    mailbox.markSkipped("ch1", 2);
    mailbox.notify("ch1");

    const evt = await waitFor(() => client.events[0], "urgent card");
    const raw = JSON.stringify(evt);
    // Review Focus #2: hard whitelist — no secrets, no internals, anywhere
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("ciphertext");
    expect(raw).not.toContain("pw-one");
    expect(raw).not.toContain("internal detail");
    expect(Object.keys(evt).sort()).toEqual(["cardKind", "channelId", "lines", "skipped", "type"]);
    const lines = evt.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort()).toEqual(["from", "kind", "seq", "statement", "to", "topic"]);
    expect(lines[0].statement).toBe("x".repeat(80));
    expect(lines[0].from).toBe("alice");
    expect(evt.skipped).toBe(2);
    await stop();
  });

  test("cursor advances during the coalescing window (coalescing must not gate the cursor)", async () => {
    const { socketPath, stop } = await start();
    const client = await connectClient(socketPath);

    mailbox.enqueue("ch1", claim("a", "alice", { seq: 1 }));
    mailbox.enqueue("ch1", claim("b", "bob", { seq: 2 }));
    mailbox.enqueue("ch1", claim("c", "carol", { seq: 3 }));
    mailbox.notify("ch1");

    // before the window flushes (well inside 30ms), the cursor is already at 3
    await waitFor(() => (store.getCursor("ch1") === 3 ? true : undefined), "cursor advance");
    const evt = await waitFor(() => client.events[0], "digest card");
    expect((evt.lines as Array<{ seq: number }>).map((l) => l.seq)).toEqual([1, 2, 3]);
    await stop();
  });

  test("two connected clients both receive every event", async () => {
    const { socketPath, stop } = await start();
    const c1 = await connectClient(socketPath);
    const c2 = await connectClient(socketPath);

    mailbox.enqueue("ch1", claim("hello both", "alice", { seq: 1 }));
    mailbox.notify("ch1");

    await waitFor(() => c1.events[0], "client 1 event");
    await waitFor(() => c2.events[0], "client 2 event");
    expect(c1.events).toHaveLength(1);
    expect(c2.events).toHaveLength(1);

    // client disconnect cleanup: c1 leaves, c2 still receives the next card
    c1.close();
    clients = clients.filter((c) => c !== c1);
    mailbox.enqueue("ch1", claim("second", "alice", { seq: 2 }));
    mailbox.notify("ch1");
    await waitFor(() => c2.events[1], "client 2 second event");
    expect(c2.events).toHaveLength(2);
    await stop();
  });

  test("start recovers from a stale socket file at the path", async () => {
    const stalePath = join(dir, "stale.sock");
    writeFileSync(stalePath, "not a socket");
    const { socketPath, stop } = await start({ socketPath: stalePath });
    expect(socketPath).toBe(stalePath);
    const client = await connectClient(stalePath);
    mailbox.enqueue("ch1", claim("after stale", "alice", { seq: 1 }));
    mailbox.notify("ch1");
    await waitFor(() => client.events[0], "event after stale-socket recovery");
    await stop();
  });

  test("stop() tears down listeners, clients, and the server", async () => {
    const { socketPath, stop } = await start();
    const client = await connectClient(socketPath);
    await stop();
    expect(mailbox.wasStopped()).toBe(true);
    // server no longer accepts connections
    const rejected = await new Promise<string | null>((resolve) => {
      const s = net.connect(socketPath);
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      s.once("connect", () => {
        s.destroy();
        resolve(null);
      });
    });
    expect(rejected).not.toBeNull();
    client.close();
  });

  test("addChannel is idempotent — duplicate registration never double-listens or double-emits", async () => {
    const socketPath = join(dir, "ipc.sock");
    const broadcaster = new Broadcaster({ socketPath, windowMs: WINDOW_MS });
    await broadcaster.start({ store, mailbox });
    broadcaster.addChannel("ch1"); // already registered by start()
    broadcaster.addChannel("ch1"); // and again
    expect(mailbox.listenCalls.get("ch1")).toBe(1);

    const client = await connectClient(socketPath);
    mailbox.enqueue("ch1", claim("once only", "alice", { seq: 1 }));
    mailbox.notify("ch1");
    const evt = (await waitFor(() => client.events[0], "digest card")) as {
      lines: Array<{ seq: number }>;
    };
    expect(evt.lines.map((l) => l.seq)).toEqual([1]);
    await new Promise((r) => setTimeout(r, WINDOW_MS * 4));
    expect(client.events).toHaveLength(1); // no duplicate card from a second listener
    await broadcaster.stop();
  });
});

describe("passesFilters branches (subscription filter coverage)", () => {
  test("topic exact-match: positive and negative", () => {
    const filters = [{ topic: "auth" }];
    expect(passesFilters(claim("s", "a", { seq: 1, topic: "auth" }), filters, "me")).toBe(true);
    expect(passesFilters(claim("s", "a", { seq: 2, topic: "authx" }), filters, "me")).toBe(false);
    expect(passesFilters(claim("s", "a", { seq: 3, topic: "other" }), filters, "me")).toBe(false);
  });

  test("scopePrefix: positive and negative", () => {
    const filters = [{ scopePrefix: "repo-x" }];
    expect(passesFilters(claim("s", "a", { seq: 1, scope: { repo: "repo-x" } }), filters, "me")).toBe(true);
    // prefix match on a longer value also passes
    expect(passesFilters(claim("s", "a", { seq: 2, scope: { repo: "repo-x-infra" } }), filters, "me")).toBe(true);
    // unrelated scope value drops
    expect(passesFilters(claim("s", "a", { seq: 3, scope: { repo: "other-repo" } }), filters, "me")).toBe(false);
    // no scope at all drops
    expect(passesFilters(claim("s", "a", { seq: 4 }), filters, "me")).toBe(false);
  });

  test("multiple filters: any matching filter passes", () => {
    const filters = [{ kinds: ["decision"] }, { topic: "auth" }];
    expect(passesFilters(claim("s", "a", { seq: 1, kind: "progress", topic: "auth" }), filters, "me")).toBe(true);
    expect(passesFilters(claim("s", "a", { seq: 2, kind: "decision", topic: "other" }), filters, "me")).toBe(true);
    expect(passesFilters(claim("s", "a", { seq: 3, kind: "progress", topic: "other" }), filters, "me")).toBe(false);
  });
});
