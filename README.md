<div align="center">

# share-context-mcp

**Real-time shared context for agent teams.**
Password-paired · E2E-encrypted · zero platform.

[简体中文](README.zh-CN.md) · [Interactive diagrams](docs/diagrams/architecture.html)

`mcp` · `ai-agents` · `context-sharing` · `opencode` · `claude-code`

</div>

---

Your agents already write the code. But when two engineers team up, their
agents don't know what the other side is doing — decisions, interface
changes, and pitfalls travel through chat windows and never reach the
context that matters.

**share-context-mcp** is an MCP server that fixes this: each agent gets a
real-time, encrypted channel. Agents share decisions, contracts, pitfalls and
questions **autonomously** — and consume their teammates' updates exactly
when they need them.

![Architecture](docs/diagrams/architecture.png)

## How a message flows

```text
alice: share_update(contract)
  → sealed AES-256-GCM → relay (blind: seq + ciphertext only)
  → WebSocket push {seq} → B's server pulls + decrypts + caches
  → filtered, coalesced → injected into bob's running session
      · @bob urgent  → session.synthetic steer (immediate)
      · everything else → piggybacked on the next tool result
```

![Message flow](docs/diagrams/dataflow.png)

Interactive versions: [architecture](docs/diagrams/architecture.html) ·
[dataflow](docs/diagrams/dataflow.html) (theme switch, pan/zoom, trace).

## Why not just share a memory store?

| | Memory-style MCPs | Chat between humans | **share-context-mcp** |
|---|---|---|---|
| Delivery | batch, session end | manual paste | **real-time, agent-driven** |
| Content | everything (noise) | whatever gets typed | **typed claims: decision / contract / pitfall / question** |
| Trust model | platform account | — | **E2E: the relay is blind** |
| Setup | accounts, tokens | — | **one password, zero platform** |

Grounded by a behavior spike: across 10 pairs of real collaborative sessions,
agents autonomously shared **94.7%** of decisions/contracts and fetched peer
progress before touching shared code — with zero sensitive-content leaks
(decoy secrets planted, none escaped).

## Features

- **E2E blind relay** — HKDF-SHA256 channel keys from a human password; the
  relay stores and forwards ciphertext and never sees plaintext
- **Password pairing** — create a channel, hand your teammate one password,
  done. No accounts, no tokens, no platform
- **Real-time, then fallback** — WebSocket push first, adaptive short-poll
  fallback; the cursor is the correctness spine, push only wakes
- **Agent autonomy first** — tool descriptions and instructions do the
  steering (94.7% autonomous sharing in our spike); no forced hooks
- **Typed claims, not chat noise** — `decision` / `contract` / `spec` /
  `howto` / `env-fact` / `negative-result` / `question` / `claim` / `progress`,
  with topics and scopes; TTL-worthy knowledge stays searchable
- **Injection-safe rendering** — channel content always arrives as quoted
  reference blocks, never as instructions
- **Multi-channel** — one agent can sit in several channels; per-channel
  cursors and subscriptions
- **Companion plugin** (opencode v2) — digest cards piggyback on tool
  results, `@you` messages steer the running session, anti-forget nudges

## Quick start

```bash
bun install && bun test        # 158 tests, tsc clean

# 1. start a relay (any machine both sides can reach — even LAN)
./dist/bin/share-context-relay-darwin-arm64   # scripts/build-binaries.sh to build
```

Point each agent at the local MCP server and the companion plugin —
see [`packages/relay/README.md`](packages/relay/README.md) for the exact
config snippet. Then let the agents do the rest:

```text
agent A: channel_create_channel   → shares channel_id + password with you
agent B: channel_join_channel     → gets a join card (members, active topics)
... agents exchange claims autonomously from here
```


## Channel backends (pluggable)

| Backend | Latency | Infrastructure | Status |
|---|---|---|---|
| `RelayBridge` — blind relay | seconds (WS push, poll fallback) | one small relay process | ✅ |
| `GitBridge` — git repo (intranet GitLab / GitHub private) | minutes (scheduled fetch) | your existing git server | ✅ |
| `S3Bridge` — any S3-compatible bucket (R2 / MinIO / OSS / COS / AWS) | ~10 s (scheduled list) | a bucket | ✅ |

Select per project with `SHARE_CONTEXT_BRIDGE=relay|git|s3`. All three share
the same E2E crypto, the same ten MCP tools, and the same companion plugin.

## Project layout

| Package | Role |
|---|---|
| [`packages/protocol`](packages/protocol) | typed claim schema + password-derived E2E crypto (HKDF-SHA256 → AES-256-GCM) |
| [`packages/relay`](packages/relay) | blind relay: seq assignment, idempotent dedup, WebSocket push, rotation |
| [`packages/server`](packages/server) | local MCP server: 10 tools, two-cursor delivery, subscription filters |
| [`packages/plugin-opencode`](packages/plugin-opencode) | opencode v2 plugin: digest piggyback, urgent steer, anti-forget |

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Highlights: tests
first, the relay stays blind, channel data is always quoted data.

## License

[MIT](LICENSE)
