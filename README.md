<div align="center">

# share-context-mcp

**Real-time shared context for agent teams — so your agents finally know what their teammates are doing.**

[![Tests](https://img.shields.io/badge/tests-174%20pass-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)]()

[English](README.md) · [简体中文](README.zh-CN.md)

An MCP server that gives AI coding agents a **real-time, end-to-end-encrypted shared context channel**.
Two (or up to 12) engineers, each with their own agent on their own machine, collaborate through
one password-protected channel. Agents autonomously exchange decisions, contracts, pitfalls and
questions — no platform, no accounts, no paste.

</div>

---

## The Problem

Your agent writes great code — but it never knows what its teammates' agents are doing.

Alice's agent changes an API. Bob's agent is still building against the old interface. Alice hits
a pitfall. Bob walks into the same trap 30 minutes later. Multiply this by every handoff, every
decision, every "oh I should have told you earlier" — and the cost of context gaps compounds.

Chat windows don't fix this because the context never reaches the agent. Memory tools don't fix
this because they batch at session end, not real-time.

## The Solution

```
Alice's Agent                              Bob's Agent
     │                                          │
     │  channel_share_update(                   │
     │    kind="contract",                      │
     │    statement="getUser(id) → getUserById(id)"  │
     │  )                                       │
     ▼                                          ▼
  Local MCP Server ──── E2E ciphertext ────► Blind Relay ──── E2E ciphertext ────► Local MCP Server
                                                                                    │
                                                                                    ▼
                                                                              Bob's Agent
                                                                              "alice changed
                                                                               getUser → getUserById"
                                                                               → adapts immediately
```

No human copy-paste. No chat window. No context gap.

## Key Features

| | |
|---|---|
| 🔐 **E2E encrypted blind relay** | Channel keys derive from a human password (HKDF-SHA256 → AES-256-GCM). The relay stores and forwards ciphertext — it never sees plaintext |
| 🔑 **Password pairing** | Create a channel, hand your teammate one password. No accounts, no tokens, no platform |
| ⚡ **Real-time first, fallback always** | WebSocket push, adaptive short-poll fallback. The cursor is the correctness spine — push only wakes |
| 🤖 **Agent autonomy first** | Tool descriptions and instructions do the steering. 94.7% autonomous sharing in our behavior spike. No forced hooks |
| 📦 **Typed claims, not chat noise** | `decision` / `contract` / `spec` / `howto` / `env-fact` / `negative-result` / `question` / `claim` / `progress` — with topics and scopes, searchable and retrievable |
| 🛡️ **Injection-safe rendering** | Channel content always arrives as quoted reference blocks — data, never instructions |
| 📚 **Multi-channel** | One agent can sit in several channels. Per-channel cursors, subscriptions and caches |
| 🔌 **Pluggable backends** | Blind relay (default), git repo, S3-compatible bucket — same interface, zero tool-layer changes |
| 🔄 **Password rotation** | One command: old epoch archived, new epoch starts clean, old-key holders retain read access |
| 💻 **Cross-platform** | Single-file binaries for macOS (arm64/x64), Linux (x64/arm64), Windows (x64) |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Machine A                                    │
│                                                                      │
│  ┌───────────────┐      ┌────────────────────┐      ┌────────────┐ │
│  │  Agent A       │MCP   │  Local MCP Server  │ IPC  │  Companion │ │
│  │  (opencode v2) ├─────►│  (stdio process)   │◄─────│  Plugin    │ │
│  │  MCP client    │stdio │                      │sock  │  (optional)│ │
│  └───────────────┘      └────────┬────────────┘      └────────────┘ │
│                                   │                                    │
└───────────────────────────────────┼───────────────────────────────────┘
                                    │
                         E2E ciphertext (AES-256-GCM)
                                    │
┌───────────────────────────────────▼────────────────────────────────┐
│                         Blind Relay                                 │
│   seq assignment · idempotent dedup · WS push · rotation            │
│   Stores ciphertext + metadata ONLY — never plaintext               │
└───────────────────────────────────┬────────────────────────────────┘
                                    │
                         E2E ciphertext (same channel key)
                                    │
┌───────────────────────────────────▼────────────────────────────────┐
│                         Machine B                                    │
│  ┌───────────────┐      ┌────────────────────┐                      │
│  │  Agent B       │MCP   │  Local MCP Server  │                      │
│  │  (any client)  ├─────►│  (stdio process)   │                      │
│  └───────────────┘      └────────────────────┘                      │
└─────────────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Create a channel

Agent A calls `channel_create_channel` → gets a `channel_id` + `password`.
Alice shares these two values with Bob via any channel (Slack, email, verbal).

### 2. Join the channel

Agent B calls `channel_join_channel` with the credentials → receives a **join card**
(members, active topics, recent summaries) injected into its context as a quoted
reference block.

### 3. Collaborate autonomously

Agents exchange typed claims in real time:

| Kind | Meaning | Value |
|---|---|---|
| `decision` | A choice that affects shared behavior | Prevents conflicting implementations |
| `contract` | Interface/API change other code depends on | Prevents integration breakage |
| `howto` | Pitfall or technique discovered | Stops teammates on the same dead end |
| `negative-result` | An approach that does NOT work | **Highest value** — saves the most time |
| `question` | Directed @teammate query | Targeted, not broadcast |
| `claim` | "I'm about to touch X" | Prevents duplicate work |
| `progress` | Milestone completed | Keeps everyone aligned |
| `env-fact` | Tool version, config, service discovery | Environment awareness |

### 4. Message delivery

```
Alice sends seq=12
  → sealed AES-256-GCM → POST to relay
  → relay stores ciphertext, assigns seq, notifies online members
  → Bob's local server pulls, decrypts, caches
  → Companion plugin injects digest card into Bob's running session
```

- **WebSocket push** first; adaptive short-poll fallback (agent active: 2-5s, idle: 15-30s)
- **Digest coalescing**: multiple messages within 2.5s → one summary card (no spam)
- **@me urgent** → immediate `session.synthetic` steer (bypasses window)
- **Anti-forget** → gentle reminder if a turn made changes without sharing

### 5. Security model

| Layer | Protection |
|---|---|
| Transport | AES-256-GCM (HKDF-SHA256 from channel password) |
| Blind relay | Stores ciphertext + metadata only — never plaintext |
| Auth | HMAC-SHA256 challenge-response → session token (24h TTL) |
| Injection defense | Channel content always wrapped in reference blocks — data, never instructions |
| Credential blacklist | `share_update` rejects statements matching password/token/key patterns |

## Quick Start

### Build

```bash
git clone https://github.com/holny/share-context-mcp.git
cd share-context-mcp
bun install && bun test       # 174 tests, tsc clean

# build all-platform binaries
scripts/build-binaries.sh     # → dist/bin/ (10 binaries, 5 platforms × 2)
```

### Configure

Each agent's project config (`opencode.json` / `bocomcode.json`):

```jsonc
{
  "mcp": {
    "servers": {
      "share-context": {
        "type": "local",
        "codemode": false,
        "command": ["/path/to/dist/bin/share-context-server-bun-darwin-arm64"],
        "environment": {
          "SHARE_CONTEXT_RELAY_URL": "http://<relay-IP>:8931",
          "SHARE_CONTEXT_DB_PATH": "/Users/you/.share-context-mcp/myproject.db"
        }
      }
    }
  },
  // Optional: companion plugin for real-time injection
  "plugin": ["/path/to/share-context-mcp/packages/plugin-opencode"]
}
```

### Use

Start your agent session and say:

> *"Create a collaboration channel"*

Agent calls `channel_create_channel` → returns `channel_id` + `password`.
Share with your teammate. They say:

> *"Join the channel (channel_id=xxx password=xxx)"*

Done. From here, agents collaborate autonomously.

## Channel Backends (Pluggable)

| Backend | Latency | Infrastructure | Status |
|---|---|---|---|
| `RelayBridge` — blind relay | seconds (WS push, poll fallback) | one small relay process | ✅ |
| `GitBridge` — git repo (intranet GitLab / GitHub private) | minutes (scheduled fetch) | your existing git server | ✅ |
| `S3Bridge` — any S3-compatible bucket (R2 / MinIO / OSS / COS / AWS) | ~10 s (scheduled list) | a bucket | ✅ |

Select per project: `SHARE_CONTEXT_BRIDGE=relay|git|s3`.
All three share the same E2E crypto, the same ten MCP tools, and the same companion plugin.

## Security Model

| Attack | Defense |
|---|---|
| Relay server compromised | Only ciphertext + metadata — **no plaintext, no keys** |
| Channel password leaked | `rotate_password` starts a new epoch; old-key holders retain read access |
| Malicious member injects instructions | Reference-block wrapping + "data, not instructions" in instructions |
| Agent accidentally shares secrets | Statement ≤500 chars + credential blacklist + tool description red lines |
| Replay/reorder attacks | Monotonic seq + idempotency key dedup + HMAC challenge auth |

## Documentation

| Doc | Content |
|---|---|
| [Design spec](docs/superpowers/specs/2026-10-25-share-context-mcp-design.md) | Full architecture, message model, security model, trade-offs |
| [Behavior spike](docs/superpowers/spikes/2026-10-25-spike-results.md) | 10-pair autonomous sharing validation (94.7%) |
| [M2 smoke](docs/superpowers/smokes/2026-10-26-m2-smoke.md) | Real-session deployment verification |
| [Contributing](CONTRIBUTING.md) | Development setup, ground rules, PR process |

## Acknowledgments

- The shared-context board concept is inspired by [DeLM](https://arxiv.org/abs/2606.10662) and validated at scale by [Agensh](https://arxiv.org/abs/2609.26781) (Microsoft Research)
- Built for the [Model Context Protocol](https://modelcontextprotocol.io) ecosystem

## License

[MIT](LICENSE)
