/**
 * Mailbox abstraction (spec §5.5): the transport seam behind the MCP tool layer.
 * The blind relay is the first implementation (RelayMailbox); git/cloud-storage
 * mailboxes are v2 candidates that plug in here with zero tool-layer changes.
 */
import type { ClaimMessage } from "@share-context-mcp/protocol";

export interface MailboxMember {
  memberName: string;
  joinedAt: string;
}

export interface MailboxMeta {
  members: MailboxMember[];
  nextSeq: number;
}

export interface Mailbox {
  /** Create a channel and join it as `memberName`. Returns the human-shareable secret. */
  createChannel(opts: { name?: string; memberName: string }): Promise<{ channelId: string; password: string }>;
  /** Join an existing channel with a password (challenge → proof → token). */
  join(channelId: string, password: string, memberName: string): Promise<void>;
  /** Validate + seal + publish a claim. Throws with the validation reason on invalid input. */
  send(msg: ClaimMessage, channelId?: string): Promise<{ seq: number; deduped: boolean }>;
  /** Fetch envelopes since a seq, decrypt them, cache + advance the cursor. */
  poll(channelId: string, since: number): Promise<ClaimMessage[]>;
  meta(channelId: string): Promise<MailboxMeta>;
  /** Open a new epoch with a new password; invalidates all tokens (caller must re-join). */
  rotate(channelId: string, newPassword: string): Promise<void>;
  /** Leave: forget the channel locally (relay-side member record stays in v1). */
  leave(channelId: string): Promise<void>;
}
