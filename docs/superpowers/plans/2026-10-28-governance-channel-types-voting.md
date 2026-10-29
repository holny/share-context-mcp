# Governance, Channel Types & Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforceable governance for share-context-mcp: creator/manager roles, three admission modes (public/invite/password), per-member long-lived tokens bound to consumer ids, token-ban kicks with automatic admission-credential rotation, a generic relay-side vote module (v1: kick), CLI/MCP surface split, and multi-channel tooling.

**Architecture:** The relay owns all governance state (roles, bans, votes, invite ledger, audit log) as metadata — still content-blind for password/invite tiers. Admission credentials become self-contained (verify-hash at relay + wrapped message key inside the credential, client-minted), so credential rotation never changes the message key. The MCP surface sheds dangerous ops (`rotate_password` removed, `leave_channel` → CLI) and gains `cast_vote` / `list_channels`; every response echoes `channelId`; every request carries `X-SCM-Consumer`.

**Tech Stack:** Bun + TypeScript, bun:sqlite, existing workspace packages `@share-context-mcp/{protocol,relay,server}`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-28-governance-channel-types-voting-design.md`

## Global Constraints

- Relay stays content-blind in password/invite tiers: governance state is metadata (names, ids, counters, hashes) only.
- Message key is random at creation, self-contained inside admission credentials — **never derives from the admission credential**; credential rotation re-wraps the SAME key.
- Kick (password tier) = token ban + name/consumer-id blacklist + relay-side admission-credential invalidation; the acting manager/creator mints the replacement credential (CLI prints once). Message key untouched.
- All governance ops are manager/creator-gated at the relay; audit-logged.
- MCP surface changes are breaking: remove `rotate_password`; add `cast_vote`, `list_channels`; all responses echo `channelId`.
- git/S3 bridges: governance tools not registered (basic mode).
- Vote params: ≥3 active members to open; single open vote per channel; manager/creator target needs `yes ≥ 2/3 of cast` AND `cast ≥ 1/2 of active`; regular target needs `yes > 1/2 of cast`; 48h validity; early resolution; 4h global cooldown; initiator cooldown 48h after pass / 7d after fail; target cannot vote; abstentions excluded.
- Invite codes: default TTL 7d (per-mint `--ttl`), single-use, lineage (`invite_id → owner → used_by`); vote-open freeze; pass ⇒ target code revoked + owner notified to re-mint, invitee codes banned 7d post-settlement; fail ⇒ freeze lifted.
- Tests: `bun test` green per task; English copy; zero internal-name references.

## Review Focus

1. **Consumer_id ban bypass**: a banned consumer re-challenging under a new name but the SAME resumed session must be rejected (consumer-id match). → Task 2 test.
2. **Vote double-settlement**: early resolution and 48h expiry must be idempotent — settling twice must not double-apply bans or cooldowns. → Task 6 test.
3. **Admission-mode switch with open vote**: switching public/invite/password mid-vote must not void the vote or strand ballots. → Task 6 test.
4. **Manager succession loop**: kicking the initiator after they became manager must transfer manager to creator (not to themselves). → Task 5 test.
5. **Invite freeze fail-path**: a failed vote must lift the lineage freeze automatically and exactly (no lingering frozen codes). → Task 6 test.

---

### Task 1: Relay schema — roles, bans, consumers, invite ledger, audit log

**Files:**
- Modify: `packages/relay/src/db.ts` (migrations ~line 40, ChannelRow, new tables)
- Modify: `packages/relay/src/routes.ts` (create channel: record creator; helpers `isManager`/`isCreator`, `audit()`)
- Test: `packages/relay/test/relay.test.ts`

**Interfaces:**
- Produces: `ChannelRow` gains `creator_member: string; manager_member: string; admission_mode: string ('public'|'invite'|'password'); invite_policy: string ('everyone'|'managers-only'); contact_info: string | null; vote_cooldown_until: number`. `MemberRow` gains `status: string ('active'|'banned'|'left'); can_invite: number; token_hash: string | null`.
- Produces: new tables `member_bans(channel_id, name, consumer_ids, ip, banned_at, banned_by)`, `member_consumer_ids(channel_id, member_name, consumer_id, last_seen)`, `audit_log(channel_id, ts, actor, action, target, result)`, `invite_codes(channel_id, code_id, owner, created_at, expires_at, used_by, status)`, `votes(...)`, `ballots(...)` (vote tables created here, used in Task 6).
- Produces: `audit(db, channelId, actor, action, target, result)` helper (INSERT into audit_log, ISO ts).
- `createChannel` payload gains optional `creatorMember` — actually derived: the FIRST joiner is creator; create reserves the creator name as today, then manager/creator = that name. No payload change needed.

- [ ] **Step 1: Failing tests** in `relay.test.ts`: (a) after create+join, `GET meta` (or a debug query via relay handle) shows creator == joiner name and manager == joiner name; (b) `audit_log` has a `channel.created` entry; (c) migration columns exist (query `PRAGMA table_info` via a fresh relay on an old-shape DB is out of scope — fresh DB only).
- [ ] **Step 2: Run** `bun test packages/relay` — FAIL.
- [ ] **Step 3: Implement** — ALTER/CREATE migrations in `db.ts` (try/catch ALTER pattern); set `creator_member`/`manager_member` in the create + first-join flow; `audit()` helper called on create/join.
- [ ] **Step 4: Run** `bun test packages/relay` — PASS.
- [ ] **Step 5: Commit** — `feat(relay): governance schema — roles, bans, consumers, invites, votes, audit log`

### Task 2: Long-lived tokens bound to consumer ids

**Files:**
- Modify: `packages/relay/src/routes.ts` (challenge/join payload `consumerId`; token issuance without TTL by default; `member_consumer_ids` upsert on every authenticated request; token refresh endpoint; ban enforcement in `authenticate`)
- Modify: `packages/relay/src/index.ts` (token TTL option, default none)
- Modify: `packages/server/src/bridge/relay.ts` (sends `X-SCM-Consumer: <consumerId>` header on every request; join passes consumerId)
- Test: `packages/relay/test/relay.test.ts`, `packages/server/test/bridge.test.ts`

**Interfaces:**
- Produces (relay): `join` body gains `consumerId: string` (required, 1..64 chars); `authenticate()` now also (a) upserts `member_consumer_ids(channel, member, consumerId, last_seen=now)` when the header `X-SCM-Consumer` is present, (b) rejects 403 `banned` when `member.status === 'banned'` or the presented consumer_id is in `member_bans.consumer_ids`. Token TTL: `RelayOptions.tokenTtlMs` (default `null` = no expiry); `token_ttl` stored on member.
- Produces (relay): `POST /channels/:id/token-refresh` — Bearer auth with the CURRENT token + `X-SCM-Consumer`; issues a NEW token, invalidates the old (rotation). Response `{ token }`.
- Produces (bridge): `RelayBridge` gains `consumerId` param on constructor? No — consumer ids are per-session; the BRIDGE is per-process. Decision: the bridge sends `X-SCM-Consumer` only when constructed with `consumerId` option (MCP path passes `consumerIdFromExtra` per call is impossible at bridge layer — bridge requests are per-process). **Ruling**: relay binds consumer ids at JOIN time (the consumer that joined) plus every consumer id observed via the header when the MCP layer knows it. Bridge gains optional `consumerId` in constructor opts used for the header. Server `buildMcpServer` wires `bridge.consumerId = consumerIdFromExtra` per call via a NEW bridge method `setConsumer(id)`; header value = last set consumer (per-process single-active is acceptable; recorded as a ruling).

- [ ] **Step 1: Failing tests** in `relay.test.ts`: (a) join with `consumerId: "s/ses_x"` + `tokenTtlMs: null` → token works after 25h simulated (TTL null honored); (b) second join of same member with different consumerId → `member_consumer_ids` has both; (c) member banned (db update) → any authed request with banned name or banned consumerId → 403 `banned` (Review Focus 1: new name + SAME consumerId → 403); (d) token-refresh returns a new token that works and old token 401s. In `bridge.test.ts`: RelayBridge sends `X-SCM-Consumer` header when `consumerId` opt set.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Interfaces. Ban check BEFORE token check in `authenticate` ordering: resolve member by token, then status/consumer checks.
- [ ] **Step 4: Run** `bun test packages/relay packages/server` — PASS.
- [ ] **Step 5: Commit** — `feat(relay): long-lived per-member tokens bound to consumer ids; ban enforcement`

### Task 3: Admission modes — public / invite / password + switching

**Files:**
- Modify: `packages/relay/src/routes.ts` (join branching per mode; `set-admission`; directory; contact_info)
- Modify: `packages/server/src/bridge/types.ts` + `relay.ts` (join opts; `setAdmission`; `directory`)
- Test: `packages/relay/test/relay.test.ts`, `packages/server/test/bridge.test.ts`

**Interfaces:**
- Produces (relay): create payload gains `admissionMode` (default 'password'). Join branching: `public` — no challenge/proof required (direct join with name+consumerId); `password` — existing challenge/proof; `invite` — join body carries `inviteCodeId` + proof of possession of the code secret (HMAC-shape like password proof; the code's verify part is registered at mint). `POST /channels/:id/invite-codes` — REGISTER a minted code (`{ codeId, expiresAt }`): **manager/creator always allowed; regular members only when `invite_policy === 'everyone'` AND `can_invite = 1`** — else 403 `invite right revoked or managers-only policy` (this is the mint-right enforcement point). `POST /channels/:id/set-admission` {mode, invitePolicy?, contactInfo?} — manager/creator only (Task 5 helpers), 403 otherwise; audit-logged. `GET /directory?q=` — lists channels with `admission_mode='public'` OR `contact_info IS NOT NULL` (returns id, name, mode, member count, contact_info).
- Mode switch semantics: future admissions only; existing members/tokens untouched; open votes unaffected.

- [ ] **Step 1: Failing tests**: (a) create with `admissionMode: 'public'` → direct join without challenge works; (b) invite-mode channel rejects password-proof-only join without a registered `inviteCodeId`; (c) `set-admission` by non-manager → 403; by manager → mode changes, meta reflects it, audit entry written; (d) `directory?q=` returns public channel by name fragment, hides others without contact_info, includes contact_info when set; (e) invite-code register: manager always OK; regular member with `invite_policy='managers-only'` → 403, with `everyone` + `can_invite=1` → OK, with `can_invite=0` → 403.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Interfaces (relay); bridge methods `setAdmission(channelId, mode, opts)` and `directory(query)` thin wrappers; join opts gain `inviteCodeId`.
- [ ] **Step 4: Run** `bun test packages/relay packages/server` — PASS.
- [ ] **Step 5: Commit** — `feat(relay): admission modes public/invite/password with switching and directory`

### Task 4: Roles enforcement — rotate gating + leave/transfer/dissolve

**Files:**
- Modify: `packages/relay/src/routes.ts` (rotate → manager-only; `POST /channels/:id/leave` {transferTo?}; dissolve on last leave; transfer rules; `role-changed`/`member-left` WS frames)
- Modify: `packages/server/src/bridge/types.ts`, `relay.ts`, `s3.ts`, `git.ts` (leave with transferTo; transfer; dissolve detection)
- Test: `packages/relay/test/relay.test.ts`, `packages/server/test/bridge.test.ts`

**Interfaces:**
- Produces (relay): `rotate` requires `auth.member.name === channel.manager_member` → else 403 `manager only`. `POST leave` body `{ transferTo?: string }`: creator leave without transferTo applies the default rule (most messages trailing 7d excluding creator, tie → earliest joined; no qualifier → earliest joined overall); sets `creator_member`/`manager_member` accordingly; plain member leave just clears own tokens + status='left'. Last ACTIVE member leaving → **dissolve**: delete channels/members/messages/votes/ballots/invite_codes/bans rows; subsequent join → 404. Broadcasts `member-left` / `role-changed` frames (names only).
- Produces (bridge): `leave(channelId, opts?: { transferTo?: string })`; poll 404 handling → store.removeChannel + local state cleared (git/s3 no-op for role logic).

- [ ] **Step 1: Failing tests**: (a) non-manager rotate → 403 `manager only`; manager rotate → works; (b) creator leave with transferTo → creator_member = target, audit `role.changed`; (c) creator leave without transferTo → default-rule target becomes creator (fixture with known counts); (d) manager (not creator) leave → manager reverts to creator; (e) last member leave → channel dissolved: join → 404, messages gone; (f) WS frame `member-left` received by online member (reuse ws.test helpers).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Interfaces; WS frame types extended in `ws.ts` (`member-left`, `role-changed` carry names only).
- [ ] **Step 4: Run** `bun test packages/relay packages/server` — PASS.
- [ ] **Step 5: Commit** — `feat(relay): manager-gated rotate, leave with transfer, dissolution, governance broadcasts`

### Task 5: Kick enforcement + succession on kick

**Files:**
- Modify: `packages/relay/src/routes.ts` (kick application used by vote settlement: ban member, invalidate admission credential hash, succession)
- Test: `packages/relay/test/relay.test.ts` (unit via a direct settlement helper; end-to-end in Task 6)

**Interfaces:**
- Produces (relay): `applyKick(channelId, target, initiator): { succession: 'manager'|'creator'|null }` — sets member status `banned`, revokes tokens, writes `member_bans` (name + observed consumer_ids + optional ip), and succession per spec table (manager kicked → manager = initiator; creator kicked → creator = initiator; if initiator already manager → they take creator too). After a password-tier kick, `admission_credential_hash` is cleared → joins with the old credential fail with `admission credential revoked` until the manager registers a new one (via existing rotate endpoint).

- [ ] **Step 1: Failing tests**: (a) kick regular member → banned, old token 403, consumer ids blacklisted (new name + same consumer → 403, Review Focus 1 on the ban side), admission hash cleared → old-credential challenge fails with `admission credential revoked`; (b) kick manager (manager ≠ creator) → manager becomes initiator; (c) kick creator (creator ≠ manager) → creator becomes initiator; (d) kick initiator-as-manager → creator takes over (Review Focus 4: manager must not transfer to themselves).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `applyKick` per Interfaces; called from the vote settlement in Task 6.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(relay): kick enforcement — bans, credential invalidation, succession`

### Task 6: Generic vote module — kick v1

**Files:**
- Modify: `packages/relay/src/routes.ts` (`POST /channels/:id/votes` start [manager-gating none — any member; but CLI-only is a surface rule, relay accepts any member], `POST /channels/:id/votes/:vid/ballot`, `GET /channels/:id/votes` list + `GET .../votes/:vid`, settlement timer via the existing sweep interval, meta/poll gain `openVotes`)
- Modify: `packages/relay/src/ws.ts` (vote frames: `vote-open`, `vote-settled` — names/ids only)
- Test: `packages/relay/test/vote.test.ts` (new)

**Interfaces:**
- Produces (relay): start body `{ type: 'kick', target, reason?, banIp?, revokeInvitees? }`; validation per spec (≥3 active members, single open vote, initiator cooldown — channels.vote_cooldown_until + `votes` history for initiator 48h/7d rules; target active ≠ initiator); creates `open` vote, freezes target's invite code + invitee codes (`invite_codes.status='frozen'`), WS `vote-open` to all except target's connections.
- Ballot: `{ choice: 'yes'|'no' }` — one per member, target excluded (403), settled vote → 409 `vote settled`.
- Settlement: early when mathematically decided, else at 48h (sweep timer); idempotent (single settlement pass guarded by status transition inside a transaction — Review Focus 2). Applies kick via Task 5 `applyKick` when passed; `--revoke-invitees` sets target-invitees `can_invite=0` + invalidates their codes (7d post-settlement ban per spec); failure lifts the lineage freeze exactly (Review Focus 5). Sets cooldowns (4h global; initiator 48h/7d).
- Produces (poll/meta): `openVotes: [{ id, type, target, endsAt }]`; votes list endpoint returns history + tallies.

- [ ] **Step 1: Failing tests** (`vote.test.ts` — self-contained relay fixtures): open/validation matrix (<3 members rejected; second open vote rejected; cooldown rejected; target==initiator rejected); ballot rules (target 403, double ballot 409, settled 409); thresholds — regular member exactly `>1/2` pass, `=1/2` fail; manager target 2/3 of cast + turnout ≥1/2 active, below turnout → fail; early resolution (mathematically decided before 48h); expiry path via `sweepIntervalMs` short; `--revoke-invitees` pass → invitee `can_invite=0` + codes invalid + notified (audit rows); fail → freeze lifted (Review Focus 5); double-settlement idempotent (call settle twice, single ban/cooldown application — Review Focus 2); mode switch mid-vote does not void the vote (Review Focus 3); WS `vote-open`/`vote-settled` frames excluding target.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Interfaces; settlement logic exported as `settleVote(db, voteId)` for the sweep and called inline on each ballot when decided.
- [ ] **Step 4: Run** `bun test packages/relay` — PASS.
- [ ] **Step 5: Commit** — `feat(relay): generic vote module with kick v1, thresholds, cooldowns, lineage freeze`

### Task 7: MCP surface — cast_vote/list_channels, channelId echo, governance gating

**Files:**
- Modify: `packages/server/src/mcp.ts` (TOOL_NAMES; new tools; channelId echo in ALL tool responses; `safe()` unchanged)
- Modify: `packages/server/src/bridge/types.ts` (`castVote`, `votes`, `listChannels` bridge methods — relay-backed only), `bridge/relay.ts`
- Modify: `packages/server/src/instructions.ts`
- Test: `packages/server/test/mcp.test.ts` (new describe)

**Interfaces:**
- Produces: tools `cast_vote(voteId, choice, channelId?)`, `list_channels()` (session ledger from `consumer_channels`), and `consumer_channels` table in `store.ts` (`recordConsumerChannel(consumerId, channelId)`, `listConsumerChannels(consumerId)`).
- TOOL_NAMES: `- rotate_password`, `- leave_channel` (moved to CLI), `+ cast_vote`, `+ list_channels`. Responses of share_update/fetch_updates/catch_up/search_messages/list_members/join/create gain `channelId`.
- git/S3 gating: `buildMcpServer` checks `bridge.capabilities.governance` (new field on ChannelBridge: `governance: boolean`, true only for RelayBridge) — governance tools unregistered when false.
- MCP calls map to bridge: `castVote(channelId, voteId, choice)` → relay ballot endpoint. `openVotes` from poll responses surfaced in fetch_updates result.

- [ ] **Step 1: Failing tests**: (a) TOOL_NAMES excludes rotate_password/leave_channel, includes cast_vote/list_channels; (b) fetch_updates result contains `channelId` matching the channel; (c) list_channels returns only consumers' channels for that consumer id (two consumer ids → isolated ledgers); (d) cast_vote on relay fixture vote → ballot recorded (verify via relay votes list); (e) git/S3-mode buildMcpServer (capabilities.governance=false) has no cast_vote in tool list.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Interfaces; update tool descriptions (English); instructions paragraph for votes/multi-channel.
- [ ] **Step 4: Run** `bun test packages/server` — PASS.
- [ ] **Step 5: Commit** — `feat(server): cast_vote/list_channels tools, channelId echo, governance tool gating`

### Task 8: CLI surface

**Files:**
- Modify: `packages/cli/src/index.ts` (new commands)
- Test: `packages/cli/test/cli.test.ts` (new — spawn CLI against a real relay, like e2e but via CLI)

**Interfaces:**
- Produces commands (exact names): `channel list`, `channel info <id>`, `channel bans <id>`, `channel unban <id> --name N`, `channel revoke-invite <id> --name N`, `channel grant-invite <id> --name N`, `channel transfer <id> --to N`, `channel dissolve <id>`, `channel set-admission <id> --mode M [--invite-policy P] [--contact C]`, `rotate <id> --mode access|full`, `invite <id> [--ttl]`, `token refresh <id>`, `vote start --channel X --type kick --target N [--reason R] [--ban-ip] [--revoke-invitees]`, `vote list [id]`, `audit <id>`, `directory [query]`.
- CLI auth: uses the local store's member token (same as the MCP server's store — CLI and MCP server share `~/.share-context-mcp/state.db`).

- [ ] **Step 1: Failing tests**: `channel list` shows a joined channel; `rotate --mode access` by manager updates credential hash (old fails, new works) without deafening a member (member still decrypts old cached + new messages via... access mode keeps message key); `vote start` + `vote list` round trip; `audit` shows entries; `channel bans`/`unban` round trip on a banned fixture.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** command dispatch in CLI (subcommands under `channel`/`vote`), reusing RelayBridge with the shared store.
- [ ] **Step 4: Run** `bun test packages/cli packages/relay packages/server` — PASS.
- [ ] **Step 5: Commit** — `feat(cli): governance surface — channel/vote/rotate/audit/directory commands`

### Task 9: Sender stats + kick notice payload + docs + e2e

**Files:**
- Modify: `packages/relay/src/routes.ts` (`messages.sender` recorded at insert; `GET /channels/:id/member-stats?name=N` → { joinedAt, total, share, lastActive, perDay[7] }); kick/settlement notice attaches this profile (manager-target: successor profile too)
- Modify: `packages/server/src/mcp.ts` (render stat profile with local OS timezone), `README.md`, `packages/server/src/instructions.ts`
- Test: `packages/relay/test/relay.test.ts`, `packages/server/test/e2e.test.ts`

**Interfaces:**
- Produces (relay): member-stats endpoint (manager/creator OR self); `sender` recorded from the authenticated member on insert (nullable column, null for legacy rows).
- Produces (server): kick/settled notices rendered into `fetch_updates` output with local-timezone dates.

- [ ] **Step 1: Failing tests**: relay — sender recorded per authenticated insert; member-stats counts match fixture (totals, share rounding to whole %, per-day 7-entry array); server e2e — full flow: A creates (password), B joins, kick vote started via CLI command path, ballots cast via MCP, settles passed → B banned (403), notice in A's fetch contains joinedAt/total/lastActive rendered in local tz.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Interfaces; README governance section; instructions updated.
- [ ] **Step 4: Run** full `bun test` + `bunx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** — `feat: sender stats, kick notice payload, governance docs`
