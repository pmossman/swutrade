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

Updated 2026-05-01 after the 4 follow-up audits (accessibility, empty/loading/error states, mutation patterns, domain rendering) added new tier-1 must-fix items. The mutation-race shape lives in 4 more hooks beyond the originally-fixed `saveCards`; the `familyId.split('::')` parser bug class has 3 more sites (one actively lossy in CommunityView). These are class-of-bug findings — ship them in Sprint 1.

### Status (live tracker)

- ✅ **Sprint 1 done** — see `SPRINT1_PLAN.md`. 12/12 milestones; commits `daab55d` → `af52de0`.
- ✅ **Sprint 2 done** — see `SPRINT2_PLAN.md`. 5/5 milestones; commits `40010b4` → `6c58107`.
- ✅ **Out-of-band fix** (`9ff0b00`): max-$ removed from signal builder + Discord embed per parker's call that signals are conversation-starters, not pre-committed prices. Wants/binder personal max-price unaffected; DB column kept for backwards-compat.
- ✅ **Sprint 3 done** — see `SPRINT3_PLAN.md`. 5/5 milestones; commits `e56c682` → `ad5fe14`. Perf cluster: H2 (context memoization), H3 (3 sequential-await sites parallelized), H8 (~57 kB gzipped lazy-deferred), N10 (signal embed N+1 → 2 inArray queries), N11 (4 hooks adopt sharedCache).
- ✅ **Sprint 4 done** — see `SPRINT4_PLAN.md`. 7/7 milestones; commits `d3426a5` → `ebb8a27`. UX primitive consolidation: N15 (LoadingState inline), N16 (ErrorState variants), D4 (relativeTime), D3 (formatPrice), U3 (CardThumb), U1 (QtyAdjuster), U2 (Radix dialogs).
- ✅ **Sprint 5 done** — see `SPRINT5_PLAN.md`. 6/6 milestones; commits `a490a00` → `d636026`. Mid-size correctness: N18 (KebabMenu aria), N12 (typed prefs accessors), N19 (button tiles), N6 (signal resolvers moved), M5 (useServerSync race), M3 (promote-to-shared race-guard + 'promoted' status).
- ⏳ **Sprint 6 next** — the big splits (H9 sessions, H10 bot, H11 trades, H12 SessionView, H13 TradeBuilderContext).

Combined Sprint 1+2+3+4+5: 36 commits, all CI-verified. ~470 LOC net deleted from Sprint 1; subsequent sprints net-add infrastructure (canonical helpers, gen-counter refs, Radix dialogs) while removing duplication so net LOC change stays modest. Type drift collapsed across 5+ surfaces. 4 mutation-race classes fixed. Perf wins: 60s minute-tick no longer cascades through context consumers; binder/wants saves go from 6-10s to ~1 round-trip; initial JS bundle ~57 kB gzipped lighter; signal embed assembly is two queries flat. UX wins: composer bars use canonical LoadingState; per-row + action errors use canonical ErrorState variants; relative-time labels consistent across views; price labels show `N/A` instead of misleading `$0.00`; all qty steppers + 3 dialogs gain a11y baseline (focus-trap, scroll-lock).

**Sprint 1 (revised, ~12 commits):** Fast correctness wins + the highest-impact perf find + first-pass dedup. Runs autonomously once kicked off. Items in execution order:

| # | Source | Item | Effort |
|---|---|---|---|
| S1.1 | N1 | Delete dead code (~213 LOC: SearchResults.tsx, SetFilter.tsx, listEventsForGuilds, internal-only `export`s) | XS |
| S1.2 | M1 | `handleLogout` POST-only method gate (CSRF) | XS |
| S1.3 | M2 | Clear OAuth state/verifier cookies on every error path | XS |
| S1.4 | M9 | Replace `created as unknown as Item` with throw-on-null in useWants/useAvailable | XS |
| S1.5 | H1 | `countUnreadEvents` → `COUNT(*)` (every-2.5s-poll regression) | XS |
| S1.6 | N4 | Make `tradeActions.post` call `apiPost`; delete duplicated `failure()` + `__mapFailureForTradeActions` re-export | XS |
| S1.7 | H7 + D5 | Centralize `restrictionKey` + `normalizeRestriction` at server-pull boundary; align restriction-label divergence | S |
| S1.8 | M10a | Mutation-race fix in `useGuildMemberships.updateGuild` (gen-counter + drop-stale-response) | S |
| S1.9 | M10b | Mutation-race fix in `useAccountSettings.update` + `useCommunityMembers.setPeerPref` (shared `/me/prefs` shape) | S |
| S1.10 | M10c + H6 | Mutation-race fix in `useTradeDetail.nudge`; rename `mutationInFlightRef` → `pollPauseRef`; extract `withMutationLock` for new race-aware shape | S |
| S1.11 | M11 + D1 | Replace `familyId.split('::')` parsing with map-lookup at 3 sites (CommunityView's lossy slug-titlecase fix is the user-visible win) | S |
| S1.12 | D2 | Consolidate `extractVariant` (3 copies, 2 missing canonical Regional regex; OG-image + share-link payloads currently render TCGPlayer collector-numbers as variant labels) | S |

**Sprint 2 (foundational type safety):** H4 + H5. Export `proposalStatuses` + `InferSelectModel`-based shared types; incremental zod-validated `apiClient` migration.

**Sprint 3 (the perf cluster):** H2 + H3 + H8 + N10 + N11. Memoize contexts, parallelize the four sequential-await sites, lazy-load non-builder routes, batch the signal-embed N+1, share-cache the four singleton-cache-missing hooks.

**Sprint 4 (UX primitive consolidation):** U1 (`ui/QtyAdjuster`) + U2 (Radix Dialog migration for hand-rolled modals — focus-trap + scroll-lock + a11y) + U3 (`ui/CardThumb` w/ landscape detection) + D3 (adopt `formatPrice` everywhere) + D4 (single `relativeTime` helper) + N15 + N16 (LoadingState `inline` variant; ErrorState variants).

**Sprint 5 (mid-size correctness):** M3 (`promote-to-shared` race-guard + `'promoted'` status) + M5 (`useServerSync` race) + N6 (`resolveSignalFamily`/`resolveVariantSpec` dedup) + N12 (typed prefs-registry column accessors) + N18 (KebabMenu aria-haspopup/expanded/controls) + N19 (`<button>` for tiles).

**Sprint 6 (the big splits, serial):** H9 (sessions split) → H10 (bot split) → H11 (trades split) → H12 (SessionView extract) → H13 (TradeBuilderContext + memo). Each its own commit with CI verification.

**Defer to RFC:** M6 (pendingSuggestions schema migration), M7/M8 (orphan sweeps — need cron infra check), M4 (bot role overwrite — latent, not active).

Total scope: ~40 commits across 6 sprints. Each commit follows the autonomous-loop pattern (one milestone → CI verify → next).

## Addendum: Accessibility audit

An 11th-agent pass (`11-accessibility.md`) sweeping every interactive element under `src/components/` for aria-label conventions, role usage, keyboard support, focus management, and color-only signaling. Headline: the same UX-primitive divergence flagged by agent 10 also fragments accessibility — the qty stepper's aria-label convention has four variants across `NumberStepper`, `TradeRow.tsx:283`, `CardTile.tsx:195`, `FamilyRow.tsx:149`, and `ListRows.tsx:24` (one says `"Remove"`, one says `"Decrease quantity"`, two say `"Decrease quantity of ${name}"`), and three of four hand-rolled dialogs (`NudgeDialog`, `HandlePickerDialog`, `TradeImageModal`) declare `role="dialog"` but skip focus-trap + focus-restore — all of which Radix `Dialog.Root` (already in deps via `ProposeBar` + `ListsDrawer`) gives free. Top XS wins: `KebabMenu.tsx:42` is missing `aria-haspopup`/`aria-expanded`/`aria-controls` despite `AccountMenu` and `NavMenu` wiring all three, and `AutoBalanceBanner.tsx:190` shows error state via red text alone (no `role="alert"`, icon `aria-hidden`) while `ProposeBar` does it correctly. Also flagged: tabs declare `role="tablist"`+`role="tab"` everywhere but only `ProfileView.tsx:396` pairs a `role="tabpanel"`; `<div role="button">` tiles in CardTile/FamilyRow reimplement what `<button>` gives free; four `window.confirm()` sites break the ARIA tree + palette (already captured in UX 10-5).

## Addendum: UX primitives audit

A 10th-agent pass (`10-ux-primitives.md`) sweeping every `src/components/` file for behaviorally-equivalent reimplementations of UI primitives surfaced a class of duplication the original 9 missed. Headline finding: `ui/NumberStepper.tsx` exists and is used in 2 places, but TradeRow, CardTile, and FamilyRow each reimplement the +/− stepper inline — even sharing a byte-identical local `qtyBadgeClass: Record<'gold'|'emerald'|'blue', string>` map across CardTile.tsx:39-49 and FamilyRow.tsx:53-63. The fix is `ui/QtyAdjuster` with `accent` + `variant: 'split'|'pill'` props (preserving the deliberate emerald/blue side-coloring invariant) — call it **U1** and slot into Sprint 4 alongside the other dedup work. Adjacent findings: avatar duplicated 7× (folds into N2), 4 incompatible tab visuals, 6 inline card-thumbnail implementations where only TradeRow detects landscape orientation (subsumes N7 with a wider scope — extract `ui/CardThumb`), and 3 competing modal patterns that hand-rolled half the dialogs without focus-trap or scroll-lock. Lower priority: empty/loading-state strays (4 inline + 1 duplicate local definition in SignalBuilderView), `window.confirm` mixed with two-tap-arm. Anti-recommendations preserve the side-coloring invariant, the page-replacing overlays as distinct from dialogs, and `SetFilter`'s deliberate custom listbox.

## Addendum: Empty/Loading/Error states audit

A 12th-agent deeper sweep (`12-empty-loading-error-states.md`) found the 10th-agent's tally was conservative: `EmptyState` is reimplemented locally **six times** (WantsPanel/AvailablePanel/SignalBuilderView/SessionTimelinePanel/CardResultsGrid + HomeView's `EmptyListState`), inline `animate-pulse` loading text appears in five composer bars (AutoBalanceBanner/EditBar/CounterBar/ProposeBar/ProfileView), and 20+ surfaces ship bare `text-red-300/400` instead of `ErrorState` — including three near-byte-identical reimplementations of the canonical card chrome in NudgeDialog/TradesHistoryView/ProposeBar. Convergence path: add `inline` variant to `LoadingState` (XS), promote `ErrorLine` + `variant` prop to `ErrorState` (S), and either migrate WantsPanel/AvailablePanel/SignalBuilderView to canonical `EmptyState` or promote `EmptyListState` as a third primitive (S). Anti-recommendations: composer-bar inline errors stay (PrimaryActionBar pattern), per-row mutation errors stay (locality is intentional), TradeExpandPeek/TerminalBanner/CenteredMessage stay (distinct semantics).

## Addendum: Mutation patterns audit

A 13th-agent pass (`13-mutation-patterns.md`) tabulated every client mutation across `src/` (~29 entries). Headline: the recently-fixed qty-stepper race shape exists in **5 hooks** — `useSession.saveCards`, `useGuildMemberships.updateGuild`, `useAccountSettings.update`, `useCommunityMembers.setPeerPref`, plus `useTradeDetail.nudge` (which deliberately bypasses `wrap`'s mutex). Three are fully unguarded against rapid re-entry; only the e2e `clickAndWaitForEdit` helper enforces serialization, and only on `saveCards`. The fix shape — gen-counter ref + drop-stale-response in setState — applies uniformly without forcing per-feature optimistic-shape convergence (the original "don't extract a generic `useOptimistic`" anti-recommendation still holds). Also flagged: `useSession`'s `mutationInFlightRef` is mis-named as a mutex when it's actually a poll-pause flag, `useFavorites.add`/`remove` are asymmetric (remove optimistic, add server-leads), `TradeSummary.handleSave` (`:194`) is the lone call site bypassing `apiClient`.

## Addendum: Domain rendering audit

A 14th-agent pass (`14-domain-rendering.md`) catalogued every rendering surface for cards, variants, prices, sets, handles, dates, keys, and quantities. Highest-leverage findings: three places parse `familyId` as a substitute for a `familyId → card` lookup (`SignalBuilderView.tsx:122`, `CommunityView.tsx:727-737`, `lib/signalMatching.ts:68`) — and CommunityView's slug-titlecase fallback is actively lossy (loses "of"/"the" and parens; the comment self-flags the upgrade). Two duplicate `extractVariant` copies in `api/og.ts:117`, `api/search.ts:32`, and `ShareLiveTradeButton.tsx:83` miss the canonical `(\d+) → 'Regional'` rule, so OG-image and share-link payloads render TCGPlayer's collector-number parens as variant labels. Eight+ proposal/list surfaces inline `` `$${n.toFixed(2)}` `` instead of `formatPrice` (renders `$0.00` for null where it's most misleading); the refactor agent's "4 timeAgo variants" is actually 5+ relative-time helpers + 5 raw `toLocaleString` sites; `cardBaseName(card)` exists but five components inline the equivalent expression. Slot into Sprint 4 alongside H7 — call them **D1** (familyId→card map), **D2** (canonicalize `extractVariantLabel` for `/api`), **D3** (adopt `formatPrice` everywhere + surface `countMissingPrices` on proposal views), **D4** (single `relativeTime` helper, supersedes N2). Plus a smaller **D5** for restriction-label divergence between editor (`'Hyperspace or Showcase'`), read-only (`'HS / SC'`), and dedup key (`Hyperspace|Showcase`). Anti-recommendations preserve the breadcrumb-vs-panel "Trade with @handle" / "with @handle" split, the `tradeCardKey` name fallback, the `cardFamilyId` `::` separator, the `'3 variants'` editor collapse, and `formatPrice`'s `'N/A'` (not `$0.00`) behavior.
