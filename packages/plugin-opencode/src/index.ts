/**
 * opencode v2 companion plugin (spec §5.4) — the true-realtime delivery
 * layer of share-context-mcp. Consumes the local IPC broadcaster's digest
 * event stream and injects summary cards into the running agent session:
 *
 * - urgent cards (@me) → session.synthetic(delivery: "steer") immediately
 * - digest cards → pending slot; the next tool result in that session
 *   carries the card appended to its output (piggyback), then pending clears
 * - anti-forget: a turn with write-ish actions but no share_update gets a
 *   gentle reminder injected at the START of the next turn
 *   (session.execution.started → synthetic steer) — anchored there because
 *   turn N's tool hooks are all complete by the time turn N+1 starts, so
 *   the evaluate+reset can never interleave with hooks of the turn being
 *   judged (an idle-boundary reset CAN: idle events are delivered
 *   asynchronously and raced the next turn's hooks in testing)
 *
 * Module contract (bocomcode_v2 loader, core/src/plugin/module.ts): the
 * default export must be { id, setup }. The plugin imports NOTHING from the
 * host — the promise-plugin Context is matched structurally, so this file
 * stays loadable as a local path plugin with a self-contained import graph.
 *
 * Config: SHARE_CONTEXT_IPC_SOCKET (same env as the server) for the socket
 * path; SHARE_CONTEXT_PLUGIN=off disables the plugin entirely.
 */
import { IpcClient } from "./ipc.ts";
import { CARD_SEPARATOR, mergeCards, renderDigestCard, type DigestCard } from "./coalesce.ts";
import { isActionTool, isShareTool, renderReminder, shouldRemind } from "./anti-forget.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SOCKET_PATH = join(homedir(), ".share-context-mcp", "ipc.sock");

/** Structural slice of the fork's promise-plugin Context that we use. */
interface PluginContext {
  session: {
    synthetic(input: {
      sessionID: string;
      text: string;
      description?: string;
      delivery?: "steer" | "queue";
      resume?: boolean;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  tool: {
    hook(name: "execute.before" | "execute.after", callback: (event: any) => Promise<void> | void): Promise<unknown>;
  };
  event: {
    subscribe(): AsyncIterable<{ type: string; data?: any }>;
  };
}

interface SessionState {
  /** Write-ish tool calls completed this turn (anti-forget counter). */
  actions: number;
  /** Whether share_update ran this turn. */
  sharedThisTurn: boolean;
  /** Cards waiting to piggyback on the next tool result. */
  pending: DigestCard[];
}

export const PLUGIN_ID = "share-context-mcp";

const plugin = {
  id: PLUGIN_ID,
  async setup(ctx: PluginContext): Promise<(() => Promise<void>) | undefined> {
    // Env switch: SHARE_CONTEXT_PLUGIN=off disables everything (no hooks, no socket).
    const enabled = !["off", "0", "false", "no"].includes((process.env.SHARE_CONTEXT_PLUGIN ?? "").toLowerCase());
    console.error(`share-context-mcp: plugin setup enabled=${enabled} socket=${process.env.SHARE_CONTEXT_IPC_SOCKET || DEFAULT_SOCKET_PATH}`);
    if (!enabled) return undefined;

    const socketPath = process.env.SHARE_CONTEXT_IPC_SOCKET || DEFAULT_SOCKET_PATH;
    const sessions = new Map<string, SessionState>();
    let lastActiveSessionID: string | undefined;

    const stateFor = (sessionID: string): SessionState => {
      let state = sessions.get(sessionID);
      if (!state) {
        state = { actions: 0, sharedThisTurn: false, pending: [] };
        sessions.set(sessionID, state);
      }
      return state;
    };

    const judgePreviousTurn = async (sessionID: string): Promise<void> => {
      // Called when a NEW turn starts: everything counted so far belongs to
      // the finished previous turn. Evaluate, then start fresh counters.
      const state = sessions.get(sessionID);
      if (!state) return; // no tracked activity → nothing to judge
      const remind = shouldRemind(state.actions, state.sharedThisTurn);
      state.actions = 0;
      state.sharedThisTurn = false;
      if (remind) {
        try {
          // delivery "steer" while the session is running: the reminder rides
          // along with the turn that just started.
          await ctx.session.synthetic({
            sessionID,
            text: renderReminder(),
            delivery: "steer",
            resume: false,
            metadata: { source: PLUGIN_ID, kind: "anti-forget" },
          });
        } catch (err) {
          console.error(`share-context-mcp: anti-forget reminder failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    // ---- tool hooks (piggyback + action tracking) ----
    await ctx.tool.hook("execute.before", (event) => {
      lastActiveSessionID = event.sessionID;
      const state = stateFor(event.sessionID);
      if (isShareTool(event.tool)) state.sharedThisTurn = true;
    });

    await ctx.tool.hook("execute.after", (event) => {
      lastActiveSessionID = event.sessionID;
      const state = stateFor(event.sessionID);
      if (event.status === "completed") {
        if (isActionTool(event.tool)) state.actions++;
        // Piggyback: append the pending card to the tool result the model sees.
        if (state.pending.length > 0) {
          const merged = mergeCards(state.pending);
          state.pending = [];
          if (merged && merged.lines.length > 0) {
            const cardText = CARD_SEPARATOR + renderDigestCard(merged);
            const result = event.result;
            if (typeof result.content === "string") result.content = result.content + cardText;
            else if (Array.isArray(result.content)) result.content = [...result.content, { type: "text", text: cardText }];
            else result.content = cardText;
          }
        }
      }
    });

    // ---- IPC stream → cards ----
    const client = new IpcClient({
      socketPath,
      onEvent: (card) => {
        const sessionID = lastActiveSessionID;
        if (!sessionID) {
          console.error("share-context-mcp: digest card received but no active session yet; dropped");
          return;
        }
        if (card.cardKind === "urgent") {
          // @me bypass (Review Focus #3): steer immediately, do not wait for a window.
          ctx.session
            .synthetic({
              sessionID,
              text: renderDigestCard(card),
              delivery: "steer",
              metadata: { source: PLUGIN_ID, kind: "urgent-digest", channelId: card.channelId },
            })
            .catch((err: unknown) =>
              console.error(`share-context-mcp: urgent steer failed: ${err instanceof Error ? err.message : String(err)}`),
            );
          return;
        }
        stateFor(sessionID).pending.push(card);
      },
    });
    client.start();

    // ---- turn boundary: judge the previous turn when the next one starts ----
    const events = ctx.event.subscribe();
    const pump = (async () => {
      try {
        for await (const event of events) {
          // The fork publishes execution events (core/src/session/execution.ts):
          // started = a turn begins, so everything counted so far is the
          // finished previous turn. This is the anti-forget judge point.
          if (event.type === "session.execution.started" && event.data?.sessionID) {
            await judgePreviousTurn(event.data.sessionID);
          }
        }
      } catch {
        // Event stream closed (plugin unload) — cleanup below owns the rest.
      }
    })();

    return async () => {
      client.stop();
      // The host closes the event stream on plugin unload; don't wait on the
      // pump here — some hosts (and our smoke fakes) keep the iterator open,
      // and awaiting it would hang cleanup. Give it one microtask-friendly
      // beat to drain, then move on.
      await Promise.race([pump, new Promise((r) => setTimeout(r, 50))]).catch(() => {});
    };
  },
};

export default plugin;
