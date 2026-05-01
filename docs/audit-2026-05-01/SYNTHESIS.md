# Audit synthesis — 2026-05-01

Nine parallel agents produced 9 reports (`01-sessions.md` … `09-refactor-candidates.md`) covering 6 subsystem slices and 3 cross-cutting lenses. This doc is the deduped, prioritized read.

## Executive summary

The codebase is in markedly good shape. Test coverage is strong (650+ unit, 25+ e2e, plus the freshly-written Discord-outbound coverage), `import type` discipline is tight, only 1 `@ts-expect-error` and 1 outstanding TODO live in non-test code, and most "duplications" turn out to be deliberate parallel structures (e.g., `discordClient` vs `discordBot` for user-token vs bot-token auth). Anti-recommendations across the reports are dense — agents found a lot that *looks* like debt but isn't.

The real findings cluster in **four areas**:

1. **Big files past their useful size.** `lib/sessions.ts` (2572 LOC), `api/bot.ts` (2618), `api/trades.ts` (1641), `SessionView.tsx` (1327), `App.tsx` (1235). Each has author-marked split points; none has been split.
2. **Re-render cascades from un-memoized context values + prop walls.** Three context providers ship fresh object literals every render; `TradeSide` takes 24 props twice and isn't memoized; `useSession`'s mutation callbacks have `session` in deps. The 60s minute-tick re-renders the whole tree.
3. **Sequential awaits where `Promise.all` would do** — and one outright `COUNT(*)` regression. `countUnreadEvents` SELECTs every event row every 2.5s per polling tab. `handlePropose` does 4 sequential SELECTs. `syncGuildMemberships` blocks OAuth on a sequential upsert loop. `api/sync.ts` writes 200-card binders one round-trip at a time (6-10s).
4. **Type drift between schema and consumers.** `lib/schema.ts` is the source of truth, but no consumer uses `InferSelectModel`. Frontend re-declares `TradeStatus`, `SessionStatus`, `SessionEventType`, `TradeCardSnapshot` structurally. `apiClient` casts every response to the generic `T` with zero validation across 44 call sites.

Plus a handful of correctness bugs scattered across subsystems — `handleLogout` accepts any HTTP method, OAuth state cookies don't clear on error paths, `pendingSuggestions` JSONB has lost-update races, `useServerSync.writingBackRef` is cleared synchronously around React state setters.

## Cross-cutting themes (signal weighted by how many agents converged)

### Theme A — Big files want directory splits (4 agents)
Sessions agent + Refactor agent both flag `lib/sessions.ts` (2572 LOC) with the same recommended split using existing `// PR 1` / `// PR 2` / `// PR 3` markers. Discord agent flags `api/bot.ts` (2618). Trade UI agent flags `App.tsx` (1235) and `SessionView.tsx` (1327). Trades agent flags `api/trades.ts` (1641) mixing two unrelated subsystems.

### Theme B — Schema drift / lack of Drizzle inference (4 agents)
Types agent (explicit), Auth agent (`SessionData` ↔ wire `User`), Trades agent (`TradeStatus` as plain union, no exhaustiveness), Sessions agent (status strings vs typed enums). One fix: export `proposalStatuses` like `sessionStatuses`, infer shapes via `InferSelectModel`, and define a shared `MeResponse` / `TradeProposal` etc. type module.

### Theme C — Sequential awaits + N+1 queries (4 agents)
Performance + Trades + Auth + Lists each flag specific instances on user-visible paths:
- `countUnreadEvents` (Sessions / Performance #1) — full-table SELECT every 2.5s poll instead of `COUNT(*)`
- `handlePropose` 4 sequential SELECTs (Trades #5)
- `syncGuildMemberships` sequential upsert loop blocks OAuth (Auth #2)
- `api/sync.ts` 200-card binder = 200 sequential round-trips (Lists #2)
- Signal embed N+1 (Performance #2)

### Theme D — React render cascades (3 agents)
Performance, Trade UI, and Sessions all flag the same root cause from different angles:
- AuthContext / PriceDataContext / PrimaryActionContext don't memoize their `value` (Performance #3)
- `useAuth` returns a fresh object literal every render
- `TradeSide` takes 24 props twice and isn't memoized (Trade UI #1)
- `useSession` mutation callbacks have `session` in deps → cascade fires every poll (Sessions #5)
- The 60s `setMinuteTick` re-renders all of App, which then re-runs all the above

### Theme E — Race conditions in optimistic / cross-device flows (3 agents)
- `useServerSync.writingBackRef` cleared synchronously around React state setters (Lists #1) — debounced PUT can fire after the guard has flipped
- `pendingSuggestions` JSONB read-modify-write across 5 mutation paths without optimistic concurrency (Sessions #4)
- `promote-to-shared` skips `.returning()` race-guard (Trades #1)

### Theme F — Small repeated patterns worth consolidating (2 agents)
- `restrictionKey` reimplemented in 5 places (Lists + Refactor)
- `Avatar` × 3, `timeAgo` × 4, `CloseIcon`/`ChevronIcon`/`CheckIcon` × 6+ (Refactor)
- Discord embed-builder skeleton across 6+ proposal/thread variants (Refactor)
- `failure()` status-mapping copied verbatim across `apiClient.ts` and `tradeActions.ts` (Refactor)
- Mutex bookkeeping inlined ~14× in `useSession.ts` (Refactor #1)

### Theme G — Dead code totaling ~213 LOC (3 agents)
`SearchResults.tsx` (72 LOC), `SetFilter.tsx` (141 LOC), `lib/communityEvents.ts:listEventsForGuilds`, dead `'expired'` status path in trade proposals, `__mapFailureForTradeActions` re-export, plus exports-that-should-be-internal in `lib/sessions.ts` and `lib/signalMatching.ts`.

## Roadmap

Each item annotated `[risk · effort · sources]`. Where two or more agents converged, that's listed.

### Tier 1 — Must-fix (correctness + reliability)

| # | Item | Risk · Effort · Source |
|---|---|---|
| M1 | `handleLogout` method gate (logout-CSRF surface) | low · XS · Auth #4 |
| M2 | Clear OAuth state/verifier cookies on every error path | low · XS · Auth #1 |
| M3 | `promote-to-shared` race-guard + new `'promoted'` status | medium · S · Trades #1 |
| M4 | Bot role overwrite via `type: 1` user-id, not `roles[0]` | low · S · Discord #3 |
| M5 | `useServerSync` writingBackRef race fix | medium · S · Lists #1 |
| M6 | `pendingSuggestions` revision column + optimistic concurrency | medium · M-L · Sessions #4 |
| M7 | Nightly sweep for orphan anonymous users | low · S · Auth #3 |
| M8 | Cron sweep for orphan bot threads | medium · S · Discord #5 |
| M9 | Replace `created as unknown as Item` with throw-on-null | low · XS · Types #3 |

**Pick first:** M1 + M2 + M9 are XS each — knock them out in one commit. Then M5 (silent-data-loss potential) and M3 (history corruption). M6 needs a schema migration so it's the largest correctness item; defer behind a small de-risk RFC.

### Tier 2 — High-leverage (perf + structural)

| # | Item | Risk · Effort · Source |
|---|---|---|
| H1 | `countUnreadEvents` → `COUNT(*)` query | low · XS · Performance #1 |
| H2 | Memoize context provider values (Auth/PriceData/PrimaryAction) | low · S · Performance #3 |
| H3 | `Promise.all` the sequential-await offenders (handlePropose, syncGuildMemberships, api/sync.ts upsert loop) | low · S each · Trades + Auth + Lists |
| H4 | Export `proposalStatuses`, use `InferSelectModel`, share `MeResponse` type | low · S · Types #1 + Auth #5 |
| H5 | `apiClient` zod validation overload (incremental adoption on hot paths) | low · M · Types #2 |
| H6 | Extract `withMutationLock` in `useSession` (replaces 14 inlined pairs) | low · S · Refactor #1 |
| H7 | Centralize `restrictionKey` + `normalizeRestriction`; normalize at server-pull boundary | low · S · Lists #3+#4 + Refactor |
| H8 | `React.lazy` non-trade-builder routes | low · S · Performance #4 |
| H9 | Split `lib/sessions.ts` into `lib/sessions/{core,events,suggestions,revert,chat,invite,ghost-merge}.ts` via PR markers | medium · M · Sessions #1 + Refactor #4 |
| H10 | Split `api/bot.ts` into `lib/bot/*` (preserve `api/bot.ts` as thin entry for the function-count cap) | medium · L · Discord #1 |
| H11 | Split `api/trades.ts` proposal handlers into `lib/proposalHandlers.ts`; delete dead saved-trades GET branch + `'expired'` enum value | medium · M · Trades #2+#3 |
| H12 | Extract `SessionCanvas` from `SessionView.tsx`; replace IIFE with early-return | low · M · Sessions #3 |
| H13 | `TradeBuilderContext` to lift shared props; `React.memo(TradeSide)` | medium · M · Trade UI #1 |

**Pick first:** H1 is the single best ROI in the audit — XS effort, fires every 2.5s on every active session tab. Then H2 + H6 + H7 + H3 (all S, mechanical, big ripple). H4 + H5 are the type-safety foundation; do before more handlers land. The big splits (H9-H13) come last and serially since they touch the largest files.

### Tier 3 — Nice-to-have (small wins, low risk)

| # | Item | Source |
|---|---|---|
| N1 | Delete `SearchResults.tsx`, `SetFilter.tsx`, `listEventsForGuilds`, dead `'expired'` branches, internal-only `export`s | Types #4 + Trade UI #4 |
| N2 | `src/components/ui/Avatar.tsx` + `GuildAvatar.tsx` + 3 shared icons; `src/utils/relativeTime.ts` (4 → 1) | Refactor #3 |
| N3 | Extract `proposalCardFields()` / `proposalFooter()`; add `purple` to `COLORS` | Refactor #2 |
| N4 | Make `tradeActions.post` call `apiPost`; delete duplicated `failure()` and dead re-export | Refactor #5 |
| N5 | Consume `CardIndexContext` in WishlistView/BinderView/ListsDrawer (drop 3 redundant 8000-card maps) | Lists #5 |
| N6 | Move `resolveSignalFamily`/`resolveVariantSpec` to `lib/signalMatching.ts`; drop dynamic-import workaround | Discord #2 |
| N7 | Thread `landscape` from upstream to `CardThumb`/`CardTile` | Trade UI #5 |
| N8 | Trade-status discriminated union + transition table + `assertNever` | Trades #4 |
| N9 | Extract `renderTradeBuilder` from `App.tsx` into `TradeBuilderRoot.tsx` | Trade UI #3 |
| N10 | Batch signal embed assembly (resolve all wants/available rows in 2 `inArray` queries) | Performance #2 |
| N11 | Share-cache hooks: `useFavorites`, `useRecentPartners`, `useCommunityCards`, `useMutualBotGuilds` | Performance #5 |
| N12 | `getUserPrefColumn(key)` / `getPeerPrefColumn(key)` helpers (replaces 5 dynamic-column casts) | Discord #4 |
| N13 | Lazy-mount `TradeSearchOverlay` + imperative `setQuery` (verify via profile first) | Trade UI #2 |

### Tier 4 — Anti-recommendations (don't re-flag in next audit)

Captured across all reports. The next audit should treat these as load-bearing:

- **The 2.5s `useSession` poll** is intentional + UX-deliberate. Make polls cheaper (H1), don't slow them.
- **`?action=…` flat dispatchers in `api/auth.ts`, `api/sessions.ts`, `api/trades.ts`, `api/me.ts`** buy function-ceiling slots under the 12-function Hobby cap. Don't replace with a routing framework.
- **`req.headers.host` in `getRedirectUri`** is the documented fix for the beta-subdomain regression. Don't revert to env-based.
- **The HTML interstitial in `handleDiscordStart`** is the iOS Safari cross-origin-redirect workaround.
- **`iron-session`'s open-mutate-save pattern in `setPendingMergeBanner`** is the documented mutation idiom. Don't add an in-memory layer.
- **`syncGuildMemberships` swallows Discord errors by default** — sign-in must not block on Discord availability.
- **`pendingSuggestions` as JSONB, not a child table.** Cap-of-10 is app-side; ghost-merge gains a third table; auto-dismiss-then-prune gets harder with FKs. Fix concurrency with optimistic locking, not normalization.
- **`recordOrMergeEditedPair`'s 30s merge window** + paired snapshots drive timeline readability AND the revert UI. Don't collapse to "always insert."
- **Event-log writes are fire-and-forget** — audit-log loss is correctness-neutral; `await`ing would let event hiccups roll back state.
- **`targetSide: 'a' | 'b' | 'both'`** for suggestions is one function for shared cap/lock/merge checks. Don't split into separate suggestion types.
- **No SSE/WebSockets to replace polling** — doubles function-count budget.
- **`TradeSearchOverlay` always-mounted** keeps the card index warm for instant first-open. Trade-off intentional; flip only after profiling proves the warm-up cost is real.
- **`tradeCardKey = ${productId || name}-${set}`** — name-fallback is legitimate for cards lacking productId. Don't tighten.
- **`cardFamilyId` uses `::` separator** intentionally; `familyId.split('::')[0]` IS sound.
- **`Popover` portals to body** — load-bearing inside `overflow-hidden` ancestors. Don't downgrade.
- **Hover-reveal kebab pattern** with the 0.7-opacity touch fallback is correct.
- **`discordClient.ts` and `discordBot.ts`** wrap user OAuth tokens vs bot tokens; Discord treats them as distinct rate-limit buckets. Leave parallel.
- **The Discord retry helper's single-retry/capped-sleep** is correct for Vercel's 10s ceiling. Don't add exponential backoff.
- **Don't add idempotency keys to `postChannelMessage`** — Discord has no idempotency-key header.
- **Color reservation** (emerald/blue=sides, gold/amber/crimson=balance) is an SWU design invariant. Don't consolidate to a generic accent token.
- **`isPriority` is wants-only by design.** Available items have no "ship first" semantic.
- **Wants vs available models stay separate** — wants are family-keyed with variant restrictions; available are productId-keyed.
- **Drawer + dedicated WishlistView/BinderView coexist** — modal vs page constraints genuinely diverge.
- **Don't move community overlap math server-side** — privacy comment in `api/me.ts:586-594` explains why client-side intersection is correct.
- **`bulk-resolve`'s sequential per-row UPDATEs** are deliberate — Discord error 40003 mitigation, 200ms inter-DM spacing.
- **`handleCounter`'s insert+update without a transaction** is intentional — Neon HTTP-driver transactions have footguns; orphan cleanup is tested.
- **`as unknown as Record<string, AnyPgColumn>` in the prefs registry** is the deliberate dynamic-column escape hatch; column names are test-validated.
- **`__resetXCache` exports in hooks** are test-only escape hatches.
- **Vercel-handler default exports knip-flagged as unused** are reached via `vercel.json` rewrites.

## Disagreements + nuances

No direct disagreements between agents — overlap consistently agrees. One nuance worth flagging: Trade UI agent's anti-recommendation says "TradeSearchOverlay always-mounted is intentional for warm cache" but their finding #2 proposes lazy-mount; they hedge with "verify via profile before flipping." Treat lazy-mount as gated on a perf measurement, not a reflexive refactor.

## Recommended sequencing for execution

If we run another autonomous-loop pass on this:

**Sprint 1 (fast wins, ~1 day of agent time):** M1 + M2 + M9 + H1 + H6 + H7 + N1 + N4 in one commit cluster. All XS-S, all low-risk, all converge on multiple agents' findings.

**Sprint 2 (foundational type safety):** H4 + H5. One commit lands `proposalStatuses` + `InferSelectModel`-based shared types; subsequent commits migrate hot paths to zod-validated `apiClient` overloads.

**Sprint 3 (the perf cluster):** H2 + H3 + H8. Memoize contexts, parallelize the four sequential-await sites, lazy-load views.

**Sprint 4 (correctness + cleanup):** M3 + M5 + N6 + N10 + N12. Race-fixes and mid-size dedup.

**Sprint 5 (the big splits, do last and serially):** H9 (sessions split) → H10 (bot split) → H11 (trades split) → H12 (SessionView extract) → H13 (TradeBuilderContext + memo). Each is its own commit with CI verification.

**Defer to RFC:** M6 (pendingSuggestions schema migration), M7/M8 (orphan sweeps — need cron infra check).

Total scope: ~30 commits across 5 sprints. Each commit follows the autonomous-loop pattern (one milestone → CI verify → next).

## Addendum: UX primitives audit

A 10th-agent pass (`10-ux-primitives.md`) sweeping every `src/components/` file for behaviorally-equivalent reimplementations of UI primitives surfaced a class of duplication the original 9 missed. Headline finding: `ui/NumberStepper.tsx` exists and is used in 2 places, but TradeRow, CardTile, and FamilyRow each reimplement the +/− stepper inline — even sharing a byte-identical local `qtyBadgeClass: Record<'gold'|'emerald'|'blue', string>` map across CardTile.tsx:39-49 and FamilyRow.tsx:53-63. The fix is `ui/QtyAdjuster` with `accent` + `variant: 'split'|'pill'` props (preserving the deliberate emerald/blue side-coloring invariant) — call it **U1** and slot into Sprint 4 alongside the other dedup work. Adjacent findings: avatar duplicated 7× (folds into N2), 4 incompatible tab visuals, 6 inline card-thumbnail implementations where only TradeRow detects landscape orientation (subsumes N7 with a wider scope — extract `ui/CardThumb`), and 3 competing modal patterns that hand-rolled half the dialogs without focus-trap or scroll-lock. Lower priority: empty/loading-state strays (4 inline + 1 duplicate local definition in SignalBuilderView), `window.confirm` mixed with two-tap-arm. Anti-recommendations preserve the side-coloring invariant, the page-replacing overlays as distinct from dialogs, and `SetFilter`'s deliberate custom listbox.
