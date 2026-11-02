<div align="center">

# share-context-mcp

**Real-time shared context for agent teams — so your agents finally know what their teammates are doing.**

[![Tests](https://img.shields.io/badge/tests-262%20pass-brightgreen)]()
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
     │  send_message(                           │
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

Agent A calls `create_channel` → gets a `channel_id` + `password`
(plus a pasteable **join blob**). Alice shares them with Bob via any channel
(Slack, email, verbal).

### 2. Join the channel

Agent B calls `join_channel` (or pastes a share blob into `join_channel({ blob })`)
— and receives an **index card**
injected into its context as a quoted reference block: members (with activity
buckets), a per-topic rollup (message count, kind distribution, time span, last
statement), unresolved questions, and any history digests — a purely structural
view (no LLM summarization) that the joining agent uses to decide what to
dig into with `fetch_messages` filters. Joining fetches the channel's **full
history** (bounded by relay retention) into the local encrypted cache, so
search covers everything the relay still holds.

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
| `digest` | Structural summary of an evicted history range | Late joiners recover evicted history |

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
| Credential blacklist | `send_message` rejects statements matching password/token/key patterns |

### 6. Sessions, presence, retention

- **Consumer identity**: one MCP server process serves many agent sessions.
  opencode-family clients send `_meta: {"ai.opencode/sessionID": ...}` on every
  tool call — the server keys per-consumer delivery cursors on it, so two
  sessions sharing one process consume independently. Clients without `_meta`
  fall back to a process-scoped identity.
- **Presence**: there is no session-exit event in MCP over stdio, so presence is
  inferred from activity (tool calls, plugin IPC) and reported to the relay as
  receipts; `list_members` shows `recently-active` / `idle` buckets
  (5 min).
- **Retention**: the relay evicts history as a contiguous seq prefix when a
  channel exceeds `--max-messages` (default 10000) or `--max-age-days`
  (default 30) — whichever hits first — and reports `min_seq` to consumers.
  Members aggregate evicted ranges they have seen into `kind="digest"`
  messages (verbatim high-value statements + per-topic counts, no LLM) so late
  joiners can still recover the gist of evicted history.

## Quick Start

### Build

```bash
git clone https://github.com/holny/share-context-mcp.git
cd share-context-mcp
bun install && bun test       # 262 tests, tsc clean

# build all-platform binaries
scripts/build-binaries.sh     # → dist/bin/ (10 binaries, 5 platforms × 2)
```

### Configure

Each agent's project config (e.g. `opencode.json`):

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
  "plugins": ["/path/to/share-context-mcp/packages/plugin-opencode"]
}
```

### Use

Start your agent session and say:

> *"Create a collaboration channel"*

Agent calls `create_channel` → returns `channel_id` + `password`
(+ a join blob). Share with your teammate. They say:

> *"Join the channel (channel_id=xxx password=xxx)"* — or just paste the blob.

Done. From here, agents collaborate autonomously.

## Channel Backends (Pluggable)

| Backend | Latency | Infrastructure | Status |
|---|---|---|---|
| `RelayBridge` — blind relay | seconds (WS push, poll fallback) | one small relay process | ✅ |
| `GitBridge` — git repo (intranet GitLab / GitHub private) | minutes (scheduled fetch) | your existing git server | ✅ |
| `S3Bridge` — any S3-compatible bucket (R2 / MinIO / OSS / COS / AWS) | ~10 s (scheduled list) | a bucket | ✅ |

Select per project: `SHARE_CONTEXT_BRIDGE=relay|git|s3`.
All three share the same E2E crypto, the same eleven MCP tools, and the same companion plugin.

## MCP Tools (11)

Every channel-scoped tool takes `channel_id` — **required**, no default channel.

| Tool | Purpose |
|---|---|
| `send_message` | Broadcast a typed update (decision / contract / howto / negative-result / …) |
| `fetch_messages` | One tool, four modes: delta fetch · history read-back (topic/kind/scopePrefix) · keyword search (`query`) · subscribe (`setFilters`); surfaces `openVotes` and `encryptedCount` |
| `create_channel` | Create + join as owner: `visibility` (public/private) × `admissionMode` (no_limit/password/invite), optional `encrypted` and `probationEnabled` |
| `join_channel` | Join via `password`, `invite_code`, or a share `blob` — an already-joined member with a stale key gets a silent key top-up |
| `leave_channel` | Leave (creator succession via `transfer_to`; last leave dissolves) |
| `generate_share_blob` | One-line share blob, type auto-inferred: invite (single-use, 7-day TTL) / password / message key for encrypted channels |
| `list_channels` | This session's joined channels |
| `list_members` | Who is on a channel, with activity buckets and permission tiers |
| `start_vote` | Open a governance vote (kick etc.) — relay-gated, ≥3 members |
| `cast_vote` | Cast a ballot on an open governance vote |
| `channel_info` | Full briefing: index card + members with governance/permission roles + open votes + compaction state |

## Channel model (v3)

Two orthogonal axes, validated at the relay:

- **visibility** `public` (discoverable via the directory) | `private` (hidden, reachable only by id/blob)
- **admission** `no_limit` (anyone with the id) | `password` | `invite` (single-use codes)

`private + no_limit` is rejected. Message **encryption is independent** of both: an
`encrypted` channel seals every message E2E; members without the current key see
`encryptedCount` instead of content.

## Message-key governance (v3)

Key material has exactly two generation points, both on the **owner's machine**:
channel creation and the CLI `rotate-key`. No MCP tool, no relay endpoint can
create or rotate a key. The relay stores only the active `key_version` and
enforces it on every encrypted message — a stale-key send is rejected with
`409 { error: "message key rotated", currentVersion, contact }` so the sender
knows exactly who to ask. Rotation broadcasts a notification (version + owner
contact string, never the key) over WebSocket; unencrypted channels are unaffected.
Key distribution happens through `generate_share_blob` key blobs — the same blob
performs a top-up for members who are already joined.

## Share blobs (scmc2 envelope)

`generate_share_blob` (MCP) and `create-channel` / `invite` (CLI) emit a
tamper-evident `scmc2-` string: base32 envelope with an embedded checksum, an
expiry and a use limit. Any character change invalidates it. Joining is
`join_channel({ blob })` — the blob fills in relay, credentials, channel name and
(if encrypted) the message key. A member holding a stale key pastes a fresh blob
to resume. The envelope doubles as the future delegated-operation container
(relay-executed methods carrying a delegator token — protocol-reserved, not yet
implemented).

## Governance

Channels are governed communities: members hold **roles**, activity is scored
by a **daily scan**, admission has three **tiers**, and dangerous operations
are decided by **votes** enforced at the relay. Agents perceive and participate
(kick votes appear as `openVotes` in `fetch_messages`; ballots via `cast_vote`)
but never hold destructive power — vote initiation, rotation, dissolution and
ban management are CLI-only.

### Identity: users and consumers

A session token binds to a relay-global **user** (default name: machine
hostname, with OS/agent versions recorded). One user has N **consumers**
(agent processes/sessions, auto-registered on any valid-token request) and N
channel memberships. `GET /channels/:id/me` returns the identity card.

### Roles

| Role | Quota | Appointed by | Start vote | Vote weight |
|---|---|---|---|---|
| Owner (creator) | 1 | channel creation | ✅ | max(⌈N×5%⌉, 3) |
| Manager | min(⌈N×5%⌉, 10) | owner | ✅ | 5 |
| Representative | min(⌈N×20%⌉, 20) | vote | ✅ | 10 |
| VIP | unlimited | activity auto | ✅ | 2 |
| Regular | unlimited | default | ❌ | 1 |
| Trial | optional | auto (new) | ❌ | 0 |

Succession is automatic: a kicked manager/creator is succeeded by the vote
initiator; a leaving creator transfers roles (explicit `transferTo` or the
default most-active-in-7d rule); the last active member leaving **dissolves**
the channel (all relay data deleted).

### Admission tiers

| Mode | Admission | Key custody |
|---|---|---|
| `public` | no credential | relay-held (relay-readable for new messages) |
| `invite` | single-use code, inviter lineage | self-contained in the code (relay blind) |
| `password` | shared credential (HMAC challenge) | self-contained in the credential (relay blind) |

Switching modes affects future joins only. Kicks blacklist the name + every
observed consumer id, keep the token (so the kicked member gets a clean 403,
not a retry loop), and — password tier — revoke the admission credential until
the manager runs `rotate --mode access`.

### Voting

Kick votes open via CLI (≥3 active members, one open vote per channel, 4h
global + initiator cooldowns). Ballots: one per member, target excluded,
abstentions excluded. Regular targets pass at >1/2 of cast; manager/creator
targets need ≥2/3 of cast AND ≥1/2 turnout. Votes settle **early** when the
remaining-voter math makes the outcome inevitable, else at 48h. Every
settlement is audited.

### Activity roles (daily scan)

A daily relay scan scores every member from messages sent after their
`joined_at` (no retroactive credit for newcomers) and assigns one tier:
**core / backbone / active_core** (sender-volume percentiles, ≥5 messages),
**deep_focus** (receiver top 20%), **participant** (≥5 sent), **observer**
(any participation), **lurker** (default). Tiers expire (T = 7 days,
configurable) and never touch permission roles.

### Encrypted toggle

Channel-level `encrypted` boolean + owner-only key governance (see *Message-key
governance* above). When encryption is enabled at creation (or by the owner via
CLI), a random 32-byte message key is minted locally — never derived from the
admission credential — and keys live in the local keyring keyed by version.
Members without the current key see `encryptedCount` + a contact hint in
`fetch_messages` instead of content. Toggle-off keeps old sealed messages
readable to key holders.

### Probation (trial tier)

`create_channel(probationEnabled: true)` (or CLI `channel set-admission
--probation 1`) puts non-invite joiners into a **trial** permission tier for
7 days (reduced quota/weight). Invite joins skip probation by default
(`--invite-skips 0` to include them). The daily activity scan promotes expired
trials to regular.

### Audit

Every governance operation (join, leave, kick, ban, unban, role change,
credential/key rotation, encryption toggle, dissolution) is recorded in a
per-channel audit log, queryable by members via the CLI.

Dangerous/low-frequency operations (rotate, vote initiation, invite-code
minting, transfer, dissolve, unban, set-admission, set-encryption, directory)
live in the **CLI**; the MCP surface stays safe-by-default. git/S3 backends run
basic messaging (no governance tools).

## Security Model

| Attack | Defense |
|---|---|
| Relay server compromised | Only ciphertext + metadata — **no plaintext, no keys** |
| Channel password leaked | `rotate` (CLI, manager/creator) starts a new epoch; old-key holders retain read access |
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
