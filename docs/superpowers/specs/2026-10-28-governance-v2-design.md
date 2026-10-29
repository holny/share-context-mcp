# Governance: Roles, Tiers, Voting, Key Management — Design v2

Date: 2026-10-29
Status: Approved
Supersedes: 2026-10-28-governance-channel-types-voting-design.md (this doc is the
final refined version incorporating all owner feedback)

## 1. Intent

Transform share-context-mcp from "a shared context channel" into a governed
community platform for human teams + agent autonomous networks. Members have
roles and activity levels; channels have admission tiers; governance actions
are enforced by the relay; agents perceive and participate but never hold
destructive power.

## 2. Channel Admission Tiers

Three tiers, switchable by manager/creator (future-admissions-only semantics;
existing members, tokens, and message keys untouched).

| | public | invite | password |
|---|---|---|---|
| Admission | no credential | single-use invite code | shared credential |
| Message key | relay-held (relay can decrypt new messages) | self-contained in code (relay blind) | self-contained in credential (relay blind) |
| Kick re-entry | needs no credential — ban list is the only gate | needs fresh code from member | old credential dead; ban list + credential rotation both block |
| Directory | listed by default | opt-in (manager sets contact) | opt-in (manager sets contact) |

**Message key is INDEPENDENT of admission mode** — a channel-level `encrypted`
boolean + `keyVersion` counter. Switching modes never touches the message key.
Only explicit key rotation (manager/creator CLI) changes it. `rotate --mode
access` re-wraps the SAME key; `rotate --mode full` generates a NEW key.

## 3. User / Consumer Model

```
users (per relay):
  user_id (relay-generated, global unique)
  name (default: machine hostname)
  ip, os_type, os_version, mcp_version
  token_hash, registered_at, last_active_at

consumers (per user, 1:N):
  consumer_id (relay-generated)
  user_id (FK)
  agent_type (opencode / claude-code / pi / ...)
  agent_version
  session_id
  last_active_at

channel_members (per channel per user):
  channel_id + user_id (composite PK)
  permission_role: owner | manager | rep | vip | regular | trial
  activity_role: core | backbone | active_core | deep_focus |
                 participant | observer | lurker
  activity_expires_at
  can_invite (default: 1)
  joined_at
  status: active | banned | left
```

Token = user identity (not channel). One token → one relay connection → one
user → N consumers → N channel memberships. Consumer ids auto-register on
valid token; banned consumer ids are rejected.

## 4. Permission Roles (per channel, one per member, high overrides low)

| Role | Quota | Appointed by | Start vote | Cast vote | Vote weight | Can be kicked | Can be silenced |
|---|---|---|---|---|---|---|---|
| **Owner** | 1 | Creation | ✅ | ✅ | max(⌈N×5%⌉, 3) | ❌ | ❌ |
| **Manager** | min(⌈N×5%⌉, 10) | Owner | ✅ | ✅ | 5 | ❌ (vote only) | ✅ |
| **Representative** | min(⌈N×20%⌉, 20) | Vote | ✅ | ✅ | 10 | ✅ (vote) | ❌ |
| **VIP** | unlimited | Activity auto | ✅ | ✅ | 2 | ✅ (mgr+rep) | ✅ (mgr+rep) |
| **Regular** | unlimited | Default | ❌ | ✅ | 1 | ✅ (mgr+rep) | ✅ (mgr+rep) |
| **Trial** | optional | Auto (new) | ❌ | ❌ | 0 | ✅ (mgr+rep) | ✅ (mgr+rep) |

N = current active member count.

**Succession rules:**
- Kicked manager → vote initiator takes manager
- Kicked creator → vote initiator takes creator (if initiator was already
  manager, they take both)
- Creator leaves → transferTo (specified) or default (most messages in
  trailing 7d among active members, tie → earliest joined)
- Manager leaves (not creator) → reverts to creator
- Last active member leaves → **dissolve** (all relay data deleted)

## 5. Activity Roles (per channel, one per member, daily scan)

| Level | Expiry | Permission downgrade | Promotion criteria (daily scan, N≥10) |
|---|---|---|---|
| **核心支柱** (Core Pillar) | T days | VIP | sender count top 5% AND ≥5 msgs |
| **中坚力量** (Backbone) | T days | VIP | sender count top 5–20% AND ≥5 msgs |
| **活跃骨干** (Active Core) | T days | VIP | sender count top 20–60% AND ≥5 msgs |
| **深度关注** (Deep Focus) | T days | VIP | receiver count top 20% AND ≥5 msgs |
| **参与者** (Participant) | 2T days | Regular | sender count ≥5 msgs |
| **旁观者** (Observer) | T days | Regular | receiver count ≥1 OR sender ≥1 |
| **潜水员** (Lurker) | — | — | default (new / inactive) |

T = 7 days (configurable). Scan is atomic per channel. `receiver count` =
messages sent after this member's `joined_at` (new members don't retroactively
count). Permission roles are NOT affected by activity expiry.

### Probation system
Manager toggles per channel: probation period S days (0–7, 0 = off), whether
trial members can send/vote, criteria (send X, read Y). After S days: meets
criteria → Regular; no criteria → manager decides; fails → kicked. Manager
and representative can early-promote. Cooling: S days after passing before
re-entering probation.

## 6. Generic Vote Module

### Vote types (v1: kick; extensible)
1. **kick** — ban a member
2. **poll** — data statistics (question + options, single/multi select)
3. **grant-role** — vote to grant Representative role (v2)

### Initiation (CLI only — dangerous op)
Requirements: ≥3 active members, no open vote, initiator not in cooldown,
target active ≠ initiator. Body: `{type, target?, reason?, options?,
banIp?, revokeInvitees?}`.

### Balloting (MCP `cast_vote`)
One ballot per member, target excluded. Choice: `yes` | `no`. Abstentions
(not voting) excluded from denominators.

### Thresholds
| Target | Pass condition |
|---|---|
| Regular | yes > 1/2 of cast |
| Manager/Creator | yes ≥ 2/3 of cast AND cast ≥ 1/2 of active |

### Early resolution (remaining-voter math)
- **Early pass** (regular): yes > (cast + remaining) / 2
- **Early pass** (leadership): yes ≥ ⌈2×(cast+remaining)/3⌉ AND
  (cast ≥ ⌈active/2⌉ OR cast+remaining ≥ ⌈active/2⌉)
- **Early fail** (regular): yes + remaining ≤ cast/2
- **Early fail** (leadership): yes + remaining < ⌈2×(cast+remaining)/3⌉
- Otherwise: open until 48h expiry, then settle by final thresholds

### Cooldowns
| Trigger | Effect | Duration |
|---|---|---|
| Any vote settles | Channel global cooldown | 4 hours |
| Vote PASSES | Initiator cannot start new vote | 48 hours |
| Vote FAILS | Initiator cannot start new vote | 7 days |

### Vote options
- `--ban-ip`: also ban the target's recorded IP (NAT caveat)
- `--revoke-invitees`: strip invite rights from everyone the target invited
  (manager/creator exempt from automatic revocation)

## 7. Kick Enforcement (applyKick)

1. Member status → `banned` (token KEPT so authenticate resolves → 403
   not 401)
2. Name + all observed consumer_ids → `member_bans` blacklist
3. Optional IP ban (if `--ban-ip`)
4. Password tier: `admission_credential_revoked = 1` → joins with old
   credential fail until manager does `rotate --mode access`
5. Succession: kicked manager → initiator; kicked creator → initiator
   (initiator with both roles → takes both)
6. Invite tier: target's used code revoked permanently; owner notified to
   re-mint; code slot dies if owner gone
7. `--revoke-invitees`: target's invitees lose `can_invite` (manager/creator
   exempt)

## 8. Admission Gate Enforcement

The join gate checks — in order:
1. `admission_credential_revoked = 1` + password mode + not creator → 403
2. Ban list: member name in `member_bans` → 403
3. Ban list: consumer_id appears in ANY ban row's consumer_ids → 403
4. Invite mode + not creator: valid `inviteCodeId` required (registered,
   active, not expired, not used)
5. Password mode or creator: credential proof required (HMAC challenge)

## 9. Multi-channel & Consumer Ledger

- `consumer_channels(consumer_id, channel_id, joined_at)` table in local
  SQLite, persisted across restarts
- `join_channel` / `create_channel` records the consumer→channel pair
- `list_channels` (MCP) reads the session's ledger
- Unknown consumer ids on token-authed requests auto-register (valid token =
  membership proof); ban list is the enforcement point
- All tool responses echo `channelId`

## 10. Cache + DB Dual Layer

| Operation type | Path | Rationale |
|---|---|---|
| Role changes, votes, bans, admission, dissolve, credential rotation | **Direct DB write** + cache update | Strong consistency required |
| last_seen, consumer registration, message counts, presence, activity scores | **Cache write → 30s flush** | High-frequency, tolerant of seconds-level delay |

Implementation: `GovernanceCache` class with `Map<string, {data, dirty}>`,
`get/set/flushAll`, 30s timer + SIGINT flush + 1000-dirty-threshold early
flush.

## 11. Message Encryption (channel-level `encrypted` boolean)

- Default: **false** (no message key; messages stored as plaintext JSON at
  relay; admission credentials short)
- Toggle ON: manager/creator generates message key (random 32 bytes), wraps
  it inside new credentials/codes, stores `keyVersion` at relay
- Toggle OFF: new messages plaintext; old encrypted messages remain readable
  to key holders
- Message key NEVER derives from the admission credential — independent
  random secret with its own lifecycle
- Members without the key see: `[🔒 N messages encrypted — contact
  {manager} for access]` in fetch_messages output
- `keyVersion` on each message row enables multi-version decrypt (keyring)

## 12. Relay Cache Flush & Governance Endpoints Summary

### Endpoints (20 total)
| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| /channels | POST | none | Create channel |
| /directory | GET | none | Search opt-in channels |
| /channels/:id/challenge | POST | none | Issue nonce (password tier) |
| /channels/:id/join | POST | code/proof per tier | Join channel |
| /channels/:id/consumers | POST | Bearer | Register consumer id |
| /channels/:id/token-refresh | POST | Bearer | Rotate token |
| /channels/:id/messages | GET+POST | Bearer | Fetch/send messages |
| /channels/:id/meta | GET | Bearer | Channel metadata + roles + stats |
| /channels/:id/activity | POST | Bearer | Presence receipt |
| /channels/:id/rotate | POST | Bearer | Full rotate (manager/creator) |
| /channels/:id/set-admission | POST | Bearer | Switch mode/policy (mgr/creator) |
| /channels/:id/set-credential | POST | Bearer | Swap admission credential (mgr/creator) |
| /channels/:id/transfer | POST | Bearer | Transfer manager role (creator) |
| /channels/:id/leave | POST | Bearer | Leave (succession/dissolution) |
| /channels/:id/votes | GET+POST | Bearer | List/open votes |
| /channels/:id/votes/:vid/ballot | POST | Bearer | Cast ballot |
| /channels/:id/bans | GET | Bearer | List banned members |
| /channels/:id/unban | POST | Bearer | Unban (mgr/creator) |
| /channels/:id/invite-rights | POST | Bearer | Toggle member invite right (mgr/creator) |
| /channels/:id/member-stats | GET | Bearer | Per-member message stats |
| /channels/:id/dissolve | POST | Bearer | Explicit dissolve (mgr/creator) |
| /channels/:id/audit | GET | Bearer | Governance audit log |

## 13. MCP Tools (7 final)

```
1. send_message(statement, kind, topic, detail?, scope?, to?, channelId?)
2. fetch_messages(since?, query?, topic?, kind?, limit?, setFilters?, channelId?)
   → returns: { channelId, messages, openVotes?, encryptedCount?, cursor, remaining }
3. channel(action: "create"|"join"|"leave", ...action-specific params)
4. list(scope: "channels"|"members", query?, channelId?)
5. start_vote(type, target?, reason?, options?, channelId?)     [CLI-only op,
   MCP surface omits this — but the relay endpoint accepts any member]
6. cast_vote(voteId, choice, channelId?)
7. channel_info(channelId?) — full index card + members + votes + compaction
```

Merged from 11 → 7:
- `share_update` → `send_message`
- `fetch_updates` + `catch_up` + `search_messages` + `set_subscription` → `fetch_messages`
- `create_channel` + `join_channel` + `leave_channel` → `channel(action, ...)`
- `list_channels` + `list_members` → `list(scope, ...)`

## 14. Join Blob (copy-paste onboarding)

```
📢 share-context-mcp 通道邀请

通道: auth-refactor (invite 层)
中继: https://relay.corp.internal:8931
邀请人: alice

邀请码（一次性，7 天内有效）:
scmc1-A4TF...CE4A

操作方式: 将此文本粘贴给你的 Agent，或运行:
  share-context join --blob "<blob>"
```

Blob payload (base64 JSON): `{relayUrl, channelId, credential?, inviteCode?,
channelName, admissionMode}`. New MCP tool `join_from_blob(blob)` parses and
executes the full join flow.

## 15. Left to the Builder

- GovernanceCache implementation (Map + dirty tracking + flush timer)
- Daily activity scan job (cron / setInterval)
- Compaction state machine + notification frames
- Key version management (keyring in server store)
- Vote notification frames (WS + poll) excluding target
- sender column backfill impossible for legacy rows — documented
- Member-stats query optimization (prepared statements)

## 16. Future Extensions

- Vote types beyond kick (poll, grant-role) via the action registry
- Multi-media message types (image, PDF) via envelope metadata
- Signed provenance for non-forgeable statistics
- Cross-relay federation
