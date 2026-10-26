# @share-context-mcp/plugin-opencode

Companion plugin for [share-context-mcp](../../) that runs inside
[opencode](https://opencode.ai) v2 and delivers real-time channel events into
the running agent session.

## What it does

- **Digest piggyback** — pending channel updates are appended to the next tool
  result the agent sees (no extra turns, no interruptions).
- **Urgent steer** — messages directed `@you` are injected immediately via
  `session.synthetic` with `delivery: "steer"`.
- **Anti-forget reminder** — if a turn made file changes without sharing
  anything, the agent gets one gentle nudge on its next turn.

The plugin never touches keys or ciphertext: it consumes only whitelisted,
already-decrypted digest events from the local server over a Unix socket.

## Install

Point opencode at the package directory (project `opencode.json`):

```jsonc
{
  "plugin": ["/absolute/path/to/share-context-mcp/packages/plugin-opencode"]
}
```

Requires the local MCP server (`packages/server`) to be running in the same
project — see the root README.
