# 06 — Lists / inventory / discovery

## High-impact findings

### 1. Server-sync writeback ignores `writingBackRef` for the debounced push
- **What:** The "writeback in progress" guard is set then cleared *synchronously* around `wants.setAll(...)`/`available.setAll(...)`, but those are React state setters that fire the items-changed effect *after* the surrounding async function returns. By the time the debounced push effect re-runs, `writingBackRef.current` is already `false`, so the freshly-pulled server snapshot gets immediately PUT back to the server.
- **Where:** `src/hooks/useServerSync.ts:99-117` (initial), `:151-154` (foreground re-pull), `:180` (debounce gate).
- **Why it matters:** Every visibility-change pull triggers a redundant PUT 500 ms later — N×writes per device per session. Worse, if the user edits between the setAll and the spurious push, the push uses post-pull state but the server's already current → harmless but wasteful. If the order ever inverts (e.g. React schedules differently), local edits could be silently overwritten by the round-tripped server copy.
- **Proposed fix:** Hold `writingBackRef.current = true` until *after* the next tick (e.g. `queueMicrotask(() => writingBackRef.current = false)`) or bump a `serverWriteVersion` ref the debounce effect compares against the version it captured on schedule. Cleaner: have `setAll` return a Promise that resolves post-commit and clear the ref then.
- **Risk:** medium  **Effort:** S  **Confidence:** high — this is the kind of tight race localStorage-backed sync gets wrong every time.

### 2. `api/sync.ts` writes wants/available rows in a sequential `for await` loop
- **What:** The PUT handlers iterate `for (const item of items) { await db.insert(...).onConflictDoUpdate(...) }`. Each upsert is its own round-trip to Neon.
- **Where:** `api/sync.ts:90-108` (wants), `:181-194` (available).
- **Why it matters:** A 200-card binder = 200 sequential SQL round-trips per sync. On a Vercel Fluid function with Neon's ~30-50 ms RTT this is 6-10 s of wall time and burns the function-duration budget. Most syncs are tiny but the worst case is the one that drives the user's perception (initial onboarding, post-OAuth migration).
- **Proposed fix:** Batch via a single `INSERT ... VALUES (...) ON CONFLICT DO UPDATE` with all rows, then run the `notInArray` delete. Drizzle supports multi-value insert with conflict targets. Falls back to chunks of ~500 if payload is huge.
- **Risk:** low  **Effort:** S  **Confidence:** high.

### 3. `restrictionKey` / "sort variants and join" is duplicated in 4 places
- **What:** The pipe-joined-sorted-variants signature is reimplemented inline in `src/components/lists/WantsPanel.tsx:85-87`, `src/components/SignalBuilderView.tsx:19-21`, `src/components/ListCardPicker.tsx:156-159`, plus the canonical `src/hooks/useWants.ts:42-45` and the API mirror `lib/shared.ts:6-9`. Each version slightly drifts (string-vs-VariantRestriction args, null handling).
- **Where:** see above.
- **Why it matters:** This is the recently-fixed restriction-mode bug surface. If anyone changes the encoding (e.g. switches to a hash, adds normalization), 5 sites must change in lockstep. The audit memo specifically called for normalization to be centralized — it's not.
- **Proposed fix:** Re-export the canonical `restrictionKey` (and `normalizeRestriction`) from `lib/shared.ts` and have client + server pull from one place. Delete the inline `restrictionKeyOf` variants.
- **Risk:** low  **Effort:** XS  **Confidence:** high.

### 4. `normalizeRestriction` runs only on read from localStorage, not on server pull
- **What:** `useWants.ts:128-135` normalizes data when hydrating from localStorage, but `useServerSync.ts:100, 115, 152` calls `wants.setAll(serverWants as typeof wants.items)` — bypassing the normalizer. `api/sync.ts:55-68` also doesn't normalize on read.
- **Where:** `src/hooks/useServerSync.ts:100,115,152`; `api/sync.ts:55-68`; `api/user/[handle].ts:19-21`.
- **Why it matters:** A pre-fix client (or any future bug that writes a 10-variant restriction) populates the DB; every fresh device pulling that row down sees an "all variants" restriction that then propagates back on every PUT. The normalization only collapses on a localStorage read path that doesn't fire for signed-in users (server is source of truth, line 56 comment).
- **Proposed fix:** Normalize at the boundary: in `wantsToClientShape` server-side, or in `setAll` client-side. Cheaper and catches DB-resident bad data too.
- **Risk:** low  **Effort:** XS  **Confidence:** high.

### 5. Card-index `useMemo`s rebuild three maps over ~8000 cards in three views independently
- **What:** `WishlistView.tsx:42-54`, `BinderView.tsx:42-48`, `ListsDrawer.tsx:68-82` each iterate `allCards` to build `byFamily` / `byFamilyAll` / `byProductId`. Same data, computed three times whenever `allCards` reference changes.
- **Where:** above + `src/contexts/CardIndexContext.tsx` already exists and is used by `ListView.tsx:79`, `ProfileView.tsx:139`.
- **Why it matters:** Three components recompute identical 8000-element loops on app boot and after every catalog refresh. The CardIndexContext already exposes the canonical maps; these three views just don't consume it.
- **Proposed fix:** Replace local `useMemo` blocks with `useCardIndexContext()`. Drop `allCards` from those views' prop chains.
- **Risk:** low  **Effort:** S  **Confidence:** high.

## Lower-priority debt

- `WishlistView.tsx`/`BinderView.tsx` ShareButton helpers are 99% duplicated chrome (`shareUrl`, `handleCopy`, `imageUrl`) — extract a `useShareableList({wants?, available?, user})` hook (`src/components/WishlistView.tsx:128-201`, `BinderView.tsx:107-177`, `ListsDrawer.tsx:228-393`).
- `useWants.ts:155` and `useAvailable.ts:92` both use `created as unknown as WantsItem` to escape "captured in setState" — a single `useEvent`-style pattern would replace both.
- `ProfileView.tsx:163` casts `synth as any` for `bestMatchForWant`; the synth shape is well-typed two lines up, just drop the cast.
- `CommunityView.tsx:902-906` has a `(guild as { memberCount?: unknown })` cast labelled "sibling P3 work" — outstanding type drift, candidate for cleanup once the schema lands.
- `usePopularWants.ts:41` uses `familyIds.join(',')` as the effect dep with an eslint-disable; functions but is a fragile pattern. Wrap with a stable hash or use the array reference + a memo.
- `WantsPanel.tsx:77-88` and `AvailablePanel.tsx:71-75` build picker `savedEntries` inline on every render — large lists rebuild per keystroke when picker is open.
- `ListView.tsx:118-151`'s `filterRow` is a closure recreated each render and its `useMemo` deps disable exhaustive-deps; safe today, brittle later.
- `CommunityView.tsx:667-678` aggregates `wantFamilyIds` counts across all members on every guild-tab switch even though `guildMembers` is the stable dep.
- `matchmaker.ts:199-217` enumerates 2^16 = 65k subsets twice (offering × receiving = 4B cross product is short-circuited by `<` comparator but is still O(2^32) iteration in worst-case 16-vs-16 pools). Mitigation comment exists; if pools ever drift larger than 16 the cap silently truncates. A meet-in-the-middle sort+binary-search would cut to ~1M.
- `ListsDrawer.tsx:53-58` consumes `requestedTab` via `useEffect` keyed on `open` — opening the drawer twice with the same requested tab leaves stale `tab` between opens (open→close→open lands wherever the user last switched, not where the requester asked).
- Wishlist + Binder + Profile + ListView all render unvirtualized `<ul>` of rows. Realistic limits cap at ~99 items per row (qty), but a power user could have 500+ wants — plain DOM, no virtualization. `ListCardPicker` *is* virtualized via `CardResultsGrid`/`@tanstack/react-virtual`; row lists are not.

## Anti-recommendations

- **Don't merge wants and available into one model.** Wants are family-keyed with variant restrictions (a Showcase-or-Hyperspace want is one row); available are productId-keyed (specific printings only). The asymmetry is the point — `useWants` carries `VariantRestriction`, `useAvailable` doesn't. Several components branch on this (e.g. `ListCardPicker.tsx:57-59`, `ListRows.tsx`'s separate `WantsRow`/`AvailableRow`); flattening into a generic `ListItem<T>` would re-introduce the all-variants-restriction bug class.
- **Don't extract `WantsPanel` + `AvailablePanel` into a generic Panel.** They share scaffolding (`EmptyState`, `AddCardFooter`) but the per-row editing, priority star, and `bestMatchForWant` thumbnail logic only apply to wants; an attempted unification would generate prop sprawl. The current shared-helpers-only split is correct.
- **`isPriority` is intentionally only on wants.** Available items have no priority concept — there's no "ship this card first" semantic on the binder side; matchmaker propagates the want-side priority into the trade pool symmetrically (`matchmaker.ts:101-106`). Don't add it to AvailableItem.
- **Don't move overlap math server-side.** `CommunityView.tsx:139-144` computes overlap client-side over the full members directory. The privacy comment at `api/me.ts:586-594` explains why: pushing math to the server would leak which families a viewer has the moment they open the page; client-side intersection keeps that local. Performance is fine for ~50 members.
- **Drawer + dedicated WishlistView/BinderView coexist on purpose.** Drawer is the in-trade-builder quick-edit sidebar; the dedicated views are full-page. Don't collapse to one — the layout constraints (`max-h-[85dvh]` modal vs `h-[100dvh]` page) genuinely diverge.
