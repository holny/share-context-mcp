/**
 * Compiled binary entry: share-context-relay
 *
 * Zero-config by default: port 8931, db ~/.share-context-mcp/relay.db.
 * Flags: --port <n>  --db <path>
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { startRelay } from "./index";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number(flag("--port") ?? 8931);
const dbPath = flag("--db") ?? join(homedir(), ".share-context-mcp", "relay.db");
const maxMessages = Number(flag("--max-messages") ?? process.env.SHARE_CONTEXT_RELAY_MAX_MESSAGES ?? 10_000);
const maxAgeDays = Number(flag("--max-age-days") ?? process.env.SHARE_CONTEXT_RELAY_MAX_AGE_DAYS ?? 30);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port: ${flag("--port")}`);
  process.exit(1);
}
if (!Number.isInteger(maxMessages) || maxMessages < 1) {
  console.error(`invalid --max-messages: ${flag("--max-messages")}`);
  process.exit(1);
}
if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
  console.error(`invalid --max-age-days: ${flag("--max-age-days")}`);
  process.exit(1);
}

const relay = await startRelay({ port, dbPath, maxMessages, maxAgeDays });
console.error(
  `share-context relay: http://127.0.0.1:${relay.port} (db: ${dbPath}) — blind, stores ciphertext only`,
);
console.error(`retention: max ${maxMessages} messages / ${maxAgeDays} days per channel (whichever hits first)`);
console.error("press Ctrl+C to stop");
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
