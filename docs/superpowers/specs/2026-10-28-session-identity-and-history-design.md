# Session Identity & History Design — share-context-mcp

Date: 2026-10-28
Status: Pending approval
Scope: v1.x design iteration after M1–M3 implementation. Four questions drove this:
session identity, history comprehension (join card), presence/exit detection, retention.

## Intent & Why

M1–M3 shipped a working E2E-encrypted shared context channel (relay/git/s3 bridges,
10 MCP tools, opencode companion plugin, 174 tests). Real usage exposed four gaps:

1. **Session identity**: one MCP server process serves many agent sessions (opencode
   shares one stdio process across sessions). Sessions are independent consumers, but
   the server cannot currently tell them apart.
2. **History comprehension**: a joining session gets a 200-message window and a
   structural card, but has no way to know what older history exists or whether to
   look — there is no index over history.
3. **Presence**: there is no way to know if a member/session is still active.
4. **Retention**: relay and local stores grow without bound.

## Goals / Non-goals / Anti-goals

- **Goals**: per-session consumer identity without plugins; a memory-index-like view
  of channel history that lets an agent decide what to read; bounded storage; honest
  presence signal; zero new user configuration.
- **Non-goals**: server-side or relay-side LLM (relay is blind; server stays
  zero-config); precise session-exit events (MCP protocol has none on stdio);
  per-consumer summaries.
- **Anti-goals**: any step requiring users to configure an LLM for this project;
  breaking the blind-relay property; making the cursor visible to agents.

## Approaches Considered

### Consumer identity
- **A. `_meta` sessionID from the client (chosen)** — verified evidence:
  opencode upstream `packages/core/src/mcp/client.ts:375` and bocomcode_v2
  `client.ts:394` send `_meta: {"ai.opencode/sessionID": <id>}` on every
  `tools/call`. MCP SDK 1.32.2 (latest, already in use) passes request `_meta`
  to every tool handler via `extra._meta` (`protocol.js:345`,
  `RequestHandlerExtra._meta`). Zero plugin, zero config, survives agent process
  restart with session resume (same sessionID).
- B. Process identity only — breaks on restart, cannot split sessions sharing one
  process. Kept as fallback only (pi and other clients without `_meta`).
- C. Companion plugin carries identity — violates "no plugin required".

**Decision**: `consumer_id = memberName + "/" + sessionID.slice(0,8)` when
`extra._meta["ai.opencode/sessionID"]` is present; fallback
`memberName + "/p" + pid`. The per-process `delivered` Map in `buildMcpServer()`
becomes a per-consumer Map (still process memory; relay holds full history so a
process restart replays, nothing is lost).

### Presence
- **A. Activity inference (chosen)** — every tool call updates
  `last_active[consumer_id]` locally; plugin path additionally reports IPC events
  (more accurate: a session receiving digest cards is active even without tool
  calls). Receipts uploaded to relay; `list_members` reports activity buckets
  (recently active / idle) by threshold (default 5 min). No exit events.
- B. Precise exit detection — impossible: MCP stdio has no session-lifecycle
  notification; process exit only signals whole-agent shutdown.

### History comprehension
- **A. Structural channel index (chosen, zero LLM)** — see below.
- B. Server-configured LLM summaries — new config burden, rejected.
- C. MCP sampling (server asks client's LLM) — verified unsupported by all target
  hosts (opencode upstream, bocomcode_v2, codex: no `sampling/createMessage`
  implementation). Rejected.
- D. Tool-mediated LLM enhancement (agent writes digest via share_update) —
  viable but deferred: marginal value over structural digests is small because
  statements are already self-contained ≤500-char claims. Recorded as future
  extension pending user feedback.

**Decision — three layers, all zero-LLM**:

1. **Index card (join card upgrade)**: computed fresh on join (SQL aggregation,
   sub-ms). Content: members + activity buckets; topic rollup (per topic: message
   count, kind distribution, time span, last statement truncated to 80 chars);
   pending questions count (`kind=question` unresolved); `kind=digest` entries
   covering evicted ranges; hint to `catch_up` / `search_messages`.
2. **FTS5 full-text index**: replaces the current SQL LIKE scan in
   `search_messages`. Virtual table over `statement + detail + topic + kind +
   scope`, BM25 ranking, maintained on `cacheMessages` insert.
3. **Full-history fetch at join**: retention (below) bounds relay history, so the
   server fetches ALL remaining ciphertext on join (not just the 200-message
   window), decrypts, caches, and indexes. The "what history exists" problem
   disappears: history is local, bounded, scannable, searchable.

The consuming agent's own LLM does final synthesis at read time — raw facts beat
pre-chewed summaries for agents (validated by the M1 behavior spike).

### Cursor vs index card
Orthogonal responsibilities, both kept:
- **Cursor** = delivery correctness ("what have I not seen"), invisible to agents,
  unchanged mechanics, now per-consumer.
- **Index card + catch_up** = history understanding ("what happened here"), agent-
  initiated, on demand.
Resume-gap after absence: `fetch_updates(since=cursor)` returns the gap as original
messages (usually small); the card is never used for gap summarization.

### Retention (decided by user)
Relay evicts oldest ciphertext per channel when **either** bound is hit:
- message count (default 10 000)
- age TTL (default 30 days)
Both configurable as relay startup parameters. Eviction must be **seq-prefix
deletion** (keep the window contiguous) — consumers' cursors must stay decidable.
Relay reports `min_seq` to pollers; a consumer whose cursor < min_seq raises the
cursor to `min_seq` and marks a history gap locally.

### Digest messages (structural)
- Local server tracks evicted-but-not-summarized ranges (dirty set) from `min_seq`.
  `min_seq` advance is bookkeeping only — never a trigger by itself.
- When pending range crosses a watermark (≥500 messages or ≥7 days of content),
  generate ONE structural digest covering the whole range and post it as a normal
  encrypted message `kind="digest"` with `covers: seq A–B`. Watermark exists only
  to prevent channel noise (generation itself is free SQL), not LLM cost.
- Digest content: verbatim `statement` of all `decision`/`contract`/
  `negative-result`/`question` messages in range (statements are self-contained
  by protocol invariant; cap at most recent 100, older collapse to one-line
  entries); counts only for other kinds; per-topic grouping.
- Supersede semantics: a new digest for a superset range supersedes (marks stale)
  the previous one; consumers reading a digest skip superseded ones.
- Dedup: before posting, `search_messages(kind=digest)` for an existing digest
  covering the same range; skip if found. Racy double-post is harmless redundancy;
  no locking.
- New joiners recover evicted history via digest entries visible on the index card.

## Config Surface (all optional, sensible defaults)

```
SHARE_CONTEXT_CARD_DELTA_MAX     — dropped with LLM tier (no longer needed)
SHARE_CONTEXT_RELAY_MAX_MESSAGES=10000   # relay eviction, count bound
SHARE_CONTEXT_RELAY_MAX_AGE_DAYS=30      # relay eviction, TTL bound
SHARE_CONTEXT_DIGEST_MIN_MSGS=500        # digest watermark (noise control)
SHARE_CONTEXT_DIGEST_MAX_AGE_DAYS=7      # digest watermark (time bound)
```

## What's Left to the Builder

- Extract sessionID in `mcp.ts` tool wrapper: `extra._meta?.["ai.opencode/sessionID"]`.
- Rework `delivered` Map to `Map<consumerId, Map<channelId, seq>>`; share_update
  provenance may include consumer_id.
- Store: FTS5 virtual table + triggers/insert-path maintenance; rewrite
  `searchMessages` to MATCH queries.
- Join flow: full-history fetch loop (paged) → cache → index card build.
- Relay: seq-prefix eviction job (count/TTL), `min_seq` in poll responses and WS
  notifications; receipts accept `last_active` per consumer.
- `kind="digest"` added to protocol CLAIM_KINDS + supersede handling in card/catch_up.
- Session isolation tests extended: two sessions sharing one server process, distinct
  consumer ids, independent delivered cursors.
- Fork-plugin loader note unchanged (explicit `.ts` extensions, `bocomcode.json`).

## Future Extensions (explicitly out of v1)

- Tool-mediated LLM digest enhancement (agent-written summaries via share_update)
  if structural digest quality proves insufficient.
- Per-consumer scoped digests — rejected for v1: summary value is channel-wide;
  consumer differences are cursor mechanics, not content.
