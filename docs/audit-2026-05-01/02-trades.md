# Trades subsystem audit

Scope: `api/trades.ts` (1641 LOC), `lib/proposalResolve.ts`,
`lib/proposalMessages.ts`, proposal-related components + hooks,
`tests/api/trades-*.test.ts` (8 files, light pass).

## High-impact findings

### 1. `promote-to-shared` overloads `'countered'` and skips race-guard
- **What:** `promoteProposalToSession` flips the proposal to `'countered'` and writes a `countered` event — but a promotion isn't a counter. It also drops the optimistic-concurrency `.returning()` check every other transition uses.
- **Where:** `lib/sessions.ts:1504-1514`, `:1547-1549`; status enum `schema.ts:363`.
- **Why it matters:** `useTradesList` files `'countered'` rows under History and `TradesHistoryView.tsx:457` chips them with the purple "Counter" label even though no counter exists. The missing `.returning()` guard means a recipient who clicks Promote while the proposer cancels still creates a session referencing an already-cancelled proposal — the `WHERE status='pending'` matches zero rows but the code records events anyway.
- **Proposed fix:** Add `'promoted'` to the status enum + matching event type. Capture UPDATE with `.returning({ id })` and on zero rows roll back the session insert (mirror `handleCounter`'s cleanup at `api/trades.ts:980-985`).
- **Risk:** medium · **Effort:** S · **Confidence:** high

### 2. Dead `'expired'` status — enum claims a transition that doesn't exist
- **What:** `tradeProposals.status` (`schema.ts:363`) and `TradeStatus` (`useTradeDetail.ts:21`) include `'expired'`, docs at `schema.ts:341` advertise a TTL transition, timeline + `StatusBadge` handle it. No writer exists — only `card_signals` and `tradeSessions` actually expire. Agent prompt listed "expire" among `api/trades.ts`'s actions; it does not exist.
- **Where:** `schema.ts:341, 363`; `useTradeDetail.ts:21, 44`; `TradeDetailView.tsx:484`.
- **Why it matters:** Misleads readers; rendered to users but unreachable.
- **Proposed fix:** Drop `'expired'` from the enum + delete dead UI branches; pending-forever is fine.
- **Risk:** low · **Effort:** S · **Confidence:** high

### 3. `api/trades.ts` is 1641 LOC mixing two unrelated subsystems
- **What:** Phase-2 "save my trade" (`handleSavedTrades`) lives with the entire Phase-4c proposal lifecycle (8 handlers, ~1500 LOC) — different tables, domains, consumers. Eight handlers repeat the `requireSession → method → Zod → 409` envelope verbatim ~6×.
- **Where:** `api/trades.ts:42-61` dispatcher, `:74-119` saved trades, rest = proposals.
- **Why it matters:** Every edit forces loading the whole state machine. Saved-trades GET is dead — only `TradeSummary.tsx:194` POSTs.
- **Proposed fix:** Move proposal handlers to `lib/proposalHandlers.ts`; keep `api/trades.ts` a thin router (preserves the 12-fn ceiling). Delete the dead GET branch + its tests. Extract a `withProposalAction()` envelope.
- **Risk:** medium · **Effort:** M · **Confidence:** medium

### 4. Status string used in place of a discriminated FSM
- **What:** `TradeStatus` is a plain union; call-sites pattern-match without exhaustiveness checks. The propose→counter→accept state machine is implicit across scattered if/switch ladders.
- **Where:** `useTradeDetail.ts:21`; `TradeDetailView.tsx:236-242, 465`; `TradesHistoryView.tsx:64-66, 178`; `proposalResolve.ts:81`; `api/trades.ts:709, 904, 1128, 1260, 1452`.
- **Why it matters:** Adding a state (e.g., `'promoted'` from finding 1) means touching ~10 sites; misses surface at runtime.
- **Proposed fix:** A `TRADE_STATUS_TRANSITIONS: Record<TradeStatus, ReadonlySet<TradeStatus>>` table beside the schema + `assertNever` helper.
- **Risk:** low · **Effort:** S · **Confidence:** high

### 5. `handlePropose` issues 4 sequential SELECTs before insert
- **What:** Recipient (`:188-197`), proposer (`:211-218`), guild resolve (`:228-233`), proposer-discord-id (`:255-259`) all sequential. Proposer SELECTed twice for non-overlapping columns. `handleCounter` repeats at `:911-930`.
- **Why it matters:** ProposeBar's Send waits on the whole chain. Neon round-trips ~30-80ms each; combining + parallelising shaves ~150ms off the user-visible path.
- **Proposed fix:** One `users.id IN (proposerId, recipientId)` SELECT; `Promise.all` with guild resolve.
- **Risk:** low · **Effort:** XS · **Confidence:** high

## Lower-priority debt

- `useTradeDetail.ts:183-199` — `wrap` returns `{ ok:false, reason:'error' }` for a re-click while mutating; caller can't distinguish from real errors.
- `TradesHistoryView.tsx:75-81` — default-tab effect re-runs on every list-length change; deps wider than needed.
- `proposalMessages.ts` 1117 LOC serves three unrelated namespaces (proposal lifecycle, prefs registry, server-invite). Future split.
- `api/trades.ts:1138-1142` — `JSON.stringify(...)` cards-equality fragile if jsonb readback ever reorders keys; a `cardsEqual` helper would be honest.
- `proposalResolve.ts:124-133` — two sequential SELECTs by user id; same `inArray`+dispatch fix as finding 5.
- `TradeRow` name overloaded: `src/components/TradeRow.tsx` (trade-builder line) vs local `TradeRow` in `TradesHistoryView.tsx:369` (proposal row). Rename one.
- Tests: many seed via direct `db.insert` and assert exact event-row counts; moderately brittle to schema additions but acceptable.

## Anti-recommendations

- **Don't** consolidate `deliveryStatus` into `status`. Schema comment at `schema.ts:385-389` makes the case: logical state and Discord transport are orthogonal axes. Current split is right.
- **Don't** wrap `handleCounter`'s insert+update in a Postgres transaction. The "insert counter, optimistic UPDATE original, delete-on-loss" pattern (`api/trades.ts:940-985`) is intentional — Neon HTTP-driver transactions have footguns and orphan cleanup is tested.
- **Don't** delete `handleSavedTrades` outright; POST is still used by `TradeSummary.tsx:194`. Drop only the GET branch.
- **Don't** flag `bulk-resolve`'s sequential per-row UPDATEs as N+1. The 200ms inter-DM spacing and per-row optimistic concurrency are deliberate — see `:1366-1389` rationale on Discord error 40003.
- **Don't** flag `JSON.stringify` cards-equality as a runtime bug — Drizzle preserves jsonb input ordering on read for our schema. Stylistically weak, not broken.
