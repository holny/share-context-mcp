/**
 * Compiled binary entry: share-context-server
 *
 * The local MCP server (stdio) as a single executable. Zero-config by
 * default: relay at http://127.0.0.1:8931, and a per-project SQLite database
 * derived from the current working directory — so two agents in two projects
 * get isolated state without any environment setup.
 *
 * Flags: --relay <url>  --db <path>
 * Environment overrides: SHARE_CONTEXT_RELAY_URL, SHARE_CONTEXT_DB_PATH.
 */
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runStdioServer } from "./index";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const relayUrl = flag("--relay") ?? process.env.SHARE_CONTEXT_RELAY_URL ?? "http://127.0.0.1:8931";

// Per-project default db: ~/.share-context-mcp/projects/<slug>.db where slug
// = basename(cwd) + short hash of the full path (collision-safe, no config).
const cwd = process.cwd();
const slug = (cwd.split("/").pop() || "project").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32) || "project";
const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
const projectsDir = process.env.SHARE_CONTEXT_DB_DIR ?? join(homedir(), ".share-context-mcp", "projects");
const dbPath = flag("--db") ?? process.env.SHARE_CONTEXT_DB_PATH ?? join(projectsDir, `${slug}-${hash}.db`);

void tmpdir; // keep unused-import linters quiet if tmpdir import is pruned later
await runStdioServer({ relayUrl, dbPath });
