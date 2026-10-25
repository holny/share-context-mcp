/**
 * Public barrel of @share-context-mcp/server.
 * Local state (Store) + the relay-backed Mailbox — the layer the MCP tools wrap.
 */
export { Store } from "./store";
export { RelayMailbox } from "./mailbox/relay";
export type { Mailbox, MailboxMember, MailboxMeta } from "./mailbox/types";
