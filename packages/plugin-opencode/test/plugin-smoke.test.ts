/**
 * Plugin smoke test — loads the plugin module the same way the opencode v2
 * fork does (dynamic import of the entry, default export must be
 * { id, setup }), then drives setup() in-process against a minimal fake
 * Context: a real Unix-socket IPC server feeds digest/urgent cards and the
 * test asserts steer injection, tool-result piggyback, and the anti-forget
 * reminder. Full opencode session-level verification stays in Task 5 —
 * this file proves the plugin logic and its wiring against the documented
 * promise-plugin contract (core/src/plugin/promise.ts adapter).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index";
import type { DigestCard } from "../src/coalesce";
import { CARD_SEPARATOR } from "../src/coalesce";

// ---- fake Context pieces (promise-plugin contract, structurally minimal) ----

interface SyntheticCall {
  sessionID: string;
  text: string;
  delivery?: string;
  resume?: boolean;
}

interface RecordedHook {
  name: string;
  callback: (event: any) => Promise<void> | void;
}

function fakeContext() {
  const syntheticCalls: SyntheticCall[] = [];
  const hooks: RecordedHook[] = [];
  const eventQueue: unknown[] = [];
  let wake: (() => void) | null = null;

  const ctx = {
    session: {
      synthetic: async (input: SyntheticCall) => {
        syntheticCalls.push(input);
      },
    },
    tool: {
      hook: (name: string, callback: (event: any) => Promise<void> | void) => {
        hooks.push({ name, callback });
        return Promise.resolve({ dispose: () => {} });
      },
    },
    event: {
      subscribe: () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<unknown>>((resolve) => {
                  if (eventQueue.length > 0) return resolve({ done: false, value: eventQueue.shift() });
                  wake = () => {
                    wake = null;
                    if (eventQueue.length > 0) resolve({ done: false, value: eventQueue.shift() });
                  };
                }),
              return: async () => ({ done: true as const, value: undefined }),
            };
          },
        }) as AsyncIterable<unknown>,
    },
  };

  return {
    ctx,
    syntheticCalls,
    hook(name: string): RecordedHook | undefined {
      return hooks.find((h) => h.name === name);
    },
    pushEvent(event: unknown) {
      eventQueue.push(event);
      wake?.();
    },
  };
}

function serve(socketPath: string): {
  close(): Promise<void>;
  broadcast(payload: unknown): void;
  connections(): number;
} {
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
  });
  server.listen(socketPath);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.destroy();
        server.close(() => resolve());
      }),
    broadcast: (payload: unknown) => {
      const line = JSON.stringify(payload) + "\n";
      for (const c of clients) c.write(line);
    },
    connections: () => clients.size,
  };
}

function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("condition not met in time"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const urgent: DigestCard = {
  type: "digest",
  channelId: "ch-1",
  cardKind: "urgent",
  skipped: 0,
  lines: [{ seq: 7, kind: "question", topic: "api", from: "carol", to: "me", statement: "breaking change?" }],
};
const digest: DigestCard = {
  type: "digest",
  channelId: "ch-1",
  cardKind: "digest",
  skipped: 0,
  lines: [{ seq: 8, kind: "decision", topic: "auth", from: "alice", statement: "use JWT rotation" }],
};

const SESSION = "ses_test-1";

describe("plugin smoke (in-process, promise-plugin contract)", () => {
  let dir: string;
  let socketPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scm-plugin-"));
    socketPath = join(dir, "ipc.sock");
  });

  afterEach(() => {
    delete process.env.SHARE_CONTEXT_PLUGIN;
    delete process.env.SHARE_CONTEXT_IPC_SOCKET;
    rmSync(dir, { recursive: true, force: true });
  });

  test("module shape matches what the fork loader requires", () => {
    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.length).toBeGreaterThan(0);
    expect(typeof plugin.setup).toBe("function");
  });

  test("resolves as a local directory plugin exactly the way the fork loader does", () => {
    // packages/plugin/host.ts resolve(): Bun.resolveSync("<dir>/index")
    // for server entrypoints of configured local (directory) plugins.
    const dir = join(import.meta.dir, "..");
    const entry = Bun.resolveSync(join(dir, "index"), dir);
    expect(entry.endsWith("index.ts")).toBe(true);
  });

  test("urgent card → session.synthetic with delivery steer", async () => {
    process.env.SHARE_CONTEXT_IPC_SOCKET = socketPath;
    const server = serve(socketPath);
    const f = fakeContext();
    const cleanup = await plugin.setup(f.ctx as never);
    await until(() => server.connections() === 1);
    // Establish the active session the same way real traffic would.
    await f.hook("execute.before")!.callback({
      tool: "read",
      sessionID: SESSION,
      agent: "ag",
      messageID: "msg1",
      id: "c1",
      input: {},
    });
    server.broadcast(urgent);
    await until(() => f.syntheticCalls.length === 1);
    const call = f.syntheticCalls[0];
    expect(call.sessionID).toBe(SESSION); // routed to the last active session
    expect(call.delivery).toBe("steer");
    expect(call.text).toContain("📬 协作通道紧急消息（@你）");
    expect(call.text).toContain("carol");
    if (cleanup) await cleanup();
    await server.close();
  });

  test("digest card → piggybacked onto the next tool result, then cleared", async () => {
    process.env.SHARE_CONTEXT_IPC_SOCKET = socketPath;
    const server = serve(socketPath);
    const f = fakeContext();
    const cleanup = await plugin.setup(f.ctx as never);
    await until(() => server.connections() === 1);
    // Make the session known to the plugin via a tool.execute.before event.
    await f.hook("execute.before")!.callback({
      tool: "read",
      sessionID: SESSION,
      agent: "ag",
      messageID: "msg1",
      id: "c1",
      input: {},
    });
    server.broadcast(digest);

    const after = f.hook("execute.after")!;
    let first = "";
    for (let i = 0; i < 100; i++) {
      const result = { content: "tool output", metadata: {} };
      await after.callback({
        tool: "read",
        sessionID: SESSION,
        agent: "ag",
        messageID: "m",
        id: `c${i}`,
        input: {},
        status: "completed",
        result,
      });
      if (String(result.content).includes("📋 协作通道")) {
        first = String(result.content);
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(first).toContain(CARD_SEPARATOR);
    expect(first).toContain("📋 协作通道：1 条新消息");
    expect(first).toContain("alice: use JWT rotation");
    expect(first).toContain("用 fetch_updates 展开详情");

    // pending was cleared — the next tool result is untouched
    const second = { content: "plain", metadata: {} };
    await after.callback({ tool: "read", sessionID: SESSION, agent: "ag", messageID: "m", id: "cz", input: {}, status: "completed", result: second });
    expect(second.content).toBe("plain");
    if (cleanup) await cleanup();
    await server.close();
  }, 5000);

  test("anti-forget: writes without share → reminder when the next turn starts, resets after", async () => {
    process.env.SHARE_CONTEXT_IPC_SOCKET = join(dir, "absent.sock");
    const f = fakeContext();
    const cleanup = await plugin.setup(f.ctx as never);
    const before = f.hook("execute.before")!;
    const after = f.hook("execute.after")!;
    const event = (tool: string, id: string) => ({ tool, sessionID: SESSION, agent: "ag", messageID: "m", id, input: {} });

    await before.callback(event("edit", "c1"));
    await after.callback({ ...event("edit", "c1"), status: "completed", result: { content: "ok" } });

    // next turn starts (session.execution.started) → reminder judged + injected
    f.pushEvent({ type: "session.execution.started", data: { sessionID: SESSION } });
    await until(() => f.syntheticCalls.length === 1);
    expect(f.syntheticCalls[0].text).toContain("share_update");
    expect(f.syntheticCalls[0].resume).toBe(false);

    // counters reset: a second turn start with no actions → no reminder
    f.pushEvent({ type: "session.execution.started", data: { sessionID: SESSION } });
    await new Promise((r) => setTimeout(r, 60));
    expect(f.syntheticCalls.length).toBe(1);

    if (cleanup) await cleanup();
  });

  test("anti-forget: read-only turn → no reminder; shared turn → no reminder", async () => {
    process.env.SHARE_CONTEXT_IPC_SOCKET = join(dir, "absent.sock");
    const f = fakeContext();
    const cleanup = await plugin.setup(f.ctx as never);
    const before = f.hook("execute.before")!;
    const after = f.hook("execute.after")!;
    const event = (tool: string, id: string) => ({ tool, sessionID: SESSION, agent: "ag", messageID: "m", id, input: {} });
    // Real hosts separate turns by seconds of model latency; the event pump
    // drains in microseconds. The settle below mirrors that ordering.
    const settle = () => new Promise((r) => setTimeout(r, 20));

    // read-only turn
    await before.callback(event("read", "c1"));
    await after.callback({ ...event("read", "c1"), status: "completed", result: { content: "ok" } });
    f.pushEvent({ type: "session.execution.started", data: { sessionID: SESSION } });
    await settle();

    // turn that shared via share_update
    await before.callback(event("share_update", "c2"));
    await after.callback({ ...event("share_update", "c2"), status: "completed", result: { content: "ok" } });
    await before.callback(event("edit", "c3"));
    await after.callback({ ...event("edit", "c3"), status: "completed", result: { content: "ok" } });
    f.pushEvent({ type: "session.execution.started", data: { sessionID: SESSION } });
    await settle();

    expect(f.syntheticCalls).toEqual([]);
    if (cleanup) await cleanup();
  });

  test("boundary race guard: idle events neither trigger nor reset the judgment", async () => {
    process.env.SHARE_CONTEXT_IPC_SOCKET = join(dir, "absent.sock");
    const f = fakeContext();
    const cleanup = await plugin.setup(f.ctx as never);
    const before = f.hook("execute.before")!;
    const after = f.hook("execute.after")!;
    const event = (tool: string, id: string) => ({ tool, sessionID: SESSION, agent: "ag", messageID: "m", id, input: {} });

    // A writes-without-share turn; idle/status boundary events arrive around
    // the hooks exactly the way async delivery delivered them in the wild.
    await before.callback(event("edit", "c1"));
    f.pushEvent({ type: "session.status", data: { sessionID: SESSION, status: { type: "idle" } } });
    f.pushEvent({ type: "session.idle", data: { sessionID: SESSION } });
    await after.callback({ ...event("edit", "c1"), status: "completed", result: { content: "ok" } });
    f.pushEvent({ type: "session.status", data: { sessionID: SESSION, status: { type: "idle" } } });

    await new Promise((r) => setTimeout(r, 80));
    expect(f.syntheticCalls).toEqual([]); // idle must not judge mid-turn

    // the real judge point still sees the turn's actions
    f.pushEvent({ type: "session.execution.started", data: { sessionID: SESSION } });
    await until(() => f.syntheticCalls.length === 1);
    expect(f.syntheticCalls[0].text).toContain("share_update");

    if (cleanup) await cleanup();
  });

  test("disabled via env → no hooks registered, setup is a no-op", async () => {
    process.env.SHARE_CONTEXT_PLUGIN = "off";
    process.env.SHARE_CONTEXT_IPC_SOCKET = join(dir, "unused.sock");
    const f = fakeContext();
    const cleanup = await plugin.setup(f.ctx as never);
    expect(f.hook("execute.after")).toBeUndefined();
    expect(cleanup).toBeUndefined();
  });

  test("turn boundary uses the fork's execution events (session.execution.started)", async () => {
    process.env.SHARE_CONTEXT_IPC_SOCKET = join(dir, "absent.sock");
    const f = fakeContext();
    const cleanup = await plugin.setup(f.ctx as never);
    const after = f.hook("execute.after")!;
    await after.callback({ tool: "write", sessionID: SESSION, agent: "ag", messageID: "m", id: "c1", input: {}, status: "completed", result: { content: "ok" } });
    f.pushEvent({ type: "session.execution.started", data: { sessionID: SESSION } });
    await until(() => f.syntheticCalls.length === 1);
    expect(f.syntheticCalls[0].text).toContain("share_update");
    if (cleanup) await cleanup();
  });
});
