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
