/**
 * Channel transport (spec §5.7): WS-first push-wake with automatic poll
 * downgrade. The WS is ONLY a wake-up optimization — every notification is
 * a hint to poll, and the persisted cursor is the sole correctness spine.
 *
 * CORRECTNESS CONTRACT (zero message loss): onNotify(seq) is a WAKE HINT,
 * never a delivery guarantee. seq is best-effort — the relay-allocated seq
 * of the triggering push, the last seen seq as a STALE hint in poll mode,
 * or 0 when nothing is known. Callers MUST respond to every notification
 * by polling since their persisted cursor; skipping a poll because
 * seq ≤ cursor is NOT safe (the hint may be stale). The transport fires a
 * wake on hello too, closing the gap between the last poll tick and a
 * re-upgrade (messages that landed in between carry no push frame).
 *
 * STATE MACHINE (mode "auto"): start → WS connect. Any frame (incl. ping)
 * resets the client-side death timer; silence beyond the death timeout or
 * any close → poll mode (adaptive timer: active interval while there was
 * send/fetch/listener activity within the activity window, idle interval
 * otherwise) + a periodic WS re-upgrade probe. Probe success returns to WS
 * mode; probe failure stays in poll without disturbing the poll timer.
 * Modes "ws" (WS only, reconnect on loss) and "poll" (pure timer, never
 * touches WS) force one leg of the machine. Every transition is logged to
 * stderr (debug).
 */
export type TransportMode = "auto" | "ws" | "poll";
export type TransportState = "ws" | "poll";

export interface TransportTuning {
  /** "auto" (default) | "ws" | "poll". */
  mode?: TransportMode;
  /** Active poll interval in ms (spec §5.8: default jittered 2–5s). */
  pollActiveMs?: number;
  /** Idle poll interval in ms (spec §5.8: default jittered 15–30s). */
  pollIdleMs?: number;
  /** Client-side WS death timeout in ms. Default: max(10s, 2 × pingIntervalMs). */
  wsDeathTimeoutMs?: number;
  /** The server's heartbeat interval (default 25s) — feeds the death-timeout default. */
  pingIntervalMs?: number;
  /** WS re-upgrade probe cadence in poll mode (default 60s). */
  probeIntervalMs?: number;
  /** How long an activity mark keeps the poll timer in the active interval (default 60s). */
  activityWindowMs?: number;
  /** State-transition log sink (default: stderr). */
  log?: (line: string) => void;
}

export interface ChannelTransportOptions {
  channelId: string;
  /** Build the WS URL for the current token (called on every connect attempt). */
  buildWsUrl: (token: string) => string;
  /** Current relay token, or null (lazy — tokens can rotate between attempts). */
  getToken: () => string | null;
  onNotify: (seq: number) => void;
  tuning?: TransportTuning;
}

const DEFAULT_PING_MS = 25_000;
const DEFAULT_PROBE_MS = 60_000;
const DEFAULT_ACTIVITY_WINDOW_MS = 60_000;
const ACTIVE_RANGE_MS: readonly [number, number] = [2_000, 5_000];
const IDLE_RANGE_MS: readonly [number, number] = [15_000, 30_000];

/** Spec §5.7 default: silence beyond max(10s, 2× server ping interval) is death. */
export function defaultWsDeathTimeoutMs(pingIntervalMs: number): number {
  return Math.max(10_000, 2 * pingIntervalMs);
}

function jitter([lo, hi]: readonly [number, number]): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

type Timer = ReturnType<typeof setTimeout>;

export class ChannelTransport {
  private readonly channelId: string;
  private readonly buildWsUrl: (token: string) => string;
  private readonly getToken: () => string | null;
  private readonly onNotify: (seq: number) => void;
  private readonly mode: TransportMode;
  private readonly pollActiveMs: number | undefined;
  private readonly pollIdleMs: number | undefined;
  private readonly deathTimeoutMs: number;
  private readonly probeIntervalMs: number;
  private readonly activityWindowMs: number;
  private readonly log: (line: string) => void;

  private _state: TransportState = "poll";
  private ws: WebSocket | null = null;
  private stopped = false;
  /** True only while a probe connect is in flight (probe failure keeps poll running). */
  private probing = false;
  /** Last seq seen on the wire (hello/message) — the wake hint in poll mode. */
  private lastSeq = 0;
  private lastActivity = Date.now();
  private deathTimer: Timer | null = null;
  private pollTimer: Timer | null = null;
  private pollDeadline = 0;
  private probeTimer: Timer | null = null;
  private retryTimer: Timer | null = null;

  constructor(opts: ChannelTransportOptions) {
    this.channelId = opts.channelId;
    this.buildWsUrl = opts.buildWsUrl;
    this.getToken = opts.getToken;
    this.onNotify = opts.onNotify;
    const t = opts.tuning ?? {};
    this.mode = t.mode ?? "auto";
    this.pollActiveMs = t.pollActiveMs;
    this.pollIdleMs = t.pollIdleMs;
    this.deathTimeoutMs = t.wsDeathTimeoutMs ?? defaultWsDeathTimeoutMs(t.pingIntervalMs ?? DEFAULT_PING_MS);
    this.probeIntervalMs = t.probeIntervalMs ?? DEFAULT_PROBE_MS;
    this.activityWindowMs = t.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;
    const sink = t.log ?? ((line: string) => console.error(`[transport:${this.channelId}] ${line}`));
    this.log = sink;
  }

  /** Current static leg: "ws" | "poll" (spec §5.7). */
  get state(): TransportState {
    return this._state;
  }

  start(): void {
    if (this.stopped) return;
    this.log(`start mode=${this.mode}`);
    if (this.mode === "poll") {
      this.enterPoll("mode=poll");
      return;
    }
    this.connect("initial");
  }

  /** Idempotent: clears every timer and closes the socket. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    this.log("stopped");
  }

  /** Mark caller activity so the poll timer uses the active interval (spec §5.8). */
  markActivity(): void {
    this.lastActivity = Date.now();
    if (this._state === "poll" && this.pollTimer !== null && !this.stopped) {
      const activeMs = this.pollActiveMs ?? jitter(ACTIVE_RANGE_MS);
      // Reschedule only when the pending tick is farther out than active pace.
      if (this.pollDeadline - Date.now() > activeMs) this.schedulePoll(activeMs);
    }
  }

  /** TEST-ONLY: close the underlying socket to simulate a network drop. */
  closeForTest(): void {
    const ws = this.ws;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  // ---- state machine ----

  private connect(why: "initial" | "probe" | "retry"): void {
    if (this.stopped) return;
    const token = this.getToken();
    if (!token) {
      this.log(`no token (${why})`);
      if (this.mode === "ws") this.scheduleRetry();
      else this.enterPoll("no token");
      return;
    }
    this.probing = why === "probe";
    const ws = new WebSocket(this.buildWsUrl(token));
    this.ws = ws;
    ws.addEventListener("open", () => this.handleOpen(ws, why));
    ws.addEventListener("message", (ev) => this.handleMessage(ws, ev));
    ws.addEventListener("close", () => this.handleClose(ws, why));
    ws.addEventListener("error", () => {
      // Rejected upgrades fire error AND close; handleClose is the single
      // funnel (identity-guarded) — nothing to do here.
    });
  }

  private isCurrent(ws: WebSocket): boolean {
    return this.ws === ws && !this.stopped;
  }

  private handleOpen(ws: WebSocket, why: "initial" | "probe" | "retry"): void {
    if (!this.isCurrent(ws)) return;
    this.probing = false;
    const resumed = this._state === "poll" && why !== "initial";
    if (this._state === "poll") this.leavePoll();
    this._state = "ws";
    this.armDeathTimer();
    this.log(resumed ? "ws re-upgraded (left poll mode)" : `ws open (${why})`);
  }

  private handleMessage(ws: WebSocket, ev: unknown): void {
    if (!this.isCurrent(ws)) return;
    // ANY frame resets death detection (spec §5.7: silence = death)
    this.armDeathTimer();
    let frame: { type?: unknown; seq?: unknown; epoch?: unknown };
    try {
      frame = JSON.parse(String((ev as MessageEvent).data)) as typeof frame;
    } catch {
      return;
    }
    switch (frame.type) {
      case "hello":
        if (typeof frame.seq === "number") this.lastSeq = frame.seq;
        // Wake on hello: anything that landed between the last poll tick and
        // this (re)connect carries no push frame — the caller's poll since
        // the cursor closes that gap deterministically.
        this.safeNotify(this.lastSeq, "hello");
        break;
      case "message":
        if (typeof frame.seq === "number") {
          this.lastSeq = frame.seq;
          this.safeNotify(frame.seq, "message");
        }
        break;
      case "epoch-invalidated":
        // Token is dead after a rotate; closing funnels through handleClose
        // (auto → poll; the caller's poll/rejoin logic takes over from there).
        this.log(`epoch-invalidated (epoch ${String(frame.epoch)}) — closing ws`);
        try {
          ws.close();
        } catch {
          // already closed
        }
        break;
      case "ping":
        break; // heartbeat only
    }
  }

  private handleClose(ws: WebSocket, why: "initial" | "probe" | "retry"): void {
    if (this.ws !== ws) return; // stale socket, already replaced or stopped
    this.ws = null;
    this.clearDeathTimer();
    if (this.stopped) return;
    if (this.mode === "ws") {
      this.log(`ws closed (${why}) — reconnecting`);
      this.scheduleRetry();
      return;
    }
    if (this.probing) {
      this.probing = false;
      this.log(`ws probe failed (${why}) — staying in poll`);
      return; // poll timer untouched
    }
    this.enterPoll(`ws closed (${why})`);
  }

  private armDeathTimer(): void {
    this.clearDeathTimer();
    this.deathTimer = setTimeout(() => {
      this.deathTimer = null;
      if (this.stopped || !this.ws) return;
      this.log(`ws silent for ${this.deathTimeoutMs}ms — closing (death detection)`);
      try {
        this.ws.close();
      } catch {
        // already closed
      }
    }, this.deathTimeoutMs);
  }

  private clearDeathTimer(): void {
    if (this.deathTimer !== null) {
      clearTimeout(this.deathTimer);
      this.deathTimer = null;
    }
  }

  private enterPoll(reason: string): void {
    this._state = "poll";
    this.probing = false;
    this.log(`poll mode (${reason})`);
    // First tick immediately: the catch-up poll over the disconnect gap.
    this.schedulePoll(0);
    if (this.mode === "auto") this.scheduleProbe();
  }

  private leavePoll(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollDeadline = Date.now() + delayMs;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.stopped || this._state !== "poll") return;
      this.safeNotify(this.lastSeq, "poll-tick");
      this.schedulePoll(this.nextPollInterval());
    }, delayMs);
  }

  private nextPollInterval(): number {
    const active = Date.now() - this.lastActivity < this.activityWindowMs;
    if (active) return this.pollActiveMs ?? jitter(ACTIVE_RANGE_MS);
    return this.pollIdleMs ?? jitter(IDLE_RANGE_MS);
  }

  private scheduleProbe(): void {
    if (this.probeTimer !== null) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.stopped || this._state !== "poll" || this.mode !== "auto") return;
      this.log("probing ws re-upgrade");
      this.connect("probe");
    }, this.probeIntervalMs);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect("retry");
    }, this.probeIntervalMs);
  }

  private clearTimers(): void {
    this.clearDeathTimer();
    this.leavePoll();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private safeNotify(seq: number, why: string): void {
    try {
      this.onNotify(seq);
    } catch (err) {
      // A throwing callback must not kill the state machine.
      this.log(`onNotify threw (${why}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
