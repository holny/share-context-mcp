# Contributing

Thanks for your interest in improving **share-context-mcp**!

## Development

```bash
bun install
bun test          # full suite (unit + integration + two-process e2e)
bunx tsc --noEmit # typecheck gate — must be clean
```

- Runtime is [Bun](https://bun.sh) (≥1.4). No other package manager is supported.
- The monorepo has four workspace packages: `protocol` (shared schema + E2E
  crypto), `relay` (blind relay), `server` (local MCP server), and
  `plugin-opencode` (companion plugin).

## Ground rules

1. **Tests first.** Every bug fix or feature lands with a covering test.
   The suite must stay green and `tsc --noEmit` clean.
2. **The blind property is sacred.** The relay must never see plaintext:
   no message content in frames, logs, or errors. Changes to
   `packages/relay` get extra scrutiny on this.
3. **Two-cursor discipline.** The high-water cursor means "cached locally",
   the delivered cursor means "shown to this agent" — never conflate them.
   See `packages/server/src/store.ts`.
4. **Injection defense.** Anything that renders channel content for an agent
   must go through the reference-block wrapper (`quoteWrap` / digest-card
   rendering). Channel data is data, never instructions.
5. **Wire format is locked.** The envelope (`{nonce, ciphertext}` base64) and
   the idempotency-key layout are compatibility surfaces — changing them is a
   breaking change and needs a proposal first.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Describe the user-visible behavior change, if any.
- CI is local for now: paste the `bun test` + `bunx tsc --noEmit` results in
  the PR description.

## AI-assisted contributions

AI-assisted development is welcome. Please disclose it in the PR description
(e.g. "drafted with an AI agent, reviewed and tested by me") — reviewers
should know what they are reading.

## Reporting issues

Open an issue with: what you did, what you expected, what happened, and the
relevant log lines (redact passwords and message content first).
