# OCR Review — 2026-10-26 (full implementation, 512a3f1..main)

Scope: src only (tests/docs/spike excluded). 42 findings: 2 high / 18 medium / 22 low.
9 fixed in commit 67a71f0 (independently re-verified, 158/158 green); rest triaged below.

- **[high]** `packages/plugin-opencode/src/index.ts:124` (bug) — ✅ FIXED (67a71f0)
  state.pending mixes cards from every joined channel, but mergeCards() collapses them into one card keyed by cards[0].channelId and dedupes seq globally. seq is channel-scoped, so with more than one channel this can silen

- **[high]** `packages/plugin-opencode/src/index.ts:177` (bug) — ✅ FIXED (67a71f0)
  This catch treats every rejection as plugin unload and swallows it. A transient iterator error will permanently stop the anti-forget turn boundary with no diagnostics. At minimum log the error; better, distinguish expect

- **[medium]** `.gitignore:1` (security) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Add .env / .env.* patterns so locally generated relay passwords or secrets are never committed.

- **[medium]** `packages/relay/src/routes.ts:265` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Stale-epoch write after an await point (same F-1 class the code already fixed for message sends via `stmtAllocSeq`): `channel` was read at the top of `handle()` (before `await readJson(req)`), so a concurrent rotate that

- **[medium]** `packages/relay/src/routes.ts:375` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  `auth.channel` was captured before the optional `await readJson(req)` in the rotate branch, so the response and the broadcast `epoch-invalidated` frame are computed from a potentially stale row. With two concurrent rotat

- **[medium]** `packages/relay/src/routes.ts:399` (maintainability) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Duplicated token validation: this function re-implements the exact rules of the in-handler `authenticate()` (sha256(token) lookup + TTL + `isLiveToken` epoch match) as a parallel copy, and re-prepares two SQL statements

- **[medium]** `packages/server/src/mcp.ts:446` (bug) — ✅ FIXED (67a71f0)
  leave_channel tears down local state but nothing detaches the channel from the Broadcaster: McpServerDeps only exposes onChannelJoined and Broadcaster has addChannel with no removal path. After leaving, the broadcaster's

- **[medium]** `packages/server/src/broadcaster.ts:106` (security) — ✅ FIXED (67a71f0)
  `from` is the only free-text field in the digest line that skips sanitizeLineText (topic/statement/to are all sanitized). provenance rides inside the sealed envelope, so it is entirely sender-controlled plaintext the rel

- **[medium]** `packages/server/src/broadcaster.ts:273` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  The EADDRINUSE handler unlinks whatever sits at the path without checking whether it belongs to a live server. Store is explicitly designed for concurrent server instances sharing one SQLite file, and the socket path is

- **[medium]** `packages/relay/src/index.ts:41` (bug) — ✅ FIXED (67a71f0)
  The 25s heartbeat is longer than Bun.serve's default `idleTimeout` (10s), which also applies to upgraded WebSocket sockets: an idle WS connection is closed by Bun ~10s after the last frame, i.e. *before* the first 25s pi

- **[medium]** `packages/plugin-opencode/src/index.ts:173` (bug) — ✅ FIXED (67a71f0)
  Urgent delivery depends on lastActiveSessionID, which is only set by tool hooks today. A card that arrives before the first tool call is therefore dropped even though the event stream already knows the active session. Up

- **[medium]** `packages/plugin-opencode/src/index.ts:111` (bug) — ✅ FIXED (67a71f0)
  Marking share_update in execute.before suppresses the reminder even if the call later fails (or never reaches execute.after). Since the reminder is about successful sharing, set sharedThisTurn inside the completed branch

- **[medium]** `packages/plugin-opencode/src/ipc.ts:140` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Only the outer digest card is validated; each entry in lines is cast without checking seq/kind/topic/from/to/statement. A malformed lines[] element can still reach mergeCards/renderDigestCard and yield undefined text or

- **[medium]** `packages/plugin-opencode/src/ipc.ts:101` (bug) — ✅ FIXED (67a71f0)
  Decoding each chunk independently with chunk.toString("utf8") corrupts a multi-byte UTF-8 character that spans a chunk boundary; the plugin will then fail JSON.parse on otherwise valid Chinese statements. Use socket.setE

- **[medium]** `packages/plugin-opencode/src/index.ts:182` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  The 50 ms race never closes the iterator or stops the pump; if the host keeps the iterator open, the pump can continue running after cleanup and call synthetic on an unloaded plugin. Use a disposed flag checked inside th

- **[medium]** `packages/protocol/src/schema.ts:78` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  The `\n` delimiter is ambiguous because `statement` and `topic` are free text and may themselves contain newlines. Two distinct claims can therefore serialize to the same string and get wrongly deduped by the relay. Exam

- **[medium]** `packages/protocol/src/crypto.ts:81` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  `open()` blindly casts the decrypted JSON to `ClaimMessage` without checking that the payload actually satisfies the schema. Because any channel member who holds the key can seal arbitrary JSON, callers can receive a typ

- **[medium]** `packages/protocol/src/schema.ts:280` (security) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  `ts` is taken from input as any non-empty string: it has no length cap (every other free-text field is bounded via `LIMITS`) and it is never pushed into `scanned`, so it bypasses the credential blacklist entirely. A clai

- **[medium]** `packages/protocol/src/schema.ts:75` (security) — ✅ FIXED (67a71f0)
  The `sk-` pattern `[A-Za-z0-9]{16,}` stops at the first `-`/`_`, so current OpenAI keys (`sk-proj-...`, `sk-svcacct-...`) and Anthropic keys (`sk-ant-api03-...`) — all of which contain hyphenated segments — are NOT caugh

- **[medium]** `packages/server/src/mcp.ts:327` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  `skipped` is computed from `served.length`, but when the SERVE_WINDOW truncates the batch, the not-yet-served tail (reported separately as `remaining`) is also counted as skipped. Example: start=0, high=300, 250 decrypta

- **[low]** `package.json:10` (maintainability) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Caret range ^1.2.0 should be a pinned specific version (e.g. 1.2.0) per the project's dependency-version rule for reproducible installs.

- **[low]** `packages/relay/src/db.ts:42` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Foreign key enforcement is never enabled: the `members` and `messages` tables declare `REFERENCES channels(id)`, but SQLite has FK enforcement OFF by default for each connection, and `openDb` only sets `journal_mode`. Th

- **[low]** `packages/relay/src/routes.ts:13` (maintainability) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Unused import: `createHmac` is never used in this module — the proof computation is delegated to `hmacProof` from `@share-context-mcp/protocol` (the tests import `createHmac` directly from node:crypto, not from here). Re

- **[low]** `packages/relay/src/routes.ts:189` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Lenient base64 validation: `Buffer.from(str, "base64")` silently discards characters that are not valid base64, so this check accepts non-canonical/malformed verify keys (whitespace, padding variants, arbitrary garbage b

- **[low]** `packages/relay/src/routes.ts:347` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Silent key-drop footgun: if a client sends the new `verifyKeyB64` as a JSON body but omits the `application/json` content-type (a common client bug), the body is ignored and the rotate proceeds keyless — the response rep

- **[low]** `packages/server/src/mailbox/relay.ts:83` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  fetch has no timeout/abort, so a relay connection that is accepted but never answered leaves this promise pending forever. In the Broadcaster that wedges the per-channel serialized chain (state.chain): every later wake h

- **[low]** `packages/server/src/mailbox/relay.ts:37` (security) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  `bytes[i] % alphabet.length` introduces modulo bias: 256 % 36 = 4, so 'a'–'d' occur ~1.6% more often per character. The impact at 20 chars is small, but this function generates the channel password — the root secret of t

- **[low]** `packages/server/src/store.ts:240` (style) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Two positional SQL bindings accidentally share one line with a large gap (looks like a broken formatter pass). With a 6-placeholder INSERT, keeping one binding per line makes argument order verifiable at a glance.

- **[low]** `packages/relay/src/routes.ts:363` (maintainability) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  This is the only statement in `createRelayHandler` prepared per-request inside the handler, while every other statement (including `stmtBumpEpoch` two lines below) is hoisted and prepared once at factory time. It's also

- **[low]** `packages/plugin-opencode/src/index.ts:45` (style) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  The any types on the tool-hook event and event.data erase the structural safety the rest of the plugin relies on. Define a minimal ToolHookEvent shape (sessionID/tool/status/result.content) and a typed execution event so

- **[low]** `packages/protocol/src/schema.ts:82` (maintainability) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  This `import` is declared in the middle of the file after executable code. ESM hoisting makes it work, but it breaks standard import placement and is easy to miss. Please move it to the top of the file with the other mod

- **[low]** `packages/protocol/src/schema.ts:152` (security) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  `JSON.stringify(kind)` (and the same pattern for `prov.source` further down) echoes arbitrary caller-supplied content verbatim into the rejection reason. If a secret lands in the wrong field (e.g. a PEM key or token past

- **[low]** `packages/protocol/src/crypto.ts:98` (maintainability) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  These re-exports duplicate the barrel: `src/index.ts` already exports `idempotencyKey` and the claim types from `./schema`. Keeping a second export surface on the crypto module blurs the module boundary (crypto should ex

- **[low]** `packages/plugin-opencode/src/anti-forget.ts:16` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  bareToolName's ternary is exclusive: the `channel_` branch returns WITHOUT stripping the MCP `__` namespace, and the `__` branch returns without stripping `channel_`. So combined spellings — `channel_mcp__srv__share_upda

- **[low]** `packages/plugin-opencode/src/coalesce.ts:91` (maintainability) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  Two cleanups in renderDigestCard: (1) `...[head(card, total)].map(quote)` wraps a single value in an array just to map it — it is simply `quote(head(card, total))`, presumably leftover from a refactor; (2) the two bullet

- **[low]** `packages/plugin-opencode/src/index.ts:73` (performance) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  The sessions map only ever grows: stateFor() inserts an entry on each session's first tool call, and nothing ever removes entries — the plugin lives for the whole editor lifetime, so every session that ever ran a tool le

- **[low]** `packages/plugin-opencode/src/ipc.ts:89` (maintainability) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  This console.error fires on EVERY connect attempt. While the server is absent (its stdio process only lives during agent sessions, so this is the common idle state) the backoff caps at 15s, meaning a stderr log line roug

- **[low]** `packages/server/src/mcp.ts:105` (style) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  `safe` uses `any` for the handler parameter without a comment explaining why. Per the review rules, `any` should be avoided or justified — here the justification exists (each tool's zod schema owns validation, and the SD

- **[low]** `packages/server/src/broadcaster.ts:298` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  stop() flushes pending digest cards via emit() → client.write(), then immediately destroys every client. socket.destroy() discards buffered, unflushed writes, so the "best effort: deliver what the window held" flush can

- **[low]** `packages/server/src/broadcaster.ts:190` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  If mailbox.listen() throws synchronously (e.g. getChannelSecret fails to decrypt a corrupt password_enc, or the channel vanished), the ChannelState is already registered with `listener: null!`. Two consequences: (1) the

- **[low]** `packages/server/src/mailbox/relay.ts:240` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  When the 409-adoption path loaded a stored session token, a failing meta verification here (e.g. 401 because the stored token is dead while a different member now holds the name) propagates without cleaning up — the stal

- **[low]** `packages/server/src/transport.ts:202` (bug) — ⏸ DEFERRED (M2+ hardening / prior ruling)
  A stalled WS handshake has no timeout: the death timer is armed only in handleOpen, so a relay that accepts TCP but never answers the upgrade (the same hang scenario already flagged for fetch()) leaves the transport wait
