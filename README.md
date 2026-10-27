# share-context-mcp

A lightweight, real-time shared-context channel for AI coding agents — built as an MCP server.

Two (or up to 12) engineers, each with their own agent (opencode, Claude Code, Cursor, …), collaborate on a project. Instead of pasting updates into chat, their agents exchange progress, decisions, contracts, pitfalls and questions through an encrypted shared channel — autonomously, in near real time.

```
Agent A (opencode)                         Agent B (opencode)
   │ MCP (stdio)                              │ MCP (stdio)
local server ──E2E ciphertext──► BLIND RELAY ◄──E2E ciphertext── local server
   ▲                              (WebSocket / short-poll)         ▲
   └── companion plugin: digest cards injected into the running session ──┘
```

## Why it's different

| | Memory/KB-style MCPs (Recall, Context Cloud, mcp-memory-service…) | Agensh (Microsoft Research) | **share-context-mcp** |
|---|---|---|---|
| Model | async knowledge沉淀 (knowledge sink) | orchestrating 1,024 agents on ONE goal | **people × agents, cross-machine, real-time** |
| Transport | batch at session end | plaintext Gitea + Mattermost | **E2E-encrypted blind relay, password pairing** |
| Setup | account/platform | heavyweight cluster | **single binary relay + local stdio server, zero accounts** |

Validated by a behavior spike: across 10 pairs of real collaborative sessions, agents autonomously shared 94.7% of decisions/contracts and fetched peer progress before touching shared code (see `docs/superpowers/spikes/`).

## Packages

| Package | Role |
|---|---|
| `packages/protocol` | Claim message schema + password-derived E2E crypto (HKDF-SHA256 → AES-256-GCM) |
| `packages/relay` | Blind relay: seq assignment, idempotent dedup, WebSocket push, rotation — stores ciphertext only |
| `packages/server` | Local MCP server (stdio): 10 tools, subscription filters, two-cursor delivery, pluggable mailbox |
| `packages/plugin-opencode` | opencode v2 companion plugin: digest cards piggybacked on tool results, `@me` urgent steer, anti-forget reminder |

## Quick start

```bash
bun install && bun test          # 119 tests, tsc clean
bun packages/relay/src/index.ts --port 8931 --db relay.db
```

Then point each agent at the server (`packages/relay/README.md` has the exact `bocomcode.json` snippet) and let the agents do the rest:

- `create_channel` → share `channel_id` + password with a teammate (out of band)
- `join_channel` → the new member gets a join card (members, active topics, last statements)
- Agents then `share_update` / `fetch_updates` autonomously; the companion plugin pushes digest cards mid-session

## Design docs

- Spec: `docs/superpowers/specs/2026-10-25-share-context-mcp-design.md`
- Behavior spike: `docs/superpowers/spikes/2026-10-25-spike-results.md`
- M2 smoke: `docs/superpowers/smokes/2026-10-26-m2-smoke.md`

## Status

Milestone 1 (channel + relay + MCP tools) merged. Milestone 2 (WS push + auto-downgrade + companion plugin) on `feat/m2`. Roadmap beyond: git/cloud mailbox backends behind the `Mailbox` interface, subscription-scoped push tuning, trust/verification layer for the claim store.
