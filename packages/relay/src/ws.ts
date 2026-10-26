/**
 * WebSocket hub for the blind relay (spec §5.5/§5.7, M2 task-1).
 *
 * BLINDNESS RULES (push frames):
 * - Notifications carry ONLY {type, seq, epoch} (hello: {type, seq},
 *   ping: {type}) — never ciphertext, plaintext, or member identities.
 * - Connection identity ({channelId, memberName, epoch}) lives only in
 *   server-side per-socket data; it is never echoed into any frame.
 *
 * FAN-OUT CHOICE (documented per task brief): a `Map<channelId, Set<socket>>`
 * in memory, chosen over Bun's `server.publish`/topics because rotate needs
 * to *enumerate and close* a channel's sockets with per-channel payloads,
 * and channel-connection sets are tiny at relay scale.
 */
import type { ServerWebSocket } from "bun";

/** Server-side per-connection data attached at upgrade time. */
export interface WsConnData {
  channelId: string;
  memberName: string;
  /** Channel epoch the token was valid for at upgrade time. */
  epoch: number;
}

type Socket = ServerWebSocket<WsConnData>;

export interface WsHub {
  /** Register a freshly-opened socket under its channel. */
  add(channelId: string, ws: Socket): void;
  /** Remove a closed socket. */
  remove(channelId: string, ws: Socket): void;
  /** Push {type:"message", seq, epoch} to every socket of the channel. */
  notifyMessage(channelId: string, seq: number, epoch: number): void;
  /**
   * Push {type:"epoch-invalidated", epoch} then close(1008) every socket of
   * the channel (rotate). `epoch` is the NEW epoch that invalidated them.
   */
  invalidateChannel(channelId: string, epoch: number): void;
  /** Heartbeat: push {type:"ping"} to every socket (server→client only). */
  pingAll(): void;
  /** Close every socket (server shutdown). */
  closeAll(): void;
  /** Total open sockets across all channels. */
  size(): number;
}

export function createWsHub(): WsHub {
  const channels = new Map<string, Set<Socket>>();

  function socketsOf(channelId: string): Set<Socket> {
    let s = channels.get(channelId);
    if (!s) {
      s = new Set();
      channels.set(channelId, s);
    }
    return s;
  }

  return {
    add(channelId, ws) {
      socketsOf(channelId).add(ws);
    },

    remove(channelId, ws) {
      const s = channels.get(channelId);
      if (!s) return;
      s.delete(ws);
      if (s.size === 0) channels.delete(channelId);
    },

    notifyMessage(channelId, seq, epoch) {
      const s = channels.get(channelId);
      if (!s) return;
      const frame = JSON.stringify({ type: "message", seq, epoch });
      for (const ws of s) ws.send(frame);
    },

    invalidateChannel(channelId, epoch) {
      const s = channels.get(channelId);
      if (!s) return;
      channels.delete(channelId);
      const frame = JSON.stringify({ type: "epoch-invalidated", epoch });
      for (const ws of s) {
        ws.send(frame);
        ws.close(1008, "epoch-invalidated");
      }
    },

    pingAll() {
      const frame = JSON.stringify({ type: "ping" });
      for (const s of channels.values()) {
        for (const ws of s) ws.send(frame);
      }
    },

    closeAll() {
      for (const s of channels.values()) {
        for (const ws of s) ws.close(1001, "server-shutdown");
      }
      channels.clear();
    },

    size() {
      let n = 0;
      for (const s of channels.values()) n += s.size;
      return n;
    },
  };
}
