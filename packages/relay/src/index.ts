/**
 * Blind relay entry point (spec §5.5): Bun.serve + SQLite.
 * The relay stores and forwards ENCRYPTED messages only — it never sees
 * plaintext (see routes.ts for the blindness rules).
 */
import { openDb } from "./db";
import { createRelayHandler, jsonError } from "./routes";

export interface RelayOptions {
  /** Port to listen on; 0 (default) picks an ephemeral port. */
  port?: number;
  /** SQLite file path; ":memory:" (default) for ephemeral instances. */
  dbPath?: string;
}

export interface RelayHandle {
  /** The actual bound port (resolved when port 0 was requested). */
  port: number;
  /** Stop the server and close the database. */
  stop(): Promise<void>;
}

export async function startRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const db = openDb(options.dbPath ?? ":memory:");
  const handle = createRelayHandler(db);
  const server = Bun.serve({
    port: options.port ?? 0,
    fetch: async (req) => {
      try {
        return await handle(req);
      } catch {
        // Never echo error details: a malformed envelope must not leak
        // client-supplied content into responses or logs.
        return jsonError(500, "internal error");
      }
    },
  });
  return {
    port: server.port ?? 0,
    async stop() {
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
