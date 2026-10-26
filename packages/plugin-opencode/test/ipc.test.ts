/**
 * IPC client tests (task-4 brief Step 1): exponential backoff is pure and
 * deterministic; the client reconnects with backoff after a server drop,
 * resumes receiving events after the server comes back, and idles silently
 * when the server socket does not exist.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcClient, nextBackoffMs } from "../src/ipc";
import type { DigestCard } from "../src/coalesce";

const card: DigestCard = {
  type: "digest",
  channelId: "ch-1",
  cardKind: "digest",
  skipped: 0,
  lines: [{ seq: 1, kind: "progress", topic: "t", from: "a", statement: "s" }],
};

function serve(socketPath: string): { server: net.Server; close(): Promise<void> } {
  // Minimal relay standing in for the broadcaster: every line any client
  // writes is fanned out to all connected clients (the IpcClient included).
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("data", (chunk: Buffer) => {
      for (const c of clients) c.write(chunk);
    });
    socket.on("error", () => clients.delete(socket));
    socket.on("close", () => clients.delete(socket));
  });
  const close = () =>
    new Promise<void>((resolve) => {
      for (const c of clients) c.destroy();
      server.close(() => resolve());
    });
  server.listen(socketPath);
  return { server, close };
}

function writeCard(socketPath: string, c: DigestCard): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, () => {
      socket.write(JSON.stringify(c) + "\n", () => {
        socket.end();
        resolve();
      });
    });
    socket.on("error", reject);
  });
}

function until(check: () => boolean, ms = 2000): Promise<void> {
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

describe("nextBackoffMs", () => {
  test("doubles from the base and caps", () => {
    expect(nextBackoffMs(0, { base: 500, cap: 4000 })).toBe(500);
    expect(nextBackoffMs(1, { base: 500, cap: 4000 })).toBe(1000);
    expect(nextBackoffMs(2, { base: 500, cap: 4000 })).toBe(2000);
    expect(nextBackoffMs(3, { base: 500, cap: 4000 })).toBe(4000);
    expect(nextBackoffMs(10, { base: 500, cap: 4000 })).toBe(4000);
  });

  test("never yields zero or negative delays", () => {
    for (let i = 0; i < 20; i++) expect(nextBackoffMs(i)).toBeGreaterThan(0);
  });
});

describe("IpcClient", () => {
  let dir: string;
  let socketPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scm-ipc-"));
    socketPath = join(dir, "ipc.sock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("receives line-delimited digest events once connected", async () => {
    const { server, close } = serve(socketPath);
    const received: DigestCard[] = [];
    const client = new IpcClient({ socketPath, backoff: { base: 10, cap: 40 }, onEvent: (c) => received.push(c) });
    client.start();
    await until(() => client.connected());
    await writeCard(socketPath, card);
    await until(() => received.length === 1);
    expect(received[0].cardKind).toBe("digest");
    client.stop();
    await close();
  }, 5000);

  test("ignores non-digest and malformed lines (whitelist defense in depth)", async () => {
    const { close } = serve(socketPath);
    const received: DigestCard[] = [];
    const client = new IpcClient({ socketPath, backoff: { base: 10, cap: 40 }, onEvent: (c) => received.push(c) });
    client.start();
    await until(() => client.connected());
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(socketPath, () => {
        socket.write("not json\n", () =>
          socket.write(JSON.stringify({ type: "other" }) + "\n", () => {
            socket.end();
            // Half-close only: the relay never ends its side, so don't wait for 'close'.
            setTimeout(resolve, 60);
          }),
        );
      });
      socket.on("error", reject);
    });
    expect(received).toEqual([]);
    client.stop();
    await close();
  }, 5000);

  test("reconnects with backoff after the server drops and resumes delivery", async () => {
    const first = serve(socketPath);
    const received: DigestCard[] = [];
    const client = new IpcClient({ socketPath, backoff: { base: 10, cap: 50 }, onEvent: (c) => received.push(c) });
    client.start();
    await until(() => client.connected());
    const dropsBefore = client.stats.reconnects;
    await first.close(); // server drops → client should retry
    const attemptsBefore = client.stats.attempts;
    await until(() => client.stats.attempts > attemptsBefore, 3000); // retrying while absent
    const second = serve(socketPath); // server returns
    await until(() => client.connected(), 3000);
    await writeCard(socketPath, card);
    await until(() => received.length === 1);
    client.stop();
    await second.close();
  }, 8000);

  test("idles silently while the server socket is absent", async () => {
    const received: DigestCard[] = [];
    const states: string[] = [];
    const client = new IpcClient({
      socketPath: join(dir, "missing.sock"),
      backoff: { base: 5, cap: 20 },
      onEvent: (c) => received.push(c),
      onState: (s) => states.push(s),
    });
    client.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(client.connected()).toBe(false);
    expect(received).toEqual([]);
    expect(states.filter((s) => s === "reconnecting").length).toBeGreaterThan(0);
    client.stop();
  }, 5000);

  test("stop() is idempotent and prevents further reconnects", async () => {
    const client = new IpcClient({ socketPath: join(dir, "nope.sock"), backoff: { base: 5, cap: 10 }, onEvent: () => {} });
    client.start();
    client.stop();
    const attempts = client.stats.attempts;
    await new Promise((r) => setTimeout(r, 50));
    expect(client.stats.attempts).toBe(attempts);
    client.stop();
  }, 5000);
});
