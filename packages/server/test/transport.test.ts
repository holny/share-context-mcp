/**
 * Transport state-machine tests (spec §5.7/§5.8, M2 task-2 brief Step 1):
 * mailbox.listen() WS-first auto downgrade against a REAL relay.
 *
 * CORRECTNESS INVARIANT UNDER TEST (Review Focus #1): ZERO message loss
 * across any WS failure. The test's onNotify handler plays the Task-3
 * broadcaster role — it responds to every notification with
 * mailbox.poll(channelId, store cursor) — and the no-loss scenario drives
 * a WS drop, sends messages into the gap, and asserts the poll catch-up
 * delivers them before WS re-upgrade resumes realtime.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateClaim, type ClaimMessage } from "@share-context-mcp/protocol";
import { startRelay, type RelayHandle } from "@share-context-mcp/relay";
import { RelayMailbox } from "../src/mailbox/relay";
import { Store } from "../src/store";
import { ChannelTransport } from "../src/transport";

// Relay heartbeat for the shared relay: 100ms (prod default 25s). Tests that
// keep a WS alive pass wsDeathTimeoutMs ≥ 2×100ms explicitly.
const PING_MS = 100;

describe("mailbox.listen transport (ws-first auto downgrade)", () => {
  let relay: RelayHandle;
  let baseUrl: string;
  /** Relay lifecycle dir (beforeAll/afterAll) and per-test store dir (beforeEach/afterEach). */
  let relayDir: string;
  let storeDir: string;
  let store: Store;
  let mailbox: RelayMailbox;
  let ch: string;
  /** Listener opened by the current test; stopped in afterEach. */
  let currentListener: { stop(): Promise<void>; markActivity(): void; readonly state: "ws" | "poll"; closeForTest(): void } | null =
    null;

  beforeAll(async () => {
    relayDir = mkdtempSync(join(tmpdir(), "scm-transport-relay-"));
    relay = await startRelay({ port: 0, dbPath: join(relayDir, "relay.db"), pingIntervalMs: PING_MS });
    baseUrl = `http://127.0.0.1:${relay.port}`;
  });

  afterAll(async () => {
    await relay?.stop();
    rmSync(relayDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (currentListener) {
      await currentListener.stop();
      currentListener = null;
    }
    store?.close();
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  });

  // ---- helpers ----

  /** Fresh mailbox + channel per test (fresh store dir per test). */
  async function freshChannel(): Promise<Store> {
    storeDir = mkdtempSync(join(tmpdir(), "scm-transport-store-"));
    store = new Store(join(storeDir, "state.db"));
    mailbox = new RelayMailbox({ baseUrl, store });
    const created = await mailbox.createChannel({ memberName: "self" });
    ch = created.channelId;
    return store;
  }

  async function sendOk(statement: string, target: RelayMailbox = mailbox, targetCh: string = ch): Promise<number> {
    const v = validateClaim({
      statement,
      kind: "progress",
      topic: "transport-test",
      provenance: { member: "self", source: "agent" },
    });
    if (!v.ok) throw new Error(`fixture invalid: ${v.reason}`);
    const r = await target.send(v.msg, targetCh);
    return r.seq;
  }

  interface NotifyRec {
    seq: number;
    at: number;
  }

  interface Handler {
    delivered: ClaimMessage[];
    seen: Set<number>;
    notifyLog: NotifyRec[];
    onNotify: (seq: number) => void;
  }

  /**
   * Task-3-shaped notify handler: on EVERY notification poll since the
   * persisted cursor (the seq is only a wake hint — spec §5.7). Dedupes by
   * seq so overlapping polls are absorbed. `ch`/`mailbox` are captured at
   * call time (pass the channel + mailbox the listener belongs to).
   */
  function makeHandler(targetCh: string, targetMailbox: RelayMailbox, targetStore: Store): Handler {
    const delivered: ClaimMessage[] = [];
    const seen = new Set<number>();
    const notifyLog: NotifyRec[] = [];
    const onNotify = (seq: number): void => {
      notifyLog.push({ seq, at: Date.now() });
      void targetMailbox
        .poll(targetCh, targetStore.getCursor(targetCh))
        .then((r) => {
          for (const m of r.messages) {
            if (typeof m.seq === "number" && !seen.has(m.seq)) {
              seen.add(m.seq);
              delivered.push(m);
            }
          }
        })
        .catch(() => {});
    };
    return { delivered, seen, notifyLog, onNotify };
  }

  async function waitFor(cond: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const statements = (msgs: ClaimMessage[]): string[] => msgs.map((m) => m.statement);

  // ---- tests ----

  test("auto: WS-first — realtime notifications with relay seqs", async () => {
    await freshChannel();
    const h = makeHandler(ch, mailbox, store);
    currentListener = mailbox.listen(ch, h.onNotify, { wsDeathTimeoutMs: 1000 });
    await waitFor(() => currentListener!.state === "ws", 3000, "ws mode");

    expect(await sendOk("first")).toBe(1);
    expect(await sendOk("second")).toBe(2);
    await waitFor(() => h.seen.has(1) && h.seen.has(2), 3000, "delivery of seq 1,2");

    // notify seqs (wake hints) observed both pushes, in relay order
    const pushed = h.notifyLog.map((n) => n.seq).filter((s) => s >= 1);
    expect(pushed).toEqual([1, 2]);
    expect(statements(h.delivered)).toEqual(["first", "second"]);
  });

  test("NO-LOSS invariant: messages sent during a WS drop are caught up by poll, realtime resumes after re-upgrade", async () => {
    await freshChannel();
    const h = makeHandler(ch, mailbox, store);
    currentListener = mailbox.listen(ch, h.onNotify, {
      wsDeathTimeoutMs: 1000,
      probeIntervalMs: 150,
      pollActiveMs: 40,
      pollIdleMs: 40,
    });
    await waitFor(() => currentListener!.state === "ws", 3000, "ws mode");

    expect(await sendOk("before drop")).toBe(1);
    await waitFor(() => h.seen.has(1), 3000, "delivery of seq 1");

    // network drop: close the client socket under the transport's feet
    currentListener.closeForTest();
    await waitFor(() => currentListener!.state === "poll", 3000, "poll downgrade");

    // two messages land while the transport is disconnected
    expect(await sendOk("gap one")).toBe(2);
    expect(await sendOk("gap two")).toBe(3);

    // poll-mode catch-up must deliver both (cursor advances; nothing lost)
    await waitFor(() => h.seen.has(2) && h.seen.has(3), 3000, "catch-up of seq 2,3");

    // periodic probe re-upgrades; realtime resumes
    await waitFor(() => currentListener!.state === "ws", 3000, "ws re-upgrade");
    expect(await sendOk("after recovery")).toBe(4);
    await waitFor(() => h.seen.has(4), 3000, "delivery of seq 4 after re-upgrade");

    expect(h.delivered.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(statements(h.delivered)).toEqual(["before drop", "gap one", "gap two", "after recovery"]);
  });

  test("auto: ws silence beyond the death timeout degrades to poll without any explicit close", async () => {
    await freshChannel();
    // dedicated relay with the heartbeat DISABLED: after hello, the client
    // sees no frames at all — death detection must fire on its own
    const relay2 = await startRelay({ port: 0, dbPath: join(storeDir, "relay2.db"), pingIntervalMs: 0 });
    try {
      const mb2 = new RelayMailbox({ baseUrl: `http://127.0.0.1:${relay2.port}`, store });
      const created = await mb2.createChannel({ memberName: "quiet" });
      const ch2 = created.channelId;
      const h = makeHandler(ch2, mb2, store);

      const l = mb2.listen(ch2, h.onNotify, { wsDeathTimeoutMs: 250, pollActiveMs: 40, pollIdleMs: 40 });
      currentListener = l;
      await waitFor(() => l.state === "ws", 3000, "ws mode");
      await waitFor(() => l.state === "poll", 3000, "death-detection downgrade to poll");

      // degraded mode still loses nothing: a send during silence is caught up
      await sendOk("sent while silent", mb2, ch2);
      await waitFor(() => h.seen.size >= 1, 3000, "catch-up after silence degrade");
      expect(statements(h.delivered)).toEqual(["sent while silent"]);
    } finally {
      await relay2.stop();
    }
  });

  test('mode "poll": pure timer — never touches WS', async () => {
    await freshChannel();
    const h = makeHandler(ch, mailbox, store);
    currentListener = mailbox.listen(ch, h.onNotify, {
      mode: "poll",
      pollActiveMs: 40,
      pollIdleMs: 40,
      probeIntervalMs: 10_000, // far beyond the test window: no probe can rescue a wrong impl
    });
    expect(currentListener.state).toBe("poll");

    expect(await sendOk("via timer")).toBe(1);
    await waitFor(() => h.seen.has(1), 3000, "poll-mode delivery");

    // and it must never have gone up to ws
    await new Promise((r) => setTimeout(r, 300));
    expect(currentListener.state).toBe("poll");
  });

  test('mode "ws": never downgrades to poll, reconnects after a drop', async () => {
    await freshChannel();
    const h = makeHandler(ch, mailbox, store);
    currentListener = mailbox.listen(ch, h.onNotify, {
      mode: "ws",
      wsDeathTimeoutMs: 1000,
      probeIntervalMs: 100,
    });
    await waitFor(() => currentListener!.state === "ws", 3000, "ws mode");

    currentListener.closeForTest();
    let sawPoll = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      if (currentListener.state === "poll") sawPoll = true;
      if (currentListener.state === "ws" && Date.now() - t0 > 100) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(sawPoll).toBe(false);

    expect(await sendOk("ws-only after drop")).toBe(1);
    await waitFor(() => h.seen.has(1), 3000, "delivery after ws-mode reconnect");
  });

  test("auto: WS connect failure degrades to poll (standalone transport)", async () => {
    await freshChannel();
    const h = makeHandler(ch, mailbox, store);
    // real relay, but the token never authenticates → every upgrade is rejected
    const t = new ChannelTransport({
      channelId: ch,
      buildWsUrl: (token) => `ws://127.0.0.1:${relay.port}/channels/${ch}/ws?token=${token}`,
      getToken: () => "not-a-valid-token",
      onNotify: h.onNotify,
      tuning: { pollActiveMs: 40, pollIdleMs: 40, probeIntervalMs: 200 },
    });
    t.start();
    try {
      await waitFor(() => t.state === "poll", 3000, "degrade on rejected upgrade");
      await waitFor(() => h.notifyLog.length >= 1, 3000, "poll-mode wake fired");
      expect(t.state).toBe("poll");
    } finally {
      await t.stop();
    }
  });

  test("activity hook: markActivity() and mailbox.send() both pull the poll interval down to the active one", async () => {
    await freshChannel();
    const h = makeHandler(ch, mailbox, store);
    currentListener = mailbox.listen(ch, h.onNotify, {
      mode: "poll",
      pollActiveMs: 40,
      pollIdleMs: 1500,
      activityWindowMs: 120, // shrink the 60s window so idleness is observable
    });
    // ticks: ~0, 40, 80 (active), then the window expires → idle-paced
    await waitFor(() => h.notifyLog.length >= 4, 3000, "initial ticks");
    const t4 = h.notifyLog[3].at;

    // direct hook: pending idle tick (1500ms away) is rescheduled to 40ms
    await new Promise((r) => setTimeout(r, 30));
    currentListener.markActivity();
    await waitFor(() => h.notifyLog.length >= 5, 3000, "tick after markActivity");
    expect(h.notifyLog[4].at - t4).toBeLessThan(800);

    // send() marks activity too: the next gap must again be far below idle
    await waitFor(() => h.notifyLog.length >= 6, 3000, "tick after idle resumption");
    const t6 = h.notifyLog[5].at;
    await new Promise((r) => setTimeout(r, 30));
    await sendOk("activity via send");
    await waitFor(() => h.notifyLog.length >= 7, 3000, "tick after send");
    expect(h.notifyLog[6].at - t6).toBeLessThan(800);

    // the sent message was delivered through the poll-mode handler
    await waitFor(() => h.seen.has(1), 3000, "poll-mode delivery of the send");
    expect(statements(h.delivered)).toEqual(["activity via send"]);
  });

  test("stop() clears all timers: no notifications afterwards, idempotent", async () => {
    await freshChannel();
    let after = 0;
    const l = mailbox.listen(
      ch,
      () => {
        after++;
      },
      { wsDeathTimeoutMs: 500, probeIntervalMs: 100, pollActiveMs: 30, pollIdleMs: 30 },
    );
    currentListener = l;
    await waitFor(() => l.state === "ws", 3000, "ws mode");
    // let the hello wake land (it fires before stop and must not count)
    await new Promise((r) => setTimeout(r, 100));
    const before = after;

    await l.stop();
    await l.stop(); // idempotent
    currentListener = null;

    await sendOk("after stop");
    await new Promise((r) => setTimeout(r, 400));
    expect(after).toBe(before);
  });

  test("many start/stop cycles leak no timers (subprocess must exit on its own)", async () => {
    await freshChannel();
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "helpers", "transport-leak-probe.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, 25_000);
    const exit = await proc.exited;
    clearTimeout(killer);
    const stderr = await new Response(proc.stderr).text();
    expect(exit, `leak probe exited ${exit}; stderr:\n${stderr}`).toBe(0);
  }, 30_000);
});
