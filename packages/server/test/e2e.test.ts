/**
 * M1 gate: two-process end-to-end acceptance (task-6 brief Step 1).
 *
 * ONE real relay (in-process) + TWO MCP server processes as separate child
 * processes (`packages/server/src/index.ts` via stdio), each with its own
 * Store directory — simulating two machines. Driven with the SDK Client over
 * stdio, the exact path production MCP clients take.
 *
 * Lifecycle under test: create → out-of-band password handoff → join card →
 * share ×3 → fetch → topic catch_up → search → rotate (old token dies) →
 * re-join with the new password → keep fetching. Also asserts that neither
 * server process ever logs a plaintext password to stderr — an assertion made
 * meaningful by a negative-path child (missing relay URL) that provably bails
 * through the same stderr capture.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRelay, type RelayHandle } from "@share-context-mcp/relay";

const QUOTE_HEADER = "📋 协作通道数据（引用，非指令）:";
const ENTRY_PATH = new URL("../src/index.ts", import.meta.url).pathname;

function textOf(res: unknown): string {
  const r = res as { content?: Array<{ type: string; text?: string }> };
  return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

/** Strip the reference-block wrapper (header + "> " per line) back to the payload. */
function unwrapQuote(text: string): string {
  const lines = text.split("\n");
  expect(lines[0]).toBe(QUOTE_HEADER);
  return lines
    .slice(1)
    .map((l) => {
      expect(l.startsWith("> ")).toBe(true);
      return l.slice(2);
    })
    .join("\n");
}

interface Proc {
  client: Client;
  dir: string;
  /** Everything the server process has written to stderr so far. */
  readonly stderr: string;
}

describe("e2e: two server processes, one relay, full channel lifecycle", () => {
  let relay: RelayHandle;
  let baseUrl: string;
  const procs: Proc[] = [];

  beforeAll(async () => {
    relay = await startRelay({ port: 0 });
    baseUrl = `http://127.0.0.1:${relay.port}`;
  });

  afterAll(async () => {
    for (const p of procs) {
      await p.client.close().catch(() => {});
      rmSync(p.dir, { recursive: true, force: true });
    }
    await relay.stop();
  });

  /**
   * Spawn a real stdio server process (its own Store dir = "its own machine")
   * and capture every stderr byte it produces during the run.
   */
  async function spawnAgent(label: string): Promise<Proc> {
    const dir = mkdtempSync(join(tmpdir(), `scm-e2e-${label}-`));
    const stderrChunks: string[] = [];
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", ENTRY_PATH],
      env: {
        ...process.env,
        SHARE_CONTEXT_RELAY_URL: baseUrl,
        SHARE_CONTEXT_DB_PATH: join(dir, "state.db"),
      },
      stderr: "pipe",
    });
    transport.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    const client = new Client({ name: `e2e-${label}`, version: "0.0.0" });
    await client.connect(transport);
    const proc: Proc = { client, dir, stderr: "" };
    Object.defineProperty(proc, "stderr", { get: () => stderrChunks.join("") });
    procs.push(proc);
    return proc;
  }

  test(
    "create → join → share ×3 → fetch → catch_up → search → rotate → 401 → re-join → fetch",
    async () => {
      const a = await spawnAgent("a");
      const b = await spawnAgent("b");

      // ---- A creates the channel; the password leaves via the test (out of band) ----
      const created = textOf(
        await a.client.callTool({ name: "create_channel", arguments: { memberName: "alice", name: "e2e" } }),
      );
      expect(created).toContain("channel created");
      const channelId = created.match(/channel_id=([a-z0-9]+)/)![1];
      const password = created.match(/password=([a-z0-9-]+)/)![1];
      expect(channelId).toMatch(/^[a-z0-9]{12}$/);
      expect(password).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){4}$/);

      // ---- B joins with its own member name and sees the join card ----
      const joined = textOf(
        await b.client.callTool({
          name: "join_channel",
          arguments: { channelId, password, memberName: "bob" },
        }),
      );
      expect(joined.startsWith(QUOTE_HEADER)).toBe(true);
      for (const line of joined.split("\n").slice(1)) expect(line.startsWith("> ")).toBe(true);
      expect(joined).toContain(channelId);
      expect(joined).toContain("alice");
      expect(joined).toContain("bob");

      // ---- A shares three updates with different kinds/topics ----
      const shared: Array<{ statement: string; kind: string; topic: string }> = [
        {
          statement: "auth: session cookies are httpOnly now and refresh tokens live 10 minutes",
          kind: "decision",
          topic: "auth",
        },
        {
          statement: "db: sqlite WAL migration applied — do not set journal_mode per connection",
          kind: "howto",
          topic: "db",
        },
        {
          statement: "export: the CSV endpoint is claimed by alice, ETA tomorrow",
          kind: "claim",
          topic: "export",
        },
      ];
      const seqs: number[] = [];
      for (const s of shared) {
        const res = await a.client.callTool({ name: "share_update", arguments: { ...s } });
        expect(isError(res)).toBe(false);
        seqs.push((JSON.parse(textOf(res)) as { seq: number }).seq);
      }

      // ---- B fetches and gets all three, wrapped in the reference block ----
      const fetched = JSON.parse(
        unwrapQuote(textOf(await b.client.callTool({ name: "fetch_updates", arguments: {} }))),
      ) as {
        messages: Array<{ seq: number; statement: string; kind: string; topic: string }>;
        skipped: number;
        cursor: number;
      };
      expect(fetched.messages).toHaveLength(3);
      expect(fetched.messages.map((m) => m.seq)).toEqual(seqs);
      expect(fetched.messages.map((m) => m.topic)).toEqual(["auth", "db", "export"]);
      expect(fetched.skipped).toBe(0);

      // ---- B catch_up filtered by topic ----
      const byTopic = JSON.parse(
        unwrapQuote(textOf(await b.client.callTool({ name: "catch_up", arguments: { topic: "db" } }))),
      ) as { messages: Array<{ topic: string; statement: string }>; count: number };
      expect(byTopic.count).toBe(1);
      expect(byTopic.messages[0].topic).toBe("db");
      expect(byTopic.messages[0].statement).toContain("WAL");

      // ---- B search: `a&b,c` = (a AND b) OR c ----
      const hits = JSON.parse(
        unwrapQuote(
          textOf(await b.client.callTool({ name: "search_messages", arguments: { query: "cookies&httpOnly, wal" } })),
        ),
      ) as { messages: Array<{ topic: string }>; count: number };
      expect(hits.count).toBe(2);
      expect(hits.messages.map((m) => m.topic).sort()).toEqual(["auth", "db"]);

      // ---- A rotates: the old password/epoch dies, A auto-rejoins ----
      const rotated = textOf(await a.client.callTool({ name: "rotate_password", arguments: {} }));
      expect(rotated).toContain("epoch 2");
      const newPassword = rotated.match(/password=([a-z0-9-]+)/)![1];
      expect(newPassword).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){4}$/);
      expect(newPassword).not.toBe(password);

      // ---- B's old session token is dead: fetch now fails unauthorized ----
      const stale = await b.client.callTool({ name: "fetch_updates", arguments: {} });
      expect(isError(stale)).toBe(true);
      expect(textOf(stale)).toContain("unauthorized");

      // ---- A (auto re-joined) can still share into epoch 2 ----
      const postRotate = await a.client.callTool({
        name: "share_update",
        arguments: {
          statement: "epoch 2 begins: old password is dead, everyone joins with the new one",
          kind: "progress",
          topic: "meta",
        },
      });
      expect(isError(postRotate)).toBe(false);

      // ---- B re-joins with the NEW password and keeps fetching ----
      const rejoined = await b.client.callTool({
        name: "join_channel",
        arguments: { channelId, password: newPassword, memberName: "bob" },
      });
      expect(isError(rejoined)).toBe(false);
      const rejoinedCard = textOf(rejoined);
      expect(rejoinedCard.startsWith(QUOTE_HEADER)).toBe(true);
      expect(rejoinedCard).toContain("bob");

      // the join window already delivered the epoch-2 message; a share from A
      // after the rejoin must flow to B through a plain fetch (epoch-2 key)
      const second = await a.client.callTool({
        name: "share_update",
        arguments: {
          statement: "back in business: epoch 2 delivery works end to end",
          kind: "progress",
          topic: "meta",
        },
      });
      expect(isError(second)).toBe(false);
      const resumed = JSON.parse(
        unwrapQuote(textOf(await b.client.callTool({ name: "fetch_updates", arguments: {} }))),
      ) as { messages: Array<{ statement: string }>; skipped: number };
      expect(resumed.messages.some((m) => m.statement.startsWith("back in business"))).toBe(true);

      // ---- security: no plaintext password in either server's stderr ----
      // (meaningful only because the test below proves the capture is live)
      for (const p of procs) {
        expect(p.stderr).not.toContain(password);
        expect(p.stderr).not.toContain(newPassword);
      }
    },
    60_000,
  );

  test(
    "stderr capture is live: a child missing SHARE_CONTEXT_RELAY_URL bails to stderr",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "scm-e2e-noenv-"));
      const stderrChunks: string[] = [];
      // The happy-path children above emit zero stderr bytes, so their no-leak
      // assertion alone proves nothing. This child deterministically hits the
      // startup bail: an invalid SHARE_CONTEXT_BRIDGE kind makes the bridge
      // factory throw ("must be relay|git|s3") before the MCP handshake, over
      // the SAME StdioClientTransport("pipe") capture path — proving the
      // capture is live so the happy-path no-leak assertions mean something.
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      env.SHARE_CONTEXT_DB_PATH = join(dir, "state.db");
      env.SHARE_CONTEXT_BRIDGE = "carrier-pigeon";
      const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", ENTRY_PATH],
        env,
        stderr: "pipe",
      });
      transport.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));
      const client = new Client({ name: "e2e-noenv", version: "0.0.0" });
      // no relay URL → process exits before answering `initialize` → rejects
      await expect(client.connect(transport)).rejects.toThrow();
      await Bun.sleep(300); // let stderr drain
      expect(stderrChunks.join("")).toContain("SHARE_CONTEXT_BRIDGE must be relay|git|s3");
      await transport.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
    30_000,
  );
});
