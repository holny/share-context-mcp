/**
 * Blind relay entry point (spec §5.5): Bun.serve + SQLite.
 * The relay stores and forwards ENCRYPTED messages only — it never sees
 * plaintext (see routes.ts for the blindness rules).
 *
 * M2 task-1: WS push endpoint at GET /channels/:id/ws?token=<token>.
 * Push frames are seq-only ({type, seq, epoch}); poll GET ?since= remains
 * the correctness fallback (spec §5.7).
 */
import { openDb, type ChannelRow } from "./db";
import type { Database } from "bun:sqlite";
import { authenticateUpgradeToken, createRelayHandler, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_MESSAGES, jsonError } from "./routes";
import { scanActivityRoles } from "./activity";
import { createWsHub, type WsConnData } from "./ws";

const DEFAULT_PING_INTERVAL_MS = 25_000;
/** Activity role scan cadence (governance v2 §5): once per day. */
const DEFAULT_ACTIVITY_SCAN_INTERVAL_MS = 24 * 3_600_000;

export interface RelayOptions {
  /** Port to listen on; 0 (default) picks an ephemeral port. */
  port?: number;
  /** SQLite file path; ":memory:" (default) for ephemeral instances. */
  dbPath?: string;
  /**
   * Server→client heartbeat interval in ms (spec §5.7: 25s default).
   * 0 disables the heartbeat. Tests use a short interval to observe pings.
   */
  pingIntervalMs?: number;
  /**
   * Retention (spec: count + TTL, whichever hits first). Messages are evicted
   * as a seq PREFIX (window stays contiguous — consumer cursors stay
   * decidable). Defaults: 10000 messages / 30 days, overridable via
   * SHARE_CONTEXT_RELAY_MAX_MESSAGES / SHARE_CONTEXT_RELAY_MAX_AGE_DAYS.
   */
  maxMessages?: number;
  maxAgeDays?: number;
  /**
   * Membership token lifetime in ms. Default: null = tokens never expire
   * (membership continuity must not depend on token churn); rotate via
   * token-refresh or ban via governance.
   */
  tokenTtlMs?: number | null;
  /**
   * TTL sweep interval in ms (default 60_000): insert-driven eviction alone
   * would let idle channels keep ciphertext past maxAgeDays forever.
   */
  sweepIntervalMs?: number;
  /**
   * Activity role scan interval in ms (governance v2 §5; default 24h, 0
   * disables). The scan also runs once at startup so a restarted relay
   * re-tiers immediately.
   */
  activityScanIntervalMs?: number;
}

export interface RelayHandle {
  /** The actual bound port (resolved when port 0 was requested). */
  port: number;
  /** Stop the server (closing all WS connections) and close the database. */
  stop(): Promise<void>;
  /** Direct database handle — governance tables are inspected via SQL in tests/CLI. */
  db: Database;
}

function numEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function startRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const db = openDb(options.dbPath ?? ":memory:");
  const hub = createWsHub();
  const handle = createRelayHandler(
    db,
    hub,
    {
      maxMessages: options.maxMessages ?? numEnv("SHARE_CONTEXT_RELAY_MAX_MESSAGES") ?? DEFAULT_MAX_MESSAGES,
      maxAgeDays: options.maxAgeDays ?? numEnv("SHARE_CONTEXT_RELAY_MAX_AGE_DAYS") ?? DEFAULT_MAX_AGE_DAYS,
    },
    options.sweepIntervalMs ?? 60_000,
    options.tokenTtlMs ?? null,
  );
  const stmtChannelInfo = db.prepare("SELECT epoch, next_seq FROM channels WHERE id = ?");

  const server = Bun.serve<WsConnData>({
    port: options.port ?? 0,
    // Bun.serve's default idleTimeout (10s) applies to upgraded WebSocket
    // sockets too and would kill connections during the 25s heartbeat gap —
    // hold connections well beyond the heartbeat interval (Bun counts this
    // option in SECONDS, hard-capped at 255).
    idleTimeout: Math.min(
      255,
      Math.max(60, ((options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS) / 1000) * 3),
    ),
    websocket: {
      open(ws) {
        const d = ws.data;
        hub.add(d.channelId, ws);
        // hello = last allocated seq (poll catch-up starts at since=seq).
        const ch = stmtChannelInfo.get(d.channelId) as { next_seq: number } | undefined;
        ws.send(JSON.stringify({ type: "hello", seq: (ch?.next_seq ?? 1) - 1 }));
      },
      message() {
        // The push channel is server→client only; client frames are ignored
        // (and the relay is blind to client content anyway).
      },
      close(ws) {
        hub.remove(ws.data.channelId, ws);
      },
    },
    fetch: async (req, server) => {
      const url = new URL(req.url);
      const wsMatch = url.pathname.match(/^\/channels\/([^/]+)\/ws\/?$/);
      if (wsMatch && req.method === "GET") {
        const identity = authenticateUpgradeToken(db, wsMatch[1], url.searchParams.get("token"));
        if (!identity) return jsonError(401, "unauthorized");
        const upgraded = server.upgrade(req, { data: identity });
        if (!upgraded) return jsonError(400, "upgrade failed");
        return undefined; // upgraded: fetch must not return a Response
      }
      try {
        return await handle(req);
      } catch {
        // Never echo error details: a malformed envelope must not leak
        // client-supplied content into responses or logs.
        return jsonError(500, "internal error");
      }
    },
  });

  // Per-server heartbeat (not per-connection): one timer, cleared on stop().
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimer = pingIntervalMs > 0 ? setInterval(() => hub.pingAll(), pingIntervalMs) : null;

  // Activity role daily scan (§5): once at startup + on a daily cadence.
  // unref'd + crash-guarded — the scan must never take the relay down.
  const activityScanIntervalMs = options.activityScanIntervalMs ?? DEFAULT_ACTIVITY_SCAN_INTERVAL_MS;
  try {
    scanActivityRoles(db);
  } catch { /* startup scan is best-effort */ }
  const activityTimer = activityScanIntervalMs > 0
    ? setInterval(() => {
        try {
          scanActivityRoles(db);
        } catch { /* db may be closing — best-effort */ }
      }, activityScanIntervalMs)
    : null;
  activityTimer?.unref();

  return {
    port: server.port ?? 0,
    db,
    async stop() {
      if (pingTimer) clearInterval(pingTimer);
      if (activityTimer) clearInterval(activityTimer);
      hub.closeAll();
      server.stop(true);
      db.close();
    },
  };
}

if (import.meta.main) {
  // CLI: bun run packages/relay/src/index.ts --port 8787 --db relay.db
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(flag("--port") ?? 8787);
  const dbPath = flag("--db") ?? "relay.db";
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid --port: ${flag("--port")}`);
    process.exit(1);
  }
  const relay = await startRelay({ port, dbPath });
  console.error(
    `share-context relay: http://127.0.0.1:${relay.port} (db: ${dbPath}) — blind, stores ciphertext only`,
  );
}
