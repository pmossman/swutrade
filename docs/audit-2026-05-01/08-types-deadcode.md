# Types & dead code — cross-cutting sweep

Scope: 275 .ts/.tsx files. Counts across `lib/`, `api/`, `src/`
(excluding tests).

Headline numbers:
- Non-trivial `: any` outside tests: **3** (`api/search.ts:90`,
  `src/hooks/usePriceData.ts:48`, plus a stray comment).
- `as unknown as <T>`: **15** — mostly the deliberate
  Drizzle dynamic-column escape hatch.
- `@ts-ignore` / `@ts-expect-error`: **1** (`vite.config.ts:25`,
  upstream typing bug — fine).
- `TODO/FIXME/HACK/XXX`: **1** (in a test file).
- Knip-flagged unused exports: **27**, types: **61**, files:
  **2 truly dead**; the rest are knip false-positives
  (handlers reached via `vercel.json` rewrites).

## High-impact findings

### 1. Schema types duplicated front/back; no Drizzle inference
- **What:** `lib/schema.ts` is the source of truth but no
  consumer uses `InferSelectModel` / `$inferSelect`. The
  frontend re-declares identical shapes: `TradeCardSnapshot`
  at `src/hooks/useTradeDetail.ts:13` (vs `schema.ts:326`);
  `TradeStatus` at `useTradeDetail.ts:21` (vs the inline
  literal at `schema.ts:363`); `SessionStatus` at
  `src/hooks/useSession.ts:8` (vs `schema.ts:587-588`);
  `SessionEventType` at `useSession.ts:10-23`. There is no
  exported `ProposalStatus` mirroring `sessionStatuses`.
- **Why it matters:** if a status enum gains a state, the
  schema and `api/*` update but hook copies don't — TS
  won't catch it because the API response is cast through
  `apiClient`'s `as T` (finding #2). `api/trades.ts:240,
  713, 904, 945, 967, 1128` references the literal with
  no shared type.
- **Proposed fix:** export `proposalStatuses` +
  `ProposalStatus` from `schema.ts` like `sessionStatuses`.
  Move shared shapes into `src/types/api.ts` sourced
  from `InferSelectModel<typeof tradeProposals>`.
- **Risk:** low. **Effort:** S. **Confidence:** high.

### 2. `apiClient` casts every response to `T` with no validation
- **What:** `request<T>()` does `(parsed ?? {}) as T`
  (`src/services/apiClient.ts:58-60`); 44 call sites trust
  the generic argument blindly.
- **Why it matters:** any incompatible API change silently
  mis-types the frontend until something throws at access
  time. Compounds with #1.
- **Proposed fix:** overload accepting `z.ZodSchema<T>`;
  hot paths migrate incrementally. `src/persistence/index.ts`
  proves the team-favored validation pattern.
- **Risk:** low. **Effort:** M (incremental).
  **Confidence:** high.

### 3. `created as unknown as Item` in list-add hooks
- **What:** `src/hooks/useWants.ts:155` and
  `src/hooks/useAvailable.ts:92` both do
  `return created as unknown as Item;` because the
  closure-assigned local stays typed `Item | null`.
  Identical bugs — copy-pasted pattern.
- **Why it matters:** the cast lies. If the reducer ever
  returns `{ created: null, items }`, callers receive
  `null` typed as `WantsItem`/`AvailableItem`.
- **Proposed fix:** `if (!created) throw new Error(...);
  return created;` (TS narrows). Or pull the reducer
  call out of `setItems` so the value flows directly.
- **Risk:** low. **Effort:** XS. **Confidence:** high.

### 4. Confirmed dead components & lib symbols (~213 LOC)
- **Where:**
  - `src/components/SearchResults.tsx` (72 LOC) — 0 importers
  - `src/components/SetFilter.tsx` (141 LOC) — 0 importers
  - `lib/communityEvents.ts:194` — `listEventsForGuilds`,
    no callers
  - `lib/sessions.ts:133, 1861` — `MAX_PENDING_SUGGESTIONS`
    and `EDITED_MERGE_WINDOW_MS` exported but only used
    locally; drop `export`
  - `lib/signalMatching.ts:67` — `setCodeForFamily`
    only called inside the same file; drop `export`
- **Why it matters:** the two components ship in the bundle
  if tree-shaking misses; stale exports widen reviewer
  surface area.
- **Proposed fix:** delete the two files + the dead
  function, drop `export` on internal-only constants.
- **Risk:** low. **Effort:** XS. **Confidence:** high.

### 5. `api/search.ts:90` — TCGPlayer response is `any`-typed
- **What:** `results.map((item: any): CardData => ...)` —
  third-party HTTP shape unvalidated.
- **Why it matters:** TCGPlayer can rename a field and we
  silently start emitting empty strings.
- **Proposed fix:** zod schema for the result row,
  validate at the boundary, infer `item`. Same logic
  applies to `api/og.ts:325,528-529,657-658` (JSON
  static data — lower priority).
- **Risk:** low. **Effort:** S. **Confidence:** medium.

## Lower-priority debt

- `lib/db.ts:5` — `getDb()` no explicit return type
  (`: Db`). 37 `api/` handlers miss return types; TS
  infers correctly — cosmetic.
- `lib/sessions.ts:664-676` — `(last.payload ?? {}) as
  Record<string, unknown>` + hand-narrowed jsonb access.
  A zod schema for the payload union would replace it.
- `api/me.ts:106,778`, `api/trades.ts:98` — `req.body as
  ...` after typeof-narrow. OK; a `parseBody(req, schema)`
  helper would pay back in ~5 places.
- 61 knip-flagged exported types are mostly module
  public-API (`SessionView`, `EditSessionResult`, etc.) —
  knip is noisy here; no action.
- `import type` discipline is good — inline `type` modifier
  used consistently (`api/trades.ts:21`, `api/bot.ts:31`).
  No types-as-values misuse.

## Anti-recommendations

- **`as unknown as Record<string, AnyPgColumn>` at
  `lib/prefsResolver.ts:46,64`, `api/me.ts:120,167,766,767`,
  `api/bot.ts:1867,1978,1996,2000,2113` is correct.**
  Deliberate dynamic-column escape hatch for the
  prefs-registry; column names are test-validated.
- **Vercel handler `default` exports knip flagged
  (`api/auth.ts`, `me.ts`, `sessions.ts`, `signals.ts`,
  `sync.ts`) are reached via `vercel.json` rewrites.**
  Same for `api/og.ts`, `search.ts`, `_fonts.ts`,
  `middleware.ts`. Not dead.
- **`__resetXCache` exports in hooks are test-only
  escape hatches** for module-singleton caches. Leave.
- **`err: any` in `usePriceData.ts:48`** — `unknown`
  +narrow purer but cosmetic.
- **`as ProductIndex` / `as FamilyIndex` in `api/og.ts`** —
  ESM-imported static JSON generated at build time;
  per-request validation is wasted work.
