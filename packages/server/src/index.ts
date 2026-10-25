/**
 * Public barrel of @share-context-mcp/server, plus the stdio entrypoint:
 * load Store → rejoin locally-held channels → register tools → hang on
 * StdioServerTransport (spec §5.5 local-state lifecycle).
 *
 * Environment: SHARE_CONTEXT_RELAY_URL (required), SHARE_CONTEXT_DB_PATH
 * (optional, defaults to ~/.share-context-mcp/state.db). Diagnostics go to
 * stderr only — stdout is the MCP transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { INSTRUCTIONS } from "./instructions";
import { buildMcpServer } from "./mcp";
import { RelayMailbox } from "./mailbox/relay";
import { Store } from "./store";

export { Store } from "./store";
export { RelayMailbox, generateGroupedPassword } from "./mailbox/relay";
export type { Mailbox, MailboxMember, MailboxMeta, PollResult, ClaimInput } from "./mailbox/types";
export { buildMcpServer, TOOL_NAMES } from "./mcp";
export { INSTRUCTIONS } from "./instructions";
export type { McpServerDeps } from "./mcp";

export interface StdioStartOptions {
  relayUrl?: string;
  dbPath?: string;
}

/**
 * Start a stdio MCP server process. Rejoins every locally-held channel so a
 * fresh agent session is immediately interoperable; a failed rejoin is logged
 * to stderr and skipped (the agent can join_channel manually).
 */
export async function runStdioServer(options: StdioStartOptions = {}): Promise<McpServer> {
  const relayUrl = options.relayUrl ?? process.env.SHARE_CONTEXT_RELAY_URL;
  if (!relayUrl) {
    console.error("share-context-mcp: SHARE_CONTEXT_RELAY_URL is not set — cannot reach the relay");
    process.exit(1);
  }
  const dbPath = options.dbPath ?? process.env.SHARE_CONTEXT_DB_PATH;
  const store = new Store(dbPath || undefined);
  const mailbox = new RelayMailbox({ baseUrl: relayUrl, store });
  for (const channelId of store.rejoinable()) {
    const secret = store.getChannelSecret(channelId);
    if (!secret) continue;
    try {
      await mailbox.join(channelId, secret.password, secret.memberName);
    } catch (err) {
      console.error(
        `share-context-mcp: rejoin failed for ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const server = buildMcpServer({ store, mailbox });
  await server.connect(new StdioServerTransport());
  return server;
}

if (import.meta.main) {
  await runStdioServer();
}
