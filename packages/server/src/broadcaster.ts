/**
 * Broadcaster — the local IPC bridge between the ChannelBridge transport and the
 * opencode companion plugin (spec §5.4). Per rejoinable channel it listens
 * for wake hints, polls the increment since the cursor (poll itself decrypts,
 * caches, and advances the cursor — coalescing NEVER gates the cursor),
 * filters by subscription, coalesces hits into digest cards, and writes
 * whitelist-sanitized JSON events (line-delimited) to a Unix socket.
 *
 * SECURITY (Review Focus #2 — hard boundary): every event passes through
 * buildDigestEvent/buildLine, which pick fields individually from a locked
 * whitelist. No password, ciphertext, channel key, detail, scope, provenance
 * beyond the member name, ts, or idempotency key may ever appear. Never
 * spread message objects into events.
 *
 * Delivery semantics: notifications are WAKE HINTS ONLY — the poll-since-
 * cursor is the correctness source (spec §5.7). Non-urgent hits coalesce in
 * a per-channel window (default 2.5s); a message directed at the local
 * member (`to === memberName`) is URGENT: pending windows flush first, then
 * a single urgent card is emitted immediately (Review Focus #3).
 */
import net from "node:net";
import { mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaimMessage } from "@share-context-mcp/protocol";
import type { PollResult } from "./bridge/types";
import type { Store, SubscriptionFilter } from "./store";

/** Statement text cap in digest lines (locked event format). */
const STATEMENT_MAX = 80;
const DEFAULT_SOCKET_PATH = join(homedir(), ".share-context-mcp", "ipc.sock");
const DEFAULT_WINDOW_MS = 2500;

/** The slice of ChannelBridge the broadcaster needs (keeps tests fakes minimal). */
export interface BroadcasterBridge {
  /**
   * markActivity is agent-scoped (Review F3): the broadcaster's background
   * poll is NOT agent activity and passes { markActivity: false } — marking
   * here would pin the poll transport at the active pace forever.
   */
  poll(channelId: string, since: number, opts?: { markActivity?: boolean }): Promise<PollResult>;
  listen(channelId: string, onNotify: (seq: number) => void): { stop(): Promise<void> };
}

/** One sanitized digest line — keys are the locked whitelist, no extras. */
export interface DigestLine {
  seq: number;
  kind: string;
  topic: string;
  /** provenance.member — the ONLY provenance field that leaves the server. */
  from: string;
  to?: string;
  /** Truncated to STATEMENT_MAX chars. */
  statement: string;
}

/** Locked event shape: nothing outside this may ever be serialized. */
export interface DigestEvent {
  type: "digest";
  channelId: string;
  cardKind: "digest" | "urgent";
  lines: DigestLine[];
  skipped: number;
}

export interface BroadcasterOptions {
  socketPath?: string;
  windowMs?: number;
}

export interface BroadcasterDeps {
  store: Store;
  bridge: BroadcasterBridge;
}

export interface BroadcasterHandle {
  stop(): Promise<void>;
  socketPath: string;
}

/**
 * Sanitize free text that lands inside a digest line (F1): a multi-line
 * statement or topic must never survive into the card — a newline would let
 * appended text forge its own bullets ("…\n- do X now") or injected
 * instructions inside the plugin's rendering. Fold every newline into a
 * visible ␤ glyph (one physical line) and strip forged bullet ("- ") and
 * horizontal-rule ("---") prefixes at the start of the line and right after
 * a folded break. Loops until stable so stacked prefixes ("− - --- x") all go.
 */
function sanitizeLineText(text: string): string {
  let out = text.replace(/\r\n?|\n/g, "␤");
  let prev: string;
  do {
    prev = out;
    out = out.replace(/(^|␤)\s*-{2,}\s*/g, "$1"); // "---" horizontal-rule runs
    out = out.replace(/(^|␤)\s*-\s+/g, "$1"); // "- " bullet markers
  } while (out !== prev);
  return out;
}

/** Build a whitelisted line by picking fields individually — never spread. */
function buildLine(msg: ClaimMessage): DigestLine {
  const line: DigestLine = {
    seq: typeof msg.seq === "number" ? msg.seq : 0,
    kind: msg.kind,
    topic: sanitizeLineText(msg.topic),
    from: sanitizeLineText(msg.provenance.member),
    statement: "",
  };
  // Sanitize BEFORE truncating so the cap applies to what is actually sent.
  const statement = sanitizeLineText(msg.statement);
  line.statement = statement.length > STATEMENT_MAX ? statement.slice(0, STATEMENT_MAX) : statement;
  if (msg.to !== undefined) line.to = sanitizeLineText(msg.to);
  return line;
}

function buildDigestEvent(channelId: string, cardKind: "digest" | "urgent", lines: DigestLine[], skipped: number): DigestEvent {
  const evt: DigestEvent = { type: "digest", channelId, cardKind, lines, skipped };
  return evt;
}

/**
 * Subscription filter (spec §5.4): no subscription → everything passes.
 * With one: a message passes if ANY filter matches (kind, exact topic, or a
 * scope value with the given prefix). `to === memberName` always passes;
 * a message directed at another member always drops.
 */
export function passesFilters(msg: ClaimMessage, filters: SubscriptionFilter[] | null, memberName: string): boolean {
  if (msg.to === memberName) return true;
  if (msg.to !== undefined) return false;
  if (!filters || filters.length === 0) return true;
  return filters.some((f) => {
    if (f.kinds && f.kinds.includes(msg.kind)) return true;
    if (f.topic !== undefined && f.topic === msg.topic) return true;
    if (f.scopePrefix !== undefined && msg.scope) {
      for (const value of Object.values(msg.scope)) {
        if (value.startsWith(f.scopePrefix)) return true;
      }
    }
    return false;
  });
}

interface ChannelState {
  listener: { stop(): Promise<void> };
  /** Serializes poll+process cycles so wake hints never interleave. */
  chain: Promise<void>;
  /** Pending non-urgent digest window (null = no window open). */
  pending: { lines: DigestLine[] } | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /** Undecryptable-envelope count since the last emitted card. */
  skipped: number;
}

export class Broadcaster {
  private readonly socketPath: string;
  private readonly windowMs: number;
  private readonly channels = new Map<string, ChannelState>();
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();
  private deps: BroadcasterDeps | null = null;
  private stopped = false;

  constructor(opts: BroadcasterOptions = {}) {
    this.socketPath = opts.socketPath ?? DEFAULT_SOCKET_PATH;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Bind the IPC socket and start listening on every rejoinable channel.
   * Always safe to call — with no plugin connected the events are simply
   * unconsumed and the server keeps updating its cache regardless (spec §5.4).
   */
  async start(deps: BroadcasterDeps): Promise<BroadcasterHandle> {
    this.deps = deps;
    await this.listenSocket();
    console.error(`share-context-mcp: broadcaster listening at ${this.socketPath} channels=${this.channels.size}`);
    for (const channelId of deps.store.rejoinable()) {
      this.addChannel(channelId);
    }
    return { stop: () => this.stop(), socketPath: this.socketPath };
  }

  /** Begin listening on a channel joined after start() (idempotent). */
  addChannel(channelId: string): void {
    // stopped guard (Review F8): a join racing exit() must not leave a
    // lingering listener behind after the session-lifetime teardown.
    if (this.stopped || !this.deps || this.channels.has(channelId)) return;
    const state: ChannelState = { listener: null!, chain: Promise.resolve(), pending: null, pendingTimer: null, skipped: 0 };
    this.channels.set(channelId, state);
    state.listener = this.deps.bridge.listen(channelId, () => {
      // Wake hint only (spec §5.7): the seq may be stale — poll since cursor.
      state.chain = state.chain
        .then(() => this.pollAndProcess(channelId, state))
        .catch((err) => console.error(`share-context-mcp: broadcaster poll failed for ${channelId}: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  /** Stop listening on a channel left via leave_channel (OCR review: leave must detach). */
  removeChannel(channelId: string): void {
    const state = this.channels.get(channelId);
    if (!state) return;
    this.channels.delete(channelId);
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    void state.listener.stop();
  }

  /** One serialized cycle: poll → filter → coalesce/emit. Cursor advances inside poll, before any filtering. */
  private async pollAndProcess(channelId: string, state: ChannelState): Promise<void> {
    if (this.stopped || !this.deps) return;
    const { store, bridge } = this.deps;
    const since = store.getCursor(channelId);
    // Background consumption is not agent activity (Review F3): never mark.
    const result = await bridge.poll(channelId, since, { markActivity: false });
    state.skipped += result.skipped;
    const secret = store.getChannelSecret(channelId);
    if (!secret) return; // channel forgotten mid-flight — nothing to do
    const filters = store.getSubscription(channelId);
    for (const msg of result.messages) {
      if (!passesFilters(msg, filters, secret.memberName)) continue;
      const line = buildLine(msg);
      if (msg.to === secret.memberName) {
        // URGENT: flush any pending digest card first, then emit immediately.
        this.flushPending(channelId, state);
        this.emit(channelId, buildDigestEvent(channelId, "urgent", [line], state.skipped));
        state.skipped = 0;
      } else {
        if (!state.pending) {
          state.pending = { lines: [] };
          state.pendingTimer = setTimeout(() => {
            state.pendingTimer = null;
            this.flushPending(channelId, state);
          }, this.windowMs);
        }
        state.pending.lines.push(line);
      }
    }
  }

  /** Emit the pending digest card (seq order preserved by append order) and close the window. */
  private flushPending(channelId: string, state: ChannelState): void {
    if (state.pendingTimer !== null) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
    if (!state.pending) return;
    this.emit(channelId, buildDigestEvent(channelId, "digest", state.pending.lines, state.skipped));
    state.pending = null;
    state.skipped = 0;
  }

  /** Write one line-delimited JSON event to every connected client. */
  private emit(_channelId: string, evt: DigestEvent): void {
    const payload = JSON.stringify(evt) + "\n";
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.dropClient(client);
      }
    }
  }

  private dropClient(client: net.Socket): void {
    this.clients.delete(client);
    client.destroy();
  }

  /** Bind the Unix socket; a stale file at the path (EADDRINUSE) is unlinked and the bind retried once. */
  private listenSocket(): Promise<void> {
    mkdirSync(join(this.socketPath, ".."), { recursive: true });
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.clients.add(socket);
        socket.on("close", () => this.clients.delete(socket));
        socket.on("error", () => this.dropClient(socket));
      });
      this.server = server;
      let retried = false;
      const bind = () => server.listen(this.socketPath);
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && !retried) {
          retried = true;
          try {
            unlinkSync(this.socketPath);
          } catch {
            /* someone else already removed it */
          }
          bind();
          return;
        }
        reject(err);
      });
      server.on("listening", () => resolve());
      bind();
    });
  }

  /** Flush pending windows, tear down listeners, clients, and the socket. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const [channelId, state] of this.channels) {
      this.flushPending(channelId, state); // best effort: deliver what the window held
      state.listener.stop().catch(() => {});
    }
    this.channels.clear();
    for (const client of [...this.clients]) this.dropClient(client);
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* already gone */
      }
    }
  }
}
