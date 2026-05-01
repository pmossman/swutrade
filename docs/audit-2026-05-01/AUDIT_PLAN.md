# Codebase audit — 2026-05-01

Static-only review by 9 parallel agents. Each writes its report to
this directory; the master synthesis lives in `SYNTHESIS.md`. This
plan doc IS the resume document if compaction hits before
synthesis — check the status table, read whichever reports landed,
relaunch the missing ones.

## Audit scope (what we care about)

The codebase has solid test coverage now (650+ unit tests, 25+
auth e2e specs). This audit is about **code quality and tech
debt**, not coverage gaps. Lenses every agent applies:

- **Structural debt** — duplication, long files (>800 LOC),
  premature abstractions, module organization
- **Type & correctness** — `any`/`as` casts, missing return types,
  drifted Drizzle types, optional-vs-required mismatch
- **Reliability** — error handling, race conditions, idempotency,
  resource cleanup
- **Performance** — React renders, missed memoization, N+1
  queries, bundle size, sequential awaits
- **Tech-debt markers** — TODO/FIXME/HACK, "remove once X" past
  due, migration shims, dead feature flags, dead code
- **Domain coherence** — state-machine clarity, API surface
  consistency, naming
- **React hygiene** — stale closures, prop drilling, accessibility
- **Tests** — brittle, over-mocked, snapshot-only (light pass —
  the heavy coverage audit just happened)

## Output format (every agent)

Each report is a Markdown file with this structure:

```
## High-impact findings (top 3-5)
For each:
- **What:** one-line summary
- **Where:** file paths + line ranges
- **Why it matters:** concrete impact
- **Proposed fix:** 2-3 sentences
- **Risk:** low / medium / high
- **Effort:** XS (<1hr) / S / M / L
- **Confidence:** how sure this is worth doing

## Lower-priority debt
Bullet list, no proposed fixes — inventory only

## Anti-recommendations
Things that look like problems but aren't — captured so the next
audit doesn't re-flag them
```

Word cap per report: 800 words. No code changes in this phase.

## Agent assignments

### Subsystem agents (apply ALL lenses to a slice)

| # | Agent | Scope | Output |
|---|---|---|---|
| 1 | Sessions | `lib/sessions.ts` (1700+ LOC), `src/components/Session*`, `src/hooks/useSession*`, `tests/api/sessions-*.test.ts` | `01-sessions.md` |
| 2 | Trades | `api/trades.ts`, `lib/proposalResolve.ts`, `lib/proposalMessages.ts`, `src/components/Trade*` (proposal-related), `tests/api/trades-*.test.ts` | `02-trades.md` |
| 3 | Discord integration | `lib/discordBot.ts`, `lib/discordClient.ts`, `api/bot.ts` (1811 LOC), `lib/tradeGuild.ts`, `lib/discordErrors.ts`, related tests | `03-discord.md` |
| 4 | Auth & identity | `api/auth.ts`, `lib/auth.ts`, `lib/sessions.ts` (ghost-merge subset), `lib/guildSync.ts`, `api/me.ts`, related tests | `04-auth.md` |
| 5 | Trade builder UI | `src/App.tsx`, `src/components/TradeSide.tsx`, `TradeRow.tsx`, `TradeBalance.tsx`, picker components, signal-builder UI | `05-trade-ui.md` |
| 6 | Lists / inventory / discovery | wants/available/binder UIs, `src/hooks/useWants.ts`, `useAvailable.ts`, `lib/signalMatching.ts`, profile + community + matchmaker | `06-lists.md` |

### Cross-cutting sweeps (one lens across the whole repo)

| # | Agent | Lens | Output |
|---|---|---|---|
| 7 | Performance | React render audit, DB hot-path queries, sequential-vs-parallel awaits, bundle-size opportunities | `07-performance.md` |
| 8 | Types & dead code | `any`/`as`/`@ts-expect-error` audit, unreferenced exports, TODO/FIXME triage, schema-vs-type drift | `08-types-deadcode.md` |
| 9 | Refactor candidates | duplicated patterns across files, premature abstractions to flatten, long files needing splits, helper consolidation opportunities | `09-refactor-candidates.md` |

## Status tracker

| # | Agent | Status |
|---|---|---|
| 1 | Sessions | ✅ done |
| 2 | Trades | ✅ done |
| 3 | Discord integration | ✅ done |
| 4 | Auth & identity | ✅ done |
| 5 | Trade builder UI | ✅ done |
| 6 | Lists / inventory / discovery | ✅ done |
| 7 | Performance | ✅ done |
| 8 | Types & dead code | ✅ done |
| 9 | Refactor candidates | ✅ done |

Update each row as the agent completes. After all 9 land, the
synthesis happens in `SYNTHESIS.md`.

## Synthesis approach

1. Read each report.
2. Build a deduped table of all findings — when 3+ agents flag the
   same pattern, weight it higher.
3. Group findings into 4 tiers: must-fix, high-leverage,
   nice-to-have, ignore-for-now.
4. Surface cross-cutting themes — e.g., "every subsystem inlines
   its own retry helper" → an extraction opportunity.
5. Note disagreements between agents and resolve them with my own
   read of the relevant code.
6. Output a single roadmap doc + a tight chat summary.

After parker reviews the roadmap, we pick what to actually do and
run another autonomous-loop-style execution for the picked items
(per the overnight pattern).
