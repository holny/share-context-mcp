/**
 * IPC client for the opencode companion plugin (spec §5.4): connects to the
 * server-side broadcaster's Unix socket, consumes line-delimited whitelist
 * digest events, and reconnects with exponential backoff (silently idle
 * while the server is absent — the MCP stdio server only lives while an
 * agent session runs, so the socket may come and go).
 */
import net from "node:net";
import type { DigestCard } from "./coalesce";

export interface BackoffOptions {
  base: number;
  cap: number;
}

/** Pure backoff schedule: base * 2^attempt, capped. Deterministic for tests. */
export function nextBackoffMs(attempt: number, opts: BackoffOptions = { base: 500, cap: 15000 }): number {
  const raw = opts.base * 2 ** Math.max(0, attempt);
  return Math.max(1, Math.min(opts.cap, raw));
}

export interface IpcClientOptions {
  socketPath: string;
  /** Called for every valid digest event; never for malformed/non-digest lines. */
  onEvent: (card: DigestCard) => void;
  /** Optional state observer for tests/diagnostics: "connecting"|"connected"|"reconnecting"|"stopped". */
  onState?: (state: string) => void;
  backoff?: BackoffOptions;
}

/**
 * Line-delimited JSON IPC client. Defense in depth: even though the
 * broadcaster whitelists fields, the client re-validates the shape and
 * drops anything that is not a well-formed digest card.
 */
export class IpcClient {
  private readonly opts: Required<Pick<IpcClientOptions, "socketPath" | "onEvent">> & IpcClientOptions;
  private socket: net.Socket | null = null;
  private buffer = "";
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: "stopped" | "connecting" | "connected" | "reconnecting" = "stopped";
  private readonly stats_ = { attempts: 0, reconnects: 0, malformed: 0 };

  constructor(opts: IpcClientOptions) {
    this.opts = { backoff: { base: 500, cap: 15000 }, ...opts };
  }

  get stats() {
    return this.stats_;
  }

  connected(): boolean {
    return this.state === "connected";
  }

  setState(s: string): void {
    this.state = s as IpcClient["state"];
    this.opts.onState?.(s);
  }

  start(): void {
    if (this.state !== "stopped") return;
    this.setState("connecting");
    this.connect();
  }

  /** Stop and never reconnect. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.destroySocket();
    this.state = "stopped";
    this.opts.onState?.("stopped");
  }

  private destroySocket(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = "";
  }

  private connect(): void {
    if (this.state === "stopped") return;
    this.stats_.attempts++;
    const socket = net.connect(this.opts.socketPath);
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("connect", () => {
      if (this.socket !== socket) return;
      if (this.attempt > 0) this.stats_.reconnects++;
      this.attempt = 0;
      this.buffer = "";
      this.setState("connected");
    });
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    const retry = () => {
      if (this.socket !== socket) return; // superseded or stopped
      this.socket = null;
      this.buffer = "";
      if (this.state === "stopped") return;
      this.setState("reconnecting");
      const delay = nextBackoffMs(this.attempt, this.opts.backoff) + Math.floor(Math.random() * nextBackoffMs(this.attempt, this.opts.backoff) * 0.25);
      this.attempt++;
      this.timer = setTimeout(() => this.connect(), delay);
    };
    socket.on("error", retry);
    socket.on("close", retry);
  }

  /** Re-validate the whitelist event shape; drop anything else. */
  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.stats_.malformed++;
      return;
    }
    const card = parsed as DigestCard;
    if (
      card === null ||
      typeof card !== "object" ||
      card.type !== "digest" ||
      typeof card.channelId !== "string" ||
      (card.cardKind !== "digest" && card.cardKind !== "urgent") ||
      !Array.isArray(card.lines) ||
      typeof card.skipped !== "number"
    ) {
      this.stats_.malformed++;
      return;
    }
    this.opts.onEvent(card);
  }
}
