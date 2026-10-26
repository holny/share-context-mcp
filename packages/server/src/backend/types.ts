/**
 * ChannelBackend abstraction (spec §5.5): the storage seam behind the MCP tool layer.
 * The blind relay is the first implementation (RelayBackend); git/cloud-storage
 * backends are v2 candidates that plug in here with zero tool-layer changes.
 */
import type { ClaimMessage } from "@share-context-mcp/protocol";
import type { TransportState, TransportTuning } from "../transport";

/**
 * Claim input to send(): the idempotency key is derived from
 * (statement, kind, topic) during validation, so callers need not precompute it.
 */
export type ClaimInput = Omit<ClaimMessage, "idempotencyKey"> & { idempotencyKey?: string };

/**
 * Handle for a live notification channel (backend.listen). The transport is
 * WS-first with automatic poll downgrade (spec §5.7); every notification it
 * fires is a wake hint, and the caller's poll-since-cursor is the correctness
 * source.
 */
export interface BackendListener {
  /** Tear down the transport: clears every timer and closes the socket. Idempotent. */
  stop(): Promise<void>;
  /** Mark caller activity so poll mode uses the fast (active) interval (spec §5.8). */
  markActivity(): void;
  /** Current static leg: "ws" | "poll". */
  readonly state: TransportState;
  /** TEST-ONLY: close the underlying socket to simulate a network drop. */
  closeForTest(): void;
}

export interface ChannelMember {
  memberName: string;
  joinedAt: string;
}

export interface ChannelMeta {
  members: ChannelMember[];
  nextSeq: number;
}

export interface PollResult {
  /** Decrypted messages from the window, in relay (seq ASC) order. */
  messages: ClaimMessage[];
  /**
   * Envelopes in the fetched window that could not be decrypted with any held
   * key (e.g. other-epoch ciphertext after a rotate). The cursor advances over
   * them regardless — they must never block the stream (spec §5.7).
   */
  skipped: number;
}

export interface ChannelBackend {
  /** Create a channel and join it as `memberName`. Returns the human-shareable secret. */
  createChannel(opts: { name?: string; memberName: string }): Promise<{ channelId: string; password: string }>;
  /** Join an existing channel with a password (challenge → proof → token). */
  join(channelId: string, password: string, memberName: string): Promise<void>;
  /** Validate + seal + publish a claim. Throws with the validation reason on invalid input. */
  send(msg: ClaimInput, channelId?: string): Promise<{ seq: number; deduped: boolean }>;
  /** Fetch envelopes since a seq, decrypt with the best held key, cache; the cursor high-waters over the whole returned window. */
  poll(channelId: string, since: number, opts?: { markActivity?: boolean }): Promise<PollResult>;
  /**
   * Live notifications (spec §5.7): WS-first with automatic poll downgrade
   * (adaptive active/idle intervals, periodic WS re-upgrade probe).
   * onNotify(seq) is a WAKE HINT — respond by polling (channelId, cursor);
   * the seq may be stale or 0 in poll mode and must never gate correctness.
   */
  listen(channelId: string, onNotify: (seq: number) => void, tuning?: TransportTuning): BackendListener;
  meta(channelId: string): Promise<ChannelMeta>;
  /** Open a new epoch with a new password; invalidates all tokens (caller must re-join). */
  rotate(channelId: string, newPassword: string): Promise<void>;
  /** Leave: forget the channel locally (relay-side member record stays in v1). */
  leave(channelId: string): Promise<void>;
}
