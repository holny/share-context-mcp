# Channel Model & Blob Engine — Design (v3 iteration)

Date: 2026-10-30 · Branch: `feat/channel-model-v3` (base: `feat/governance-v2` @ 017457d)

## 1. Goals

1. Two-axis channel model: **visibility (public/private)** × **admission mode (no_limit/password/invite)**.
2. Message-key governance: **only the owner's CLI** ever creates/rotates message keys; the relay **enforces key_version** on every encrypted message; rotation broadcasts a notification (no key material).
3. **Blob engine**: a unified, tamper-evident, optionally time-limited blob envelope. v1 ships client-executable share blobs (`generate_share_blob`); relay-executable delegated blobs are protocol-reserved.
4. Tool surface grows 7 → **11**, with `channel_id` required on every channel-scoped tool.
5. Probation (试用期) for new members; invite-tier joins skip it by default.
6. Fix: a vote whose target leaves mid-vote **continues** (ban applies on pass even to the departed member).

## 2. Channel model

### 2.1 Two orthogonal axes

```
visibility = public | private          → discoverability (directory search)
admission_mode = no_limit | password | invite   → how members join

Constraint: private + no_limit is REJECTED (400).
```

| visibility | admission | allowed | directory |
|---|---|---|---|
| public | no_limit | ✅ | listed |
| public | password | ✅ | listed |
| public | invite | ✅ | listed |
| private | no_limit | ❌ 400 | — |
| private | password | ✅ | hidden |
| private | invite | ✅ | hidden |

### 2.2 Migration

- `channels.visibility TEXT NOT NULL DEFAULT 'public'` (ALTER TABLE additive).
- Admission mode rename: existing `'public'` rows map to `'no_limit'`. One-time migration on startup; `set-admission` validates against the new enum.
- `create_channel` params: `{ name, memberName, visibility, admissionMode, password?, encrypted?, probationEnabled? }`. `visibility` defaults `public`; `admissionMode` defaults `password` for private, `no_limit` allowed only for public.
- `set-admission` accepts `{ visibility?, admissionMode? }`, validates the pair, writes audit.

### 2.3 Encryption interplay

- `encrypted` is an independent channel flag (default false), orthogonal to both axes.
- public + encrypted: the relay holds the message key (stored sealed) so free-join members can decrypt; switching visibility to private **deletes the relay-held copy** — but since the relay then knows the key, blind-ness is only restored by a **key rotation** (owner CLI; relay notifies members).
- private + encrypted: relay is blind (key never leaves clients except inside blobs).

## 3. Message-key governance (owner-only)

### 3.1 Invariants

1. **Generation points**: channel creation (owner's local machine) and `rotate-key` CLI (owner only). Nothing else — no MCP tool, no relay endpoint — creates or updates key material.
2. The relay stores only: `channels.encrypted`, `channels.key_version`, and (public tier only) the sealed key copy. It never stores keys for private channels.
3. One channel has exactly one active key version at any time.

### 3.2 Relay enforcement

`POST /channels/:id/messages` with `encrypted: true`:

```
if (msg.key_version !== channel.key_version) → 409 {
  error: "message key rotated",
  currentVersion: <n>,
  contact: <owner-customizable contact string>,
  rotatedAt: <iso>
}
```

Unencrypted messages are unaffected. The MCP server surfaces this error verbatim to the agent ("your key is v2, current is v3, contact alice").

### 3.3 Rotation flow

```
owner CLI: rotate-key --id <channel>
  ① owner generates new key locally → keyring[v+1]
  ② POST /channels/:id/rotate-key { keyVersion: v+1, sealedKey?: (public tier only) }
     — owner-token gated (creator/manager per governance rules; see §3.4)
  ③ relay: UPDATE channels SET key_version = v+1 (+ sealed copy if public)
  ④ relay WS-broadcasts: { type: "key_rotated", keyVersion: v+1, contact, rotatedAt }
     — NEVER the key material
  ⑤ members on old key: sends rejected (409 above) → they obtain a new blob from
     the owner → join_channel detects "already member, key v+1 missing" →
     loads key from blob → resumed
```

`contact` is an owner-editable string (`set-contact` CLI / fold into existing contact_info) — the relay returns it verbatim in every key-mismatch error and rotation notice.

### 3.4 Authority

Key creation/rotation authority = the **owner** (creator). (Manager may rotate admission credentials as today; key material stays owner-only per product decision.)

### 3.5 set-encryption changes

The current `set-encryption` endpoint (client generates key on toggle-ON) is **removed from the MCP surface**. Encryption is set at `create_channel(encrypted: true)` or enabled by the owner via CLI `set-encryption` (which mints v1 if none exists). Manager/creator gated as before; audit unchanged.

## 4. Blob engine

### 4.1 Unified envelope (scmc2)

```
scmc2-<base32( version(1) ‖ type ‖ flags ‖ expires_at(8) ‖ max_uses(4) ‖ AEAD payload )>
```

- AEAD (AES-256-GCM) → changing any character breaks the GCM tag → blob invalid. Tamper-evidence is cryptographic for relay-sealed blobs, parse-level + relay-registry-backed for client blobs.
- `type` names an executable method; the registry is open-ended (future types plug in).
- `expires_at` optional (invite blobs: +7d; delegated blobs: short TTL).
- `max_uses` optional (invite codes: 1).

### 4.2 Two execution classes

**Client-executable (v1)** — payload readable by the recipient's MCP server; the relay never needs to understand it:

| type | payload | produced by |
|---|---|---|
| `join_password` | channelId, relayUrl, password, messageKey?, keyVersion, channelName, visibility, admissionMode | `generate_share_blob` (private+password channels) |
| `join_invite` | channelId, relayUrl, inviteCode, messageKey?, keyVersion, ... | `generate_share_blob` (invite channels; mints a fresh single-use code, 7d TTL) |
| `join_key` | channelId, messageKey, keyVersion | `generate_share_blob` (public+encrypted channels — key-only share) |
| `key_update` | channelId, messageKey, keyVersion | owner CLI `share-key` (post-rotation distribution) |

**Relay-executable (protocol-reserved, not implemented in v1)** — payload sealed to a relay master key; carries the delegator's token (unextractable by the executor):

```
POST /blobs/execute  { blob }   + executor token/consumer headers
relay: auth(executor) → AEAD-verify → expiry/uses check → unseal delegator token
     → validate delegator still a member → authorize method PER DELEGATOR's role
     → execute ONLY payload.method → uses++ → audit(executor, delegator, method,
     result) → notify delegator → return result to executor
```

v1 delivers: envelope format, type registry design, this endpoint contract in the spec. No endpoint code.

### 4.3 `generate_share_blob` (MCP tool)

```
generate_share_blob(channel_id)   — single param, type auto-inferred
```

| channel state | blob type |
|---|---|
| admission=invite | `join_invite` (mints code, 7d TTL, single-use) |
| admission=password ∧ visibility=private | `join_password` |
| admission=password ∧ visibility=public ∧ encrypted | `join_key` |
| admission=password ∧ visibility=public ∧ ¬encrypted | `join_password` (password is the gate) |
| admission=no_limit ∧ encrypted | `join_key` |
| admission=no_limit ∧ ¬encrypted | 400 "nothing to share" |

`messageKey` is embedded iff `encrypted=true` and the local keyring has the current version (members can read the key; they can never create or change one).

### 4.4 Blob presentation text

```
📢 share-context-mcp channel share

Type:      INVITE (one-time, expires 2026-11-06)
Channel:   auth-refactor (private, encrypted)
Inviter:   alice — role: creator/owner, activity: core pillar
Shared at: 2026-10-30T14:22Z

Key string (paste this line to your agent):
scmc1-XXXX...

Your agent will use it to join the channel (and decrypt history if encrypted).
```

- Exactly **one** key string per blob; everything else is agent-facing context.
- Inviter role/activity are mint-time snapshots.
- The type line is mandatory and explicit (invite / password / message-encryption-key).

### 4.5 `join_channel` blob path

`join_channel(channel_id?, member_name?, password?, invite_code?, blob?)` — if `blob` is given the other params are extracted from it. A member who is already joined but missing the current key version gets **key top-up** (no re-join, no error).

## 5. Tool surface (11 tools, channel_id required where scoped)

| # | tool | required | notes |
|---|---|---|---|
| 1 | `send_message` | channel_id | E2E or plaintext per channel flag; key-mismatch error surfaced verbatim |
| 2 | `fetch_messages` | channel_id | delta/search/topic/vote-aware/encryptedCount |
| 3 | `create_channel` | — | visibility + admissionMode + password? + encrypted? + probation? |
| 4 | `join_channel` | channel_id | password?/invite_code?/blob?; auto key top-up |
| 5 | `leave_channel` | channel_id | transfer_to? succession |
| 6 | `generate_share_blob` | channel_id | §4.3 |
| 7 | `list_channels` | — | joined channels + roles/activity/votes |
| 8 | `list_members` | channel_id | |
| 9 | `start_vote` | channel_id | MCP surface now (was CLI-only); governance checks unchanged |
| 10 | `cast_vote` | channel_id + vote_id | |
| 11 | `channel_info` | channel_id | index card |

Split of the consolidated `channel`/`list` tools: the v2 consolidation saved names but cost action-dispatch indirection; with 11 explicit tools each has a flat, required-`channel_id` signature. `join_from_blob` folds into `join_channel(blob)`.

## 6. Probation (试用期)

- `channels.probation_enabled INTEGER DEFAULT 0`; set at create or via CLI `set-probation`.
- `channels.invite_skips_probation INTEGER DEFAULT 1`.
- Member row gains `probation_until TEXT NULL`. On join: if `probation_enabled` and not (invite-join ∧ invite_skips_probation) → `probation_until = now + 7d`, permission role = **trial** (existing role tier) until then.
- Trial → regular promotion happens in the daily activity scan (already scheduled): `probation_until < now` → promote to regular.
- Trial members: existing trial-role restrictions apply (reduced quota/weight per governance spec).

## 7. Voting fix: target leaves mid-vote

Today `settleVote` marks the vote `expired` when the target is inactive (routes.ts:338). Change: **the vote continues**. Ballot math counts the remaining eligible voters; on pass, `applyKick` writes the ban **even if the target already left** (ban blocks re-entry at the admission gate); on fail, nothing. Remove the void branch; keep the "target cannot vote" rule.

## 8. Relay API delta

| endpoint | change |
|---|---|
| `POST /channels` (create) | + visibility, probation flags; admission enum `no_limit` |
| `POST /channels/:id/set-admission` | + visibility; validates pair |
| `POST /channels/:id/set-encryption` | owner/manager CLI-only semantics (no client key minting; mints v1 from provided sealed key) |
| `POST /channels/:id/rotate-key` | NEW — owner-gated; sets key_version, optional sealed key (public tier), WS broadcast, audit |
| `POST /channels/:id/messages` | 409 on key_version mismatch (§3.2) |
| `POST /channels/:id/votes` | now callable from MCP (start_vote) — same governance checks as CLI |
| `GET /directory` | public channels only |
| `POST /blobs/execute` | RESERVED — not implemented |

## 9. Data model delta

```
channels: + visibility TEXT DEFAULT 'public'
          + probation_enabled INTEGER DEFAULT 0
          + invite_skips_probation INTEGER DEFAULT 1
          + sealed_key TEXT NULL          -- public tier only
          migrate admission_mode 'public' → 'no_limit'
members:   + probation_until TEXT NULL
```

## 10. Test plan (TDD)

- protocol: scmc2 envelope round-trip; single-char mutation → parse failure; expiry/max_uses fields.
- relay: visibility×admission validation (incl. private+no_limit 400); key_version mismatch 409 with contact; rotate-key broadcast; directory filters private; probation assignment + promote; target-left vote settles and bans.
- server: 11 tools flat signatures (channel_id required — missing → tool error); generate_share_blob inference matrix (6 rows); join_channel blob path + key top-up; start_vote from MCP.
- e2e: create private encrypted channel (owner) → generate blob → second agent joins via blob → sends encrypted → owner rotate-key → old-key send rejected with contact → new blob → top-up → resumed. Plus probation path and target-left-vote path.

## 11. Out of scope (v1)

- Relay-executable delegated blobs (`/blobs/execute` implementation), `mint_invite` delegation.
- Multimodal message types.
- Anything keyed off `visibility` beyond directory + share rules.
