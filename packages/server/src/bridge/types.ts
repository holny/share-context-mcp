/**
 * ChannelBridge abstraction (spec §5.5): the storage seam behind the MCP tool layer.
 * The blind relay is the first implementation (RelayBridge); git/cloud-storage
 * backends are v2 candidates that plug in here with zero tool-layer changes.
 */
import type { ClaimMessage } from "@share-context-mcp/protocol";
import type { TransportState, TransportTuning } from "../transport";

/** S3-compatible connection params (S3Bridge). Defined here so the ChannelBridge
 * interface can accept them without depending on the s3 module. */
export interface S3ConnectionParams {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

/**
 * Claim input to send(): the idempotency key is derived from
 * (statement, kind, topic) during validation, so callers need not precompute it.
 */
export type ClaimInput = Omit<ClaimMessage, "idempotencyKey"> & { idempotencyKey?: string };

/**
 * Handle for a live notification channel (bridge.listen). The transport is
 * WS-first with automatic poll downgrade (spec §5.7); every notification it
 * fires is a wake hint, and the caller's poll-since-cursor is the correctness
 * source.
 */
export interface BridgeListener {
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
  /** ISO timestamp of the member's last reported activity; null when never reported. Relay-backed bridges only. */
  lastActiveAt?: string | null;
  /** Permission tier from the relay (creator | manager | representative | vip | regular | trial). Relay-backed bridges only. */
  permissionRole?: string;
}

export interface ChannelMeta {
  members: ChannelMember[];
  nextSeq: number;
  /** Governance roles (relay-backed bridges). */
  creatorMember?: string | null;
  managerMember?: string | null;
  admissionMode?: string;
  visibility?: string;
  invitePolicy?: string;
  contactInfo?: string | null;
  minSeq?: number;
  /** Encrypted toggle (§11, relay-backed bridges). */
  encrypted?: boolean;
  keyVersion?: number;
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
  /**
   * Encrypted rows (encrypted toggle, §11) in the window this member could
   * NOT open — no keyring entry for the row's key version. Subset of
   * `skipped`; surfaced so the agent can be told how many messages exist
   * that it cannot read.
   */
  encryptedCount: number;
  /**
   * Lowest seq the relay still retains (relay-backed bridges only). When the
   * relay has evicted a prefix below the consumer's cursor, the cursor is
   * raised to minSeq and the gap recorded locally — evicted text is gone and
   * recoverable only via digest messages.
   */
  minSeq?: number;
}

export interface ChannelBridge {
  /** Create a channel and join it as `memberName`. Returns the human-shareable secret.
   * gitUrl (GitBridge only): the remote repo URL for this channel.
   * v3 (spec §2.2): visibility/admissionMode shape validated at the relay;
   * password may be caller-supplied (owner-chosen) or generated;
   * encrypted:true mints the message key v1 on THIS machine (owner-only
   * key governance — creation is one of the two generation points);
   * probationEnabled toggles the 7-day trial tier for new members. */
  createChannel(opts: {
    name?: string;
    memberName: string;
    gitUrl?: string;
    s3?: S3ConnectionParams;
    visibility?: string;
    admissionMode?: string;
    password?: string;
    encrypted?: boolean;
    probationEnabled?: boolean;
    contactInfo?: string;
  }): Promise<{ channelId: string; password: string }>;
  /** Join an existing channel with a password. gitUrl (GitBridge only): the remote repo URL. */
  join(channelId: string, password: string, memberName: string, opts?: { gitUrl?: string; s3?: S3ConnectionParams }): Promise<void>;  /** Validate + seal + publish a claim. Throws with the validation reason on invalid input. */
  send(msg: ClaimInput, channelId?: string): Promise<{ seq: number; deduped: boolean }>;
  /** Fetch envelopes since a seq, decrypt with the best held key, cache; the cursor high-waters over the whole returned window. */
  poll(channelId: string, since: number, opts?: { markActivity?: boolean }): Promise<PollResult>;
  /**
   * Report member activity to the bridge backend (presence inference — the
   * MCP protocol has no session-exit events, so "active" = recently active).
   * Implementations may rate-limit (RelayBridge: one POST per 30s per
   * channel) or no-op (bridges without a presence endpoint). Fire-and-forget
   * semantics for callers: errors surface as rejected promises.
   */
  reportActivity(channelId: string, lastActiveAt: string): Promise<void>;
  /**
   * Live notifications (spec §5.7): WS-first with automatic poll downgrade
   * (adaptive active/idle intervals, periodic WS re-upgrade probe).
   * onNotify(seq) is a WAKE HINT — respond by polling (channelId, cursor);
   * the seq may be stale or 0 in poll mode and must never gate correctness.
   */
  listen(channelId: string, onNotify: (seq: number) => void, tuning?: TransportTuning): BridgeListener;
  meta(channelId: string): Promise<ChannelMeta>;
  /** Open a new epoch with a new password; invalidates all tokens (caller must re-join). */
  rotate(channelId: string, newPassword: string): Promise<void>;
  /** Leave: forget the channel locally (relay-side member record stays in v1). */
  leave(channelId: string, opts?: { transferTo?: string }): Promise<void>;
  /** Open + settled votes (governance; relay-backed bridges only). */
  votes(channelId: string): Promise<{
    open: Array<{ id: string; type: string; target: string; endsAt: number }>;
    history: Array<{ id: string; type: string; target: string; status: string; yes: number; no: number }>;
  }>;
  castVote(channelId: string, voteId: string, choice: "yes" | "no"): Promise<void>;
  /**
   * Open a governance vote (v3 spec §5: start_vote on the MCP surface —
   * same relay checks as the CLI path). Relay-backed bridges only.
   */
  startVote?(channelId: string, target: string, opts?: { banIp?: boolean; revokeInvitees?: boolean; reason?: string }): Promise<{ voteId: string; endsAt: number }>;
  /**
   * Governance capability (§governance): true only for the relay-backed
   * bridge — roles/votes/bans/directory are relay-tier features. git/S3
   * bridges run basic messaging and the MCP surface omits governance tools.
   */
  readonly governance: boolean;
  /**
   * Base URL of the backing relay (relay-backed bridges only; undefined for
   * git/S3). join_from_blob compares it against a blob's relayUrl so a
   * copy-paste invite for a DIFFERENT relay fails with a readable error
   * instead of silently joining the wrong server.
   */
  readonly relayUrl?: string;
}
