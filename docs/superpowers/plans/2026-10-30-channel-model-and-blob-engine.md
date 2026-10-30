# Channel Model & Blob Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the v3 iteration — public/private channel model, owner-only message-key governance with relay-side key_version enforcement, the scmc2 blob envelope with `generate_share_blob`, probation, the 11-tool surface, and the target-left-vote fix.

**Architecture:** Relay gains a `visibility` axis and strict admission validation; key material moves entirely to the owner's CLI with the relay enforcing the single active key_version on every encrypted message. The protocol package gains a tamper-evident blob envelope (`scmc2-`) that v1 uses for client-executable share blobs; relay-executable delegation stays protocol-reserved. The MCP surface splits the consolidated `channel`/`list` tools into 11 flat tools with required `channel_id`.

**Tech Stack:** TypeScript, Bun (runtime + `bun test`), better-sqlite3 style relay DB (node:sqlite/stdio), node:crypto AES-256-GCM.

**Spec:** `docs/superpowers/specs/2026-10-30-channel-model-and-blob-engine-design.md`

## Global Constraints

- Branch: `feat/channel-model-v3`, created from `feat/governance-v2` @ `017457d`. Commit every task. Never switch branches.
- `bun test` (263 baseline) and `bunx tsc --noEmit` must be green after every task.
- All user-facing copy in English. Zero "bocom" references anywhere.
- Every channel-scoped MCP tool takes `channel_id` as a REQUIRED parameter — no default-channel fallback on these tools (an explicit tool-level error is acceptable where the old code fell back).
- Message keys are created ONLY at channel creation (owner's local machine) or by owner CLI rotation. No MCP tool and no relay endpoint mints client-side keys.

## Review Focus

1. **private + no_limit creation** — `create_channel(visibility:"private", admissionMode:"no_limit")` must 400 with a clear message, not silently coerce. → Task 2 test.
2. **Key-mismatch error is agent-actionable** — the 409 body must carry `currentVersion` and `contact`; the MCP send path surfaces it verbatim. → Task 3 tests.
3. **`generate_share_blob` without a local key** — public+encrypted channel where the caller's keyring lacks the current version must return a clean error, not a keyless blob. → Task 6 test.
4. **Blob join by an already-joined member with a stale key** — `join_channel(blob)` performs a key top-up; no re-join, no "already a member" error. → Task 5 test.
5. **Vote passes after target left** — settle writes the ban row for the departed target; re-admission is blocked at the gate. → Task 4 test.

---

### Task 1: scmc2 blob envelope (protocol)

**Files:**
- Modify: `packages/protocol/src/crypto.ts` (add envelope, keep `encodeJoinBlob`/`parseJoinBlob` as a thin wrapper or remove them if all callers migrate in Tasks 5–6 — migrate callers, then delete)
- Test: `packages/protocol/test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `encodeBlobEnvelope(params: { type: string; payload: Record<string, unknown>; expiresAt?: number; maxUses?: number }): string` — returns `scmc2-<base32(...)>`.
  - `parseBlobEnvelope(blob: string): { type: string; payload: Record<string, unknown>; expiresAt?: number; maxUses?: number }` — throws `Error` with a message starting `invalid blob:` on any structural failure; a single mutated character must fail (embed a SHA-256 checksum over the payload JSON inside the envelope before base32; verify on parse).
  - `type BLOB_TYPES = "join_password" | "join_invite" | "join_key" | "key_update"` and a helper `isBlobExpired(env: { expiresAt?: number }, now = Date.now()): boolean`.

- [ ] **Step 1: Write failing tests** — round-trip for all 4 types; single-char mutation at 5 positions of the base32 body → throws; `expiresAt` in the past → `isBlobExpired` true; >8192 chars input → throws; non-`scmc2-` prefix → throws.
- [ ] **Step 2: Run** `bun test packages/protocol` — expect new tests FAIL.
- [ ] **Step 3: Implement** envelope (JSON → checksum → base32; no encryption needed for client-executable v1 — the checksum provides the tamper wall, GCM sealing arrives with relay-executable blobs).
- [ ] **Step 4: Run** `bun test packages/protocol && bunx tsc --noEmit` — PASS. Old join-blob tests still pass (wrapper kept until Task 5).
- [ ] **Step 5: Commit** `feat(v3): scmc2 blob envelope with tamper detection`

### Task 2: visibility × admission model (relay)

**Files:**
- Modify: `packages/relay/src/db.ts` (schema + migration), `packages/relay/src/routes.ts` (create/set-admission/join/directory)
- Test: `packages/relay/test/routes.test.ts` (or the existing relay test file)

**Interfaces:**
- Consumes: existing `stmtChannel`, `db.exec` ALTER pattern in `db.ts:97-105`.
- Produces: `channels.visibility` column (`'public'`|`'private'`); admission enum now `no_limit|password|invite` with one-time migration `UPDATE channels SET admission_mode='no_limit' WHERE admission_mode='public'`; a shared validator `validateChannelShape(visibility: string, admissionMode: string): { ok: true } | { ok: false; error: string }` used by create and set-admission (`private+no_limit` → `private channels cannot use no_limit admission`).
- Directory endpoint (`GET /directory` or the channel-listing used by CLI `directory`) filters `visibility = 'public'`.

- [ ] **Step 1: Failing tests** — private+no_limit create → 400; public+no_limit create → ok; migration maps legacy `'public'` rows to `'no_limit'` (create a row with the old value pre-migration in a fresh DB); set-admission flipping visibility to private while `no_limit` → 400; directory omits private channels.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** schema migration + validator + wire into create/set-admission/directory. `join` for `no_limit` follows today's open-join path.
- [ ] **Step 4: Run full suite** — PASS.
- [ ] **Step 5: Commit** `feat(v3): visibility axis + no_limit admission with strict shape validation`

### Task 3: key governance (relay)

**Files:**
- Modify: `packages/relay/src/routes.ts`, `packages/relay/src/db.ts` (`channels.sealed_key TEXT NULL`)
- Test: relay test file

**Interfaces:**
- Produces:
  - `POST /channels/:id/rotate-key` `{ keyVersion: number; sealedKey?: string }` — creator (owner) only, audit `rotate-key`, sets `key_version`, stores `sealed_key` when provided (public tier), WS broadcast `{ type: "key_rotated", keyVersion, contact, rotatedAt }`.
  - `POST /channels/:id/messages` with `encrypted: 1` and `key_version !== channels.key_version` → **409** `{ error: "message key rotated", currentVersion, contact, rotatedAt }` (contact from `channels.contact_info`).
  - `set-encryption` no longer accepts a client-minted key implicitly: it only flips the flag; `key_version` starts at 0 and only `rotate-key` bumps it. Owner/manager gated, audited.

- [ ] **Step 1: Failing tests** — stale `key_version` send → 409 with `currentVersion`+`contact`; matching version → stored; unencrypted send on an encrypted channel → still allowed (flag mismatch is a client concern, relay stores the stamp); `rotate-key` by non-owner → 403; rotate then old-version send rejected, new-version accepted; WS notification shape.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run suite** — PASS (existing set-encryption tests updated to the new semantics in the same commit).
- [ ] **Step 5: Commit** `feat(v3): relay-enforced key_version + owner-only rotate-key`

### Task 4: probation + target-left vote fix (relay)

**Files:**
- Modify: `packages/relay/src/db.ts` (`channels.probation_enabled`, `channels.invite_skips_probation`, `members.probation_until`), `packages/relay/src/routes.ts` (join assignment, activity-scan promotion, settleVote), `packages/relay/src/activity.ts` (promote in the daily scan)
- Test: relay test file + activity test file

**Interfaces:**
- Produces: on join — `probation_until = now+7d` and permission role `trial` iff `probation_enabled` and not (invite join ∧ `invite_skips_probation`); `scanActivityRoles` promotes `trial → regular` when `probation_until < now`. `settleVote` loses the target-inactive void branch: the vote continues; on pass, `applyKick` writes the ban row even for a departed target.

- [ ] **Step 1: Failing tests** — password join to a probation channel → trial + probation_until set; invite join → no probation; scan past expiry → regular; start kick vote → target leaves → remaining members pass it → vote `passed`, ban row exists for target, target's re-join attempt → 403.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run suite** — PASS.
- [ ] **Step 5: Commit** `feat(v3): probation tiers + votes survive target departure`

### Task 5: 11-tool MCP surface (server)

**Files:**
- Modify: `packages/server/src/mcp.ts` (split + signatures), `packages/server/src/instructions.ts`, `packages/plugin-opencode/` if it names tools
- Test: `packages/server/test/mcp.test.ts` + e2e updates

**Interfaces:**
- Consumes: Task 1 `parseBlobEnvelope`; existing `RelayBridge` join/leave/create paths.
- Produces: `TOOL_NAMES = ["send_message","fetch_messages","create_channel","join_channel","leave_channel","generate_share_blob","list_channels","list_members","start_vote","cast_vote","channel_info"]`. `channel` and `list` and `join_from_blob` are removed. `join_channel(channel_id, member_name?, password?, invite_code?, blob?)` — blob extracts the rest; already-joined member with a stale/missing key gets a key top-up (writes `message_keys`, no re-join). `start_vote(channel_id, type, target?, reason?)` calls the same relay votes endpoint the CLI uses, same governance checks. All scoped tools: missing `channel_id` → tool error `"channel_id is required"`.
- [ ] **Step 1: Rewrite tool tests first** — flat signatures; missing channel_id errors; join-from-blob path (incl. top-up); start_vote happy path + governance rejection (e.g. <3 members).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement the split.** `create_channel` gains `visibility`/`admissionMode`/`encrypted?`/`probationEnabled?` params (Task 2 relay support already live).
- [ ] **Step 4: Run full suite + tsc** — PASS. Update instructions.ts tool guidance.
- [ ] **Step 5: Commit** `feat(v3): 11-tool surface with required channel_id`

### Task 6: generate_share_blob (server + protocol text)

**Files:**
- Modify: `packages/server/src/mcp.ts`, `packages/protocol/src/crypto.ts` (presentation text builder)
- Test: server test file

**Interfaces:**
- Consumes: Task 1 envelope; local keyring `store.messageKey(channel_id, version)`; relay `channel_info` for inviter role/activity snapshot.
- Produces: `generate_share_blob(channel_id)` returning `{ blob, text }` where `text` is the §4.4 presentation block (Type line: INVITE/PASSWORD/MESSAGE KEY; channel line; inviter + role + activity snapshot; shared-at; one `scmc2-` key string). Inference matrix per spec §4.3 (6 rows). Missing local key on an encrypted channel → error `"message key not available locally — ask the owner for a fresh blob"`.
- [ ] **Step 1: Failing tests** — all 6 matrix rows (invite mints a code with 7d TTL + maxUses 1; private+password; public+encrypted → join_key; public+password+unencrypted → join_password; no_limit+encrypted → join_key; no_limit+unencrypted → 400); presentation text asserts the Type line and exactly one `scmc2-` occurrence; missing-key error.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run suite** — PASS.
- [ ] **Step 5: Commit** `feat(v3): generate_share_blob with type inference and presentation text`

### Task 7: CLI + key top-up flow + docs + e2e

**Files:**
- Modify: `packages/cli/src/index.ts` (rotate-key, set-probation, set-contact updates), `packages/server/src/bridge/relay.ts` (rotate-key bridge call, key top-up on 409 awareness), `README.md`, `README.zh-CN.md`, `packages/relay/README.md`
- Test: `packages/server/test/governance-e2e.test.ts` (extend)

**Interfaces:**
- Produces: CLI `rotate-key --id <ch>` (owner local mint → relay rotate → prints "distribute via generate_share_blob / share-key blob"); `set-probation --id <ch> [--enabled] [--invite-skips false]`; e2e: private encrypted create → blob join → encrypted send → rotate-key → stale send 409 → fresh blob top-up → send resumes; probation path; target-left vote path.
- [ ] **Step 1: Extend the e2e test** with the three flows (failing first where behavior is new).
- [ ] **Step 2: Implement CLI + bridge glue.**
- [ ] **Step 3: Full suite + tsc green; README tables updated to 11 tools + new model; zh-CN mirror consistent.**
- [ ] **Step 4: Commit** `feat(v3): CLI key rotation, docs, full e2e`
