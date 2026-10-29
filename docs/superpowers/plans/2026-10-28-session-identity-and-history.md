# Session Identity & History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-session consumer identity, activity presence, a bounded-history index (FTS5 + index card), relay retention, and structural digest messages — all zero-LLM.

**Architecture:** The MCP server extracts the caller's sessionID from `extra._meta["ai.opencode/sessionID"]` (SDK 1.32.2 passes it through) to key per-consumer delivery cursors and activity; the relay gains seq-prefix eviction (count/TTL) with `min_seq` reporting; the server fetches full history at join (bounded by retention), builds a structural index card, keeps an FTS5 index over the decrypted cache, and posts structural `kind="digest"` messages when evicted ranges cross a watermark.

**Tech Stack:** Bun + TypeScript, MCP SDK 1.32.2 (`registerTool(args, extra)`), bun:sqlite (FTS5), existing workspace packages `@share-context-mcp/{protocol,relay,server}`.

**Spec:** `docs/superpowers/specs/2026-10-28-session-identity-and-history-design.md`

## Global Constraints

- Relay stays blind: it stores ciphertext only; never see plaintext, topics, kinds, or member activity content (seq/counters/timestamps are allowed metadata).
- `statement` ≤ 500 chars, `detail` per `LIMITS` (`packages/protocol/src/schema.ts`) — digest messages must respect these; chunk when needed.
- Public-facing copy (tool descriptions, README, commit messages) in English; zero "bocom" references in any synced file.
- No new user-facing configuration beyond the four relay/env vars in the spec; no LLM anywhere.
- All tests run with `bun test` from repo root; each task ends green.
- `PollResult.cursor`/store cursor semantics unchanged: high-water monotonic per channel; store cursor must never move backward.

## Review Focus

1. **FTS5 syntax injection** — a query term like `a"b OR (` must not throw; expect safe MATCH or empty result, never a crash. → Task 2 test.
2. **Re-joining member full fetch** — cursor must not move backward and already-seen messages must not re-deliver. → Task 5 test.
3. **Eviction contiguity** — after eviction, remaining seqs are contiguous from `min_seq`; no holes. → Task 6 test.
4. **Client without `_meta`** (pi, curl) — consumer id falls back to pid-based, all tools keep working. → Task 3 test.
5. **Empty digest** — evicted range with zero decision/contract/negative-result/question messages posts nothing. → Task 7 test.

---

### Task 1: Protocol — `digest` kind

**Files:**
- Modify: `packages/protocol/src/schema.ts` (CLAIM_KINDS, ~line 7)
- Test: `packages/protocol/test/schema.test.ts`

**Interfaces:**
- Produces: `CLAIM_KINDS` gains `"digest"` (10 kinds); `ClaimKind` includes `"digest"`. Digest range convention (documented in schema comment, enforced nowhere): a digest message carries `scope = { covers: "<from>-<to>" }` (seq range) and `topic = "channel-digest"`.

- [ ] **Step 1: Write the failing test** — in `schema.test.ts`, assert `CLAIM_KINDS.includes("digest")` and that `validateClaim` accepts a claim with `kind: "digest"` and `scope: { covers: "1-500" }`.
- [ ] **Step 2: Run** `bun test packages/protocol` — expect FAIL.
- [ ] **Step 3: Implement** — add `"digest"` to `CLAIM_KINDS` array; extend the kind doc comment with the covers convention.
- [ ] **Step 4: Run** `bun test packages/protocol` — PASS.
- [ ] **Step 5: Commit** — `feat(protocol): add digest kind with covers-scope convention`

### Task 2: Store — FTS5 index + search rewrite

**Files:**
- Modify: `packages/server/src/store.ts` (schema init ~line 160, `cacheMessages` ~line 331, `searchCache` ~line 368)
- Test: `packages/server/test/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `searchCache(channelId, query): ClaimMessage[]` — **signature unchanged**; semantics upgraded to FTS5 BM25 (newest first). Internal: FTS5 virtual table `messages_fts(channel_id UNINDEXED, seq UNINDEXED, statement, detail, topic, kind, scope)`; maintained inside `cacheMessages` (delete+insert per (channel_id, seq) on conflict).

- [ ] **Step 1: Write failing tests** in `store.test.ts`: (a) BM25 relevance — cache three messages where "token refresh" appears once and a unrelated one twice; query "token refresh" ranks the dedicated match first; (b) query `"a\"b OR ("` returns `[]` without throwing (Review Focus 1); (c) upsert path — cache same (channel,seq) twice with different statements, search returns only the new text.
- [ ] **Step 2: Run** `bun test packages/server/test/store.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Build MATCH expression from the existing `a&b,c&d` groups: each group's terms double-quoted (`"term"`) joined by ` AND `, groups joined by ` OR `; empty query skips the WHERE clause (fetch all, as today). `scope` column indexes the JSON string (prefix search via FTS prefix token not required — scopePrefix filtering stays in `filterClaims`).
- [ ] **Step 4: Run** full `bun test packages/server` — PASS.
- [ ] **Step 5: Commit** — `feat(server): FTS5 index over decrypted cache, BM25 search_cache`

### Task 3: Consumer ID + per-consumer delivered cursor

**Files:**
- Modify: `packages/server/src/mcp.ts` (`safe()` ~line 106; `delivered` Map ~line 138; every `delivered.get/set` site: fetch_updates ~line 360, catch_up ~line 400)
- Test: `packages/server/test/session-isolation.test.ts`

**Interfaces:**
- Produces: `export function consumerIdFromExtra(extra: unknown): string` — reads `extra._meta?.["ai.opencode/sessionID"]`, returns `memberName + "/" + id.slice(0,8)`… **note:** memberName is unavailable at extraction time; actual shape: session path returns `"s/" + sessionID.slice(0,8)`, fallback returns `"p/" + process.pid` (member scoping already exists per-channel; document this in the JSDoc). Internally: `delivered: Map<consumerId, Map<channelId, number>>`.
- `safe()` becomes `safe((args: any, extra: unknown) => Promise<string>)`; each handler needing identity calls `consumerIdFromExtra(extra)`.

- [ ] **Step 1: Write failing tests** in `session-isolation.test.ts`: (a) two `fetch_updates` calls with distinct `extra._meta["ai.opencode/sessionID"]` values each see the same new message (independent cursors); (b) same sessionID twice → second call sees nothing new; (c) **no `_meta` at all** → tools work, cursor keys off pid (Review Focus 4); (d) `consumerIdFromExtra` unit: meta present → `s/xxxxxxxx`; meta absent → starts `"p/"`.
- [ ] **Step 2: Run** `bun test packages/server/test/session-isolation.test.ts` — FAIL.
- [ ] **Step 3: Implement** per Interfaces above. Update the comment block at ~line 133 (per-process → per-consumer).
- [ ] **Step 4: Run** `bun test packages/server` — PASS (existing mcp tests may need `extra` fixture updates — update them, don't weaken assertions).
- [ ] **Step 5: Commit** — `feat(server): per-session consumer identity via MCP _meta, per-consumer delivered cursor`

### Task 4: Presence — activity tracking + relay receipts

**Files:**
- Modify: `packages/server/src/mcp.ts` (every tool handler records activity), `packages/server/src/bridge/types.ts` (`ChannelBridge` + `ChannelMember`), `packages/server/src/bridge/relay.ts`, `packages/relay/src/routes.ts`, `packages/relay/src/db.ts`
- Test: `packages/relay/test/relay.test.ts`, `packages/server/test/bridge.test.ts`, `packages/server/test/mcp.test.ts`

**Interfaces:**
- Produces (relay): `POST /channels/:id/activity` — HMAC-authenticated like other member routes; body `{ lastActiveAt: ISO8601 }`; upserts `members.last_active_at` (new column, migration via try/catch ALTER like `last_viewed_seq` at `db.ts:45`). `GET meta` response gains per-member `lastActiveAt: string | null`.
- Produces (bridge): `ChannelBridge.reportActivity(channelId: string, lastActiveAt: string): Promise<void>` — rate-limited to one POST per 30s per channel (cached ts in memory); RelayBridge implements, Git/S3 bridges no-op.
- Produces (server): in-memory `lastActive: Map<consumerId, number>` in `buildMcpServer`; every `safe`-wrapped handler updates it before dispatch. `list_members` renders `recently active (<5m)` / `idle` from relay `meta.members[].lastActiveAt` (fallback: unknown → omit).

- [ ] **Step 1: Write failing tests**: relay — POST activity then meta shows `lastActiveAt`; unauthenticated POST → 401. bridge — `reportActivity` posts at most once per 30s (two immediate calls → one request). mcp — `list_members` output contains `recently active` for a member with fresh timestamp, `idle` for a stale one.
- [ ] **Step 2: Run** the three test files — FAIL.
- [ ] **Step 3: Implement** per Interfaces. Relay blindness: timestamps only, no consumer IDs cross the wire (server aggregates to member level).
- [ ] **Step 4: Run** `bun test` — PASS.
- [ ] **Step 5: Commit** — `feat(presence): member activity receipts, activity buckets in list_members`

### Task 5: Full-history join fetch + index card

**Files:**
- Modify: `packages/server/src/mcp.ts` (join handler ~line 200-238; extract `buildIndexCard()` as a module-level exported-for-test function)
- Test: `packages/server/test/mcp.test.ts` (new describe block)

**Interfaces:**
- Consumes: `bridge.poll`, `store.searchCache`, `store.getCursor`, `bridge.meta` (all existing).
- Produces: `export function buildIndexCard(opts: { name?: string; channelId: string; members: ChannelMember[]; msgs: ClaimMessage[]; pendingQuestions: number }): string` — plain-text card. Layout: channel line; members line with activity markers (Task 4); **topic rollup** — per topic: count, kind distribution (`decision×4 howto×6`, sorted desc), time span (MM-DD ~ MM-DD), last statement truncated 80; **unresolved questions count** (`kind="question"`, `to` null or @me — count all questions, they are pending by convention); **digest entries** — `kind="digest"` messages listed as `digest covers seq A–B`; closing hint line mentioning `catch_up` and `search_messages`.
- Join fetch loop: `since = store.getCursor(channelId)` (0 fresh); loop `poll(since)` until returned window is empty or cursor reaches `meta.nextSeq - 1`; each iteration re-reads cursor. Replaces the one-shot JOIN_WINDOW logic (~line 217).

- [ ] **Step 1: Write failing tests**: (a) unit — `buildIndexCard` renders rollup with counts/kinds/span/digest line for a fixture array; empty channel renders the existing "none yet" copy; (b) integration — seed relay with 250 messages (> old JOIN_WINDOW), join, assert store message count = 250 and card shows rollup totals = 250 (Review Focus 2: pre-seed cursor via a second member re-join — assert cursor unchanged and no duplicate rows in store).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** loop + card; delete `JOIN_WINDOW` constant; update join tool description copy (mention full index instead of "recent window").
- [ ] **Step 4: Run** `bun test packages/server` — PASS.
- [ ] **Step 5: Commit** — `feat(server): full-history fetch on join, structural index card`

### Task 6: Relay retention (count + TTL) + min_seq gap handling

**Files:**
- Modify: `packages/relay/src/index.ts` (startup params), `packages/relay/src/db.ts` (channels.min_seq column, eviction fn), `packages/relay/src/routes.ts` (poll/meta responses add `minSeq`), `packages/server/src/bridge/relay.ts` (read minSeq), `packages/server/src/bridge/types.ts` (`PollResult.minSeq?: number`), `packages/server/src/store.ts` (gap flag)
- Test: `packages/relay/test/relay.test.ts`, `packages/server/test/bridge.test.ts`

**Interfaces:**
- Produces (relay): options `maxMessages` (default 10000) / `maxAgeDays` (default 30), CLI flags `--max-messages`, `--max-age-days`, env `SHARE_CONTEXT_RELAY_MAX_MESSAGES` / `SHARE_CONTEXT_RELAY_MAX_AGE_DAYS`; eviction after each accepted message: cutoff = min(next_seq − maxMessages, seqs older than maxAgeDays by `ts`) → `DELETE FROM messages WHERE channel_id=? AND seq < cutoff` (prefix only); `channels.min_seq` updated; poll + meta responses include `minSeq`.
- Produces (server): `PollResult.minSeq` propagated; in `RelayBridge.poll`, when `minSeq > since`, store cursor is raised to `minSeq` (via existing store cursor setter) and `store.setKv("gap:"+channelId, String(minSeq))` records the gap (idempotent, monotonic max). Index card (Task 5) renders `history gap before seq X — older text available only via digest` when the kv is set. Git/S3 bridges: leave `minSeq` undefined (no eviction there in v1).

- [ ] **Step 1: Write failing tests**: relay — insert `maxMessages+5` messages → oldest 5 gone, poll `minSeq` = 6, remaining seqs contiguous (Review Focus 3); TTL with `--max-age-days 0` → everything evicted on next write. bridge — poll response with `minSeq: 50` raises store cursor from 10 to 50 and sets gap kv; `minSeq` absent → no change.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Interfaces. Eviction must run inside the same transaction as message insert (relay `db.ts` helper).
- [ ] **Step 4: Run** `bun test` — PASS.
- [ ] **Step 5: Commit** — `feat(relay): seq-prefix retention (count+TTL) with min_seq reporting; server gap handling`

### Task 7: Structural digest messages

**Files:**
- Create: `packages/server/src/digest.ts`
- Modify: `packages/server/src/mcp.ts` (after-poll hook: check watermark, generate, post), `packages/server/src/index.ts` (export)
- Test: `packages/server/test/digest.test.ts`

**Interfaces:**
- Produces: `export interface DigestRange { channelId: string; from: number; to: number }`; `export function buildDigestText(msgs: ClaimMessage[], range: DigestRange): { statement: string; detail: string } | null` — groups by topic; verbatim `statement` for kinds `decision|contract|negative-result|question` (cap most recent 100, older collapsed to one-line `seq N: <first 60 chars>`); counts only for other kinds; returns `null` when zero high-value messages (Review Focus 5). Output chunking: if `detail` exceeds `LIMITS.detail` max, split into multiple chunks each with own covers sub-range — expose `export function buildDigestMessages(msgs, range, limits): Array<{ statement: string; detail: string; covers: string }>` and have `buildDigestText` delegate to it (single-chunk case returns its first element).
- Produces (mcp.ts): after any `bridge.poll` that returned `minSeq` advancing the gap kv, `maybePostDigest(bridge, store, channelId)` — reads gap kv + cached messages in `[gapFrom, gapTo]`; watermark `>= 500 msgs OR span >= 7 days` (constants `DIGEST_MIN_MSGS=500`, `DIGEST_MAX_AGE_DAYS=7` module-level); posts via `bridge.send({ kind: "digest", topic: "channel-digest", statement, detail, scope: { covers } })` only after `store.searchCache(channelId, "channel-digest")` finds no existing digest whose covers range overlaps ≥ the pending range (dedupe); marks posted range in kv `"digested:"+channelId` to avoid re-checking.

- [ ] **Step 1: Write failing tests** (new `digest.test.ts`): builder — verbatim retention, cap-100 collapse, kind counting, null on empty, chunking when detail limit forced to 300 via injected limits; integration — seed 600 progress messages + 3 decisions, force watermark, poll → exactly one `kind="digest"` message in cache with correct covers; second poll → no duplicate (Review Focus 5 covered by zero-decision fixture → no message posted).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `bun test` — PASS.
- [ ] **Step 5: Commit** — `feat(server): structural digest messages for evicted history ranges`

### Task 8: list_members/e2e polish + docs

**Files:**
- Modify: `packages/server/src/instructions.ts` (mention index card + digest in agent guidance, one paragraph), `README.md` (config vars table + digest section, English), `packages/server/test/e2e.test.ts`
- Test: `packages/server/test/e2e.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write failing e2e test**: two-server flow — A creates channel, sends 3 messages across 2 topics; B (separate store, distinct `_meta` sessionIDs) joins → full history cached, index card shows rollup; B's two consumer ids fetch independently; relay with tiny `--max-messages` evicts; watermark digest appears in B's next fetch.
- [ ] **Step 2: Run** — FAIL (or pass partially; fix forward).
- [ ] **Step 3: Implement** instructions paragraph + README sections.
- [ ] **Step 4: Run** full `bun test` (all 19+ files) + `bunx tsc --noEmit` — PASS, clean.
- [ ] **Step 5: Commit** — `docs: index card, digest, retention, consumer identity in README and instructions`
