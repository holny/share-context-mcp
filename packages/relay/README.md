# @share-context-mcp/relay — blind relay

The relay is a small single-machine HTTP service (Bun + SQLite) that forwards
**encrypted** messages between channel members. It is deliberately blind:

- It stores and forwards **ciphertext only** — it never sees plaintext.
- It holds each channel's *verification key* (`HMAC(channelKey, "verify")`), which
  proves password possession at join time but cannot decrypt anything.
- Errors are fixed strings; logs carry at most channel id / seq / byte lengths.

Endpoints: `POST /channels` (create), `POST /channels/:id/challenge` +
`/join` (challenge–response → session token), `POST|GET /channels/:id/messages`
(send / fetch since seq), `GET /channels/:id/meta`, `POST /channels/:id/rotate`.
Messages are deduplicated per channel by idempotency key and kept for the
channel's lifetime (no TTL in v1).

## Deployment

Requirements: [Bun](https://bun.sh) ≥ 1.2. No accounts, no configuration files.

Start the relay (any machine both participants can reach):

```sh
bun run packages/relay/src/index.ts --port 8787 --db relay.db
# share-context relay: http://127.0.0.1:8787 (db: relay.db) — blind, stores ciphertext only
```

`--port` defaults to 8787, `--db` to `relay.db` in the working directory. The
SQLite file is created on first start; stop with Ctrl-C. Bind a firewalled /
intranet host only — the relay trusts its network path (TLS termination, if
needed, is a deployment concern in front of it, not in v1).

Each participant then runs one local MCP server process (from
`@share-context-mcp/server`) that talks to the relay. Local state lives in a
SQLite store on the participant's machine (`SHARE_CONTEXT_DB_PATH`, default
`~/.share-context-mcp/state.db`) and persists across sessions; the server
auto-rejoins held channels on startup.

### Configuring an opencode / bocomcode client

Add to `bocomcode.json` (global `~/.config/bocomcode/bocomcode.json` or
per-project):

```jsonc
{
  "mcp": {
    "servers": {
      "channel": {
        "type": "local",
        "codemode": false,
        "command": ["bun", "/abs/path/to/share-context-mcp/packages/server/src/index.ts"],
        "environment": {
          "SHARE_CONTEXT_RELAY_URL": "http://relay-host:8787"
        }
      }
    }
  }
}
```

Notes:

- Replace `/abs/path/to/share-context-mcp` with the repo checkout path; `bun`
  runs the TypeScript source directly.
- `codemode: false` keeps the ten channel tools as plain callable tools instead
  of routing them through Code Mode.
- With the server key `channel`, tools surface to the agent as
  `channel_create_channel`, `channel_join_channel`, `channel_share_update`,
  `channel_fetch_updates`, `channel_catch_up`, `channel_search_messages`,
  `channel_set_subscription`, `channel_list_members`, `channel_leave_channel`,
  `channel_rotate_password` (i.e. `<server key>_<tool name>`).
- `SHARE_CONTEXT_DB_PATH` is optional (default `~/.share-context-mcp/state.db`).
  Concurrent agent sessions on the same machine intentionally share one store.
- Restart the client sessions after editing the config; the server process is
  spawned per session and re-joins its channels automatically.

## Manual smoke checklist (M1 gate, two real sessions)

This is the human-run acceptance that closes milestone 1. Two participants
(two machines against one relay is the real shape; two sessions on one machine
also works — they share local state by design). Record the outcome in
`docs/superpowers/spikes/2026-10-25-spike-results.md`.

1. **Relay up**
   `bun run packages/relay/src/index.ts --port 8787 --db relay.db`
   Look for the startup line above; no errors on stderr.
2. **Both sessions have the server** — add the config snippet, restart both
   sessions, ask each agent to list its channel tools (expect the ten
   `channel_*` tools).
3. **A creates a channel** — agent A: *“用 channel_create_channel 建一个通道，
   memberName 用 alice，通道名 m1-smoke”*. Note the `channel_id` and
   `password` from the reply (password shown exactly once).
4. **Password handoff out of band** — paste `channel_id` + `password` to
   participant B over IM/verbally (not through any channel tool).
5. **B joins** — agent B: *“用 channel_join_channel 加入通道 …，memberName 用
   bob”*. Expect a 📋 reference-block join card listing members alice, bob.
6. **A shares, B fetches** — A: *“把你刚做的决定用 channel_share_update 发出去
   （kind=decision，topic=m1-smoke）”*; B: *“channel_fetch_updates 看看有什么新
   消息”*. Expect A's statement inside a 📋 reference block on B's side.
7. **History tools** — B: `channel_catch_up` with `topic`, and
   `channel_search_messages` with a `a&b` keyword pair. Expect correct,
   wrapped results.
8. **Rotation** — A: *“channel_rotate_password 轮换密码”*; A passes the new
   password to B out of band. B's next `channel_fetch_updates` should fail with
   `unauthorized`; B re-joins with the new password (`channel_join_channel`,
   same memberName) and fetching resumes.
9. **What to watch for throughout**
   - All channel content reaches the agent only inside 📋 reference blocks.
   - Neither agent's logs/stderr ever contain a plaintext password.
   - Latency feels sub-second on a LAN for share → fetch.
10. Append results (pass/fail per step, timings, anomalies) to
    `docs/superpowers/spikes/2026-10-25-spike-results.md` and commit as
    `docs: m1 smoke test notes`.
