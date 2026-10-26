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
import { Broadcaster } from "./broadcaster";
import { RelayBridge } from "./bridge/relay";
import { Store } from "./store";

export { Store } from "./store";
export { RelayBridge, generateGroupedPassword } from "./bridge/relay";
export type { ChannelBridge, ChannelMember, ChannelMeta, PollResult, ClaimInput } from "./bridge/types";
export { buildMcpServer, TOOL_NAMES } from "./mcp";
export { INSTRUCTIONS } from "./instructions";
export type { McpServerDeps } from "./mcp";
export { Broadcaster } from "./broadcaster";
export type { BroadcasterHandle, BroadcasterOptions, DigestEvent, DigestLine } from "./broadcaster";

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
  const bridge = new RelayBridge({ baseUrl: relayUrl, store });
  // Retained for the lifetime of the process: runtime joins register here and
  // a future in-process shutdown path can call broadcaster.stop(). Null when
  // the broadcaster failed to start (server continues without push).
  let broadcaster: Broadcaster | null = null;
  for (const channelId of store.rejoinable()) {
    const secret = store.getChannelSecret(channelId);
    if (!secret) continue;
    try {
      await bridge.join(channelId, secret.password, secret.memberName);
    } catch (err) {
      console.error(
        `share-context-mcp: rejoin failed for ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const server = buildMcpServer({
    store,
    bridge,
    // Runtime joins (join_channel / create_channel) must start broadcasting —
    // addChannel is idempotent, and channels joined before the broadcaster
    // starts below are picked up by start() via store.rejoinable() anyway.
    onChannelJoined: (channelId) => broadcaster?.addChannel(channelId),
    onChannelLeft: (channelId) => broadcaster?.removeChannel(channelId),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server lifetime = stdio session. The broadcaster's socket server and WS
  // listeners hold the event loop open, so without this the process would
  // linger after the client closes the stream — hanging any transport.close()
  // that waits for child exit (e.g. StdioClientTransport in tests), and
  // spamming I/O errors after the test tmpdir is deleted. The SDK's onclose
  // alone proved unreliable when the client destroys the streams, hence the
  // stdin end/close + signal fallbacks all funneling into one exit.
  const exit = () => {
    void broadcaster?.stop();
    process.exit(0);
  };
  transport.onclose = exit;
  process.stdin.once("end", exit);
  process.stdin.once("close", exit);
  process.once("SIGTERM", exit);
  process.once("SIGINT", exit);
  // Local IPC broadcaster (spec §5.4): always started — with no plugin
  // connected the events are simply unconsumed and the server keeps updating
  // its cache regardless. Path override: SHARE_CONTEXT_IPC_SOCKET.
  // Retained so runtime joins can register and shutdown can stop it.
  try {
    broadcaster = new Broadcaster({
      socketPath: process.env.SHARE_CONTEXT_IPC_SOCKET || undefined,
    });
    await broadcaster.start({ store, bridge });
  } catch (err) {
    broadcaster = null;
    console.error(
      `share-context-mcp: ipc broadcaster failed to start (server continues without push): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return server;
}

if (import.meta.main) {
  await runStdioServer();
}
