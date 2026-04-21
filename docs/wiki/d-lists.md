# Lists / inventory / matching

> **Owner scope**: the per-user "wants" (wishlist) and "available" (binder) lists, the dedicated views + quick-edit drawer that edit them, the shared-list URL codec, and the matching + aggregation layer that surfaces overlap.
>
> Files covered:
> - `src/components/WishlistView.tsx`, `src/components/BinderView.tsx` — dedicated full-page surfaces (canonical edit destinations)
> - `src/components/lists/WantsPanel.tsx`, `src/components/lists/AvailablePanel.tsx` — shared panel bodies used by the views + the drawer
> - `src/components/ListsDrawer.tsx`, `src/components/ListRows.tsx`, `src/components/ListCardPicker.tsx`, `src/components/ListView.tsx`, `src/components/MigrationDialog.tsx`
> - `src/hooks/useWants.ts`, `src/hooks/useAvailable.ts`, `src/hooks/useSharedLists.ts`, `src/hooks/usePopularWants.ts`, `src/hooks/useServerSync.ts`, `src/hooks/useRecipientProfile.ts`, `src/hooks/useCommunityCards.ts`, `src/hooks/usePersistedState.ts`
> - `src/hooks/useSelectionFilters.ts`, `src/applySelectionFilters.ts`, `src/listMatching.ts`
> - `src/persistence/index.ts`, `src/persistence/schemas.ts`
> - `src/urlCodec.ts` (the list-sharing half; trade-side codec is covered by `c-trade-builder.md`)
> - Tests: `src/listMatching.test.ts`, `src/applySelectionFilters.test.ts`, `src/hooks/useSelectionFilters.test.ts`, `src/hooks/useWants.test.ts`, `src/hooks/useAvailable.test.ts`, `src/persistence/migration.test.ts`, `src/persistence/schemas.test.ts`, `e2e/drawer.spec.ts`, `e2e/shared-list.spec.ts`, `e2e/recipient.spec.ts`, `e2e/curate-and-share.spec.ts`, `e2e/migration.auth.spec.ts`, `e2e/sync.auth.spec.ts`
> - API counterparts: `api/sync.ts` (wants + available), `api/popular-wants.ts`, `api/user/[handle].ts` (read side), `api/me.ts` (community rollup)

## Overview

SWUTrade users maintain two personal card lists: **wants** (cards they're looking to acquire) and **available** (cards they have on hand to trade). These lists are the raw material for every match-adjacent feature in the app — overlap chips in the trade-builder picker, the matchmaker's subset-sum composer, "N others want this" badges, and the `/?w=…&a=…` link-sharing flow. The subsystem is a thin, mostly-client-side wrapper over two Zod-validated localStorage shapes that mirror to the server when the user signs in, plus a catalog of derived reads that the rest of the app pulls from: `bestMatchForWant`, `usePopularWants`, `useRecipientProfile`, `useCommunityCards`.

The one-sentence version: **wants are cross-printing wishes keyed by `familyId`; available is a binder keyed by exact `productId`; everything else is derived.**

## Key concepts / glossary

- **`familyId`** — a cross-printing card identifier, shape `{setSlug}::{kebab-case base name}` (see `src/variants.ts:239`). Every printing of a card (Standard, Hyperspace, Showcase, Foil, Serialized, …) collapses to one family, so a Want says "I'll take any variant of Luke Skywalker - Hero of Yavin (JTL)" without the user having to enumerate printings. Contrast with `productId`, TCGPlayer's per-printing id.
- **`productId`** — TCGPlayer's exact-printing identifier. Every `AvailableItem` pins to one because "I have" needs to be precise about which art you're offering (Standard vs Hyperspace have different market prices).
- **`VariantRestriction`** — discriminated union on `WantsItem`: either `{ mode: 'any' }` (default; matches every printing) or `{ mode: 'restricted', variants: [...] }` (only these canonical variants). Defined in `src/persistence/schemas.ts:16`.
- **`restrictionKey(r)`** — stable string signature for a restriction (`src/hooks/useWants.ts:42`). Variant order doesn't matter: `['Hyperspace','Showcase']` and `['Showcase','Hyperspace']` hash equal. Shared with the server via `lib/shared.ts` so sync rows keep the same dedup semantics.
- **`normalizeRestriction(r)`** — read-time collapse of "restricted to every canonical variant" back to `{ mode: 'any' }` (`src/hooks/useWants.ts:19`). Fixes a corruption class; see Tech Debt.
- **`isPriority`** — boolean star on `WantsItem`. Sorts to top of drawer + Home Wishlist module; flows into the matchmaker's ranking.
- **Positive selection filters** — variant/set chips use "empty array = allow all" semantics (`src/applySelectionFilters.ts`). Narrowing is opt-in.
- **Group presets** — `group:main` and `group:special` pseudo-slugs match whole set categories in one tap (`src/applySelectionFilters.ts:5-10`). Mutually exclusive with individual set chips.
- **`bestMatchForWant`** — given a `WantsItem` and a pool of `CardVariant` candidates, returns the cheapest one that satisfies the restriction (`src/listMatching.ts:18`). Used everywhere a want has to resolve to a concrete card — drawer thumbnails, overlap chips, propose auto-fill, shared-list rendering.
- **Shared list** — a `/?w=…&a=…` URL that encodes the sender's wants + available in a compressed form. Lands on `ListView`; can be "converted" into a trade with one tap.
- **Popular wants** — count of other users whose public wants include a given family (`/api/popular-wants`). Surfaced as a "N wants this" badge on available rows.
- **Community rollup** — aggregate of every enrolled-guild-member's public wants/available, scoped to mutually-enrolled guilds (`/api/me/community`). Powers a "Community" source chip in the trade-side picker.
- **Migration prompt** — first-sign-in dialog (`MigrationDialog`) offering to push localStorage lists into the user's newly-minted server profile.

## File map

### Frontend — dedicated views + shared panels

**`src/components/WishlistView.tsx`** — dedicated full-page surface for wants, mounted at `?view=wishlist`. Reached from Home's Wishlist module ("Edit wishlist →"), the NavMenu's "My Wishlist" entry, and direct URL. Renders AppHeader + breadcrumb ("Home › Wishlist") + header strip with count/priority summary + share buttons + `<WantsPanel>` as the editing body. Canonical edit destination for the wants list since the 2026-04-21 split.

**`src/components/BinderView.tsx`** — symmetric view for available cards at `?view=binder`. Same chrome as WishlistView; renders `<AvailablePanel>` as the body. Share buttons encode only `?a=` (not `?w=`) so binder shares are scoped to just the binder content.

**`src/components/lists/WantsPanel.tsx`** — shared list+picker body for wants. Owns its own `mode` (`list` / `picker`) and `editingWantId` state so both callers (drawer + WishlistView) can render it without coordinating. Priority-first sort mirrors Home's WishlistModule so "top of the list" is consistent across every surface. Accepts an `emptyState` override so the drawer's "No wants yet" message and the dedicated view's "Your wishlist is empty" message stay distinct.

**`src/components/lists/AvailablePanel.tsx`** — shared list+picker body for available. Calls `usePopularWants` internally to drive the "N others want this" badge (signed-in only). Accepts the same `emptyState` override.

### Frontend — drawer + rows + picker

**`src/components/ListsDrawer.tsx`** — Radix Dialog + Tabs drawer. Mounts once at App root (via `DrawerContext`); opens only from the trade-builder action strip's "Lists" button now. Home and NavMenu route to the dedicated Wishlist / Binder views instead. Still renders the Share button that encodes BOTH lists (combined `?w=`+`?a=` link), which the dedicated views' per-list share buttons can't replicate. Body content delegates to `<WantsPanel>` / `<AvailablePanel>`.

**`src/components/ListRows.tsx`** — `WantsRow` and `AvailableRow`. Wants rows show the restriction as a toggle-button label ("Any variant" / "Only Hyperspace" / "Hyperspace or Showcase" / "3 variants") that expands into a `RestrictionEditor` chip group. Available rows show the exact variant badge, price, and the "N wants this" popular-wants badge (signed-in only).

**`src/components/ListCardPicker.tsx`** — embedded search surface used inside the drawer. Persists its own filter state under `picker.*` keys so it doesn't pollute the trade-view filters. For Wants, collapses each family to a single tile (whose rep depends on the active variant filter); for Available, shows every variant as its own tile because `productId`s are exact. Tiles carry a saved-qty badge + decrement button for tap-to-adjust.

**`src/components/ListView.tsx`** — standalone shared-list landing page (`?view=list&w=…&a=…`). Compact row layout with search + variant + set filters. Renders wants first (blue) and available second (emerald), with a prominent "Start a trade" CTA that flips the app into trade mode and pre-opens the Offering overlay scoped to the sender's wants.

**`src/components/MigrationDialog.tsx`** — first-sign-in "Import your lists?" dialog. Renders when `useServerSync` emits a `migrationPrompt`, which happens exactly when (a) local items exist, (b) the server is empty for this user, (c) this is the first sign-in in the session.

### Frontend — hooks + state

**`src/hooks/useWants.ts`** — CRUD for `WantsItem[]`. Persists to `swu.wants.v2` on every write. Dedup is keyed by `(familyId, restrictionKey)` — the same card with different restrictions creates two rows; the same card with the same restriction bumps qty. Normalizes on read (see `normalizeRestriction`) and rewrites storage if a normalization changed anything. Exposes `togglePriority` and `setAll` (used by server sync).

**`src/hooks/useAvailable.ts`** — symmetric to `useWants` but keyed by `productId`. No restrictions, no priority. Persists to `swu.available.v1`.

**`src/hooks/useSharedLists.ts`** — decodes `?w=`/`?a=` on mount, re-parses on `popstate`. Returns `null` when neither param is present (the normal unencoded landing).

**`src/hooks/usePopularWants.ts`** — debounced fetch against `/api/popular-wants`. Sorts the familyId input so identical sets in different orders don't refetch. Cancels stale responses.

**`src/hooks/useServerSync.ts`** — the sync loop. Initial pull on sign-in, debounced push on mutation (500ms), migration-prompt fork on first sign-in with local items and empty server. Internal `writingBackRef` prevents the server-pushed writeback from re-triggering a sync round-trip.

**`src/hooks/useRecipientProfile.ts`** — fetches `/api/user/<handle>` for the propose flow. Dedupes fetches using a ref so the parent component can re-render freely without restarting the request.

**`src/hooks/useCommunityCards.ts`** — fetches `/api/me/community`. Returns `{ wantFamilyIds, availableProductIds, status }`; gated on being signed in.

**`src/hooks/useSelectionFilters.ts`** — per-surface variant + set chip state with positive-selection semantics. Each surface (trade view, picker, etc.) passes its own storage keys so filters don't bleed between them. Exports pure reducers so `ListView` (which keeps filters ephemeral) can reuse the same mutual-exclusion rules as the persisted hook.

**`src/hooks/usePersistedState.ts`** — thin `useState` wrapper that mirrors to localStorage under a Zod schema. Used by several surfaces whose state needs to survive reloads (percentage slider, price mode, trade view mode).

### Frontend — matching + filters (pure)

**`src/listMatching.ts`** — `matchesRestriction(card, restriction)` and `bestMatchForWant(want, candidates, priceMode)`. Pure; no React, no storage. The matcher respects price mode (market vs low) and treats null prices as `Infinity` so an unpriced serialized card doesn't steal the "cheapest" slot.

**`src/applySelectionFilters.ts`** — applies variant + set filters to `SetSearchGroup[]` results. Prunes empty groups/set-groups so the UI doesn't render empty sections. Exports `MAIN_GROUP` / `SPECIAL_GROUP` pseudo-slugs used as the set-category presets.

### Persistence

**`src/persistence/index.ts`** — `readPersisted` / `writePersisted` / `clearPersisted`. SSR-safe (guards on `typeof window`), handles the JSON-parse-or-fallback-to-raw-string quirk for legacy primitive keys. Always best-effort — a localStorage-full or private-mode-Safari error never propagates.

**`src/persistence/schemas.ts`** — Zod schemas for `WantsItem`, `AvailableItem`, `VariantRestriction`. `PERSIST_KEYS` enumerates every storage key the client uses, with versioning suffixes (`wants.v2` — see data model note on why v1 is not migrated).

### Server

**`api/sync.ts`** — consolidated dispatcher for `/api/sync/wants` + `/api/sync/available`. GET returns the user's rows as client-shape payloads; PUT upserts the provided array, then deletes any server rows NOT in the payload (last-write-wins).

**`api/popular-wants.ts`** — POST `{ familyIds }`, returns `{ counts: { familyId: userCount } }`. Excludes the viewer's own wants. Anonymous callers get counts too (wants are public data); the exclusion is only active when a session is present.

**`api/user/[handle].ts`** — public profile fetch. Returns `wants: null` and `available: null` when the user has toggled their respective publicness off; the propose flow falls back gracefully.

**`api/me.ts` (`handleCommunity`)** — the community rollup endpoint. Gates on mutual-enrolled + rollup-on guild membership.

## Data model

### `WantsItem` (`src/persistence/schemas.ts:24`)

```
{
  id: string                    // UUID, stable across renames (we never rename — full replace)
  familyId: string              // `{setSlug}::{kebab base name}`, see src/variants.ts:239
  qty: 1..99
  restriction: VariantRestriction
  maxUnitPrice?: number         // optional budget ceiling per unit (UI not fully wired yet)
  note?: string (≤500)
  isPriority?: boolean
  addedAt: number (epoch ms)
}
```

**Invariants:**
- `qty` is clamped at every write path (hook, reducer, server row builder in `api/sync.ts:41`). A corrupted localStorage entry with `qty: 999` will fail Zod parse and fall back to `[]` — harsh but safe.
- `(familyId, restrictionKey)` is the dedup key. `useWants.add()` bumps `qty` on collision; this is **the** reason `restrictionKey` needs to be order-insensitive (see `src/hooks/useWants.ts:42` and its test at `src/hooks/useWants.test.ts:31`). The server mirrors the key as a column (`wantsItems.restrictionKey`) for the same reason.

### `AvailableItem` (`src/persistence/schemas.ts:42`)

```
{
  id: string
  productId: string             // TCGPlayer exact-printing id
  qty: 1..99
  note?: string (≤500)
  addedAt: number
}
```

Dedup is by `productId` alone. No restriction, no priority — a binder entry is just "I physically have N copies of this exact card."

### `VariantRestriction` (`src/persistence/schemas.ts:16`)

```
  { mode: 'any' }
| { mode: 'restricted', variants: CanonicalVariant[] }   // variants.length >= 1
```

Schema rejects `{ mode: 'restricted', variants: [] }` so we never have to ask "does empty-restricted mean any or nothing?" at read sites — it's impossible by construction. The editor in `ListRows.tsx:166` enforces this at write time too (tapping the last active chip is a no-op).

The `CanonicalVariant` enum has grown over time (original 8 → now 10, including Gold and Rose-Gold). `normalizeRestriction` handles both widths; see Tech Debt.

### Storage keys (`src/persistence/schemas.ts:56`)

- `swu.wants.v2` — wants list. v2 suffix because v1 was keyed by `baseCardId` (per-printing, swuapi-derived); v1 data is NOT migrated. A user with v1 data loads `[]` and starts fresh — the breakage was deliberate, shipped when the app was small enough that forcing a re-curate was cheaper than a migrator.
- `swu.available.v1` — available list.
- `swu.trade.selVariants` / `swu.trade.selSets` — trade-view filters.
- `swu.picker.selVariants` / `swu.picker.selSets` — list-picker filters. **Separate keys on purpose**: a Hyperspace-only picker filter should not also narrow trade search. This bite was caught during Phase-2 QA and baked into `PERSIST_KEYS` with the comment `src/persistence/schemas.ts:60-65` explaining it.
- Primitive scalars (`swu.pct`, `swu.pm`, `swu.tradeView`) — read via `readPersisted` with a Zod schema and a default, handled by `usePersistedState`.

### Server schema

Mirror tables in `lib/schema.ts` (not owned by this doc — see `j-infra.md` for migrations). The server stores `restrictionMode` + `restrictionVariants` as separate columns instead of a JSONB blob, plus `restrictionKey` (computed by `lib/shared.ts`'s re-export of `restrictionKey`) for fast dedup. `api/sync.ts:43-46` builds the row shape.

### Shared-list URL grammar (`src/urlCodec.ts:143`)

```
?w=<want>[,<want>...]   each: `<encoded_familyId>.<qty>[.r<hex>][.p]`
?a=<avail>[,<avail>...] each: `<productId>.<qty>`
```

- The familyId is URL-encoded (colons and slugs safely).
- `r<hex>` is a bitmask over `CANONICAL_VARIANTS` (`Standard=bit0`, up through `Showcase` / newer variants). Omitted when `mode === 'any'`.
- `.p` marks `isPriority`.
- `qty` is clamped to `[1, 99]`; malformed entries are silently dropped so a partly-broken URL still loads what it can.

Both `w` and `a` are compressed via deflate + base64url with a `~` prefix (`src/urlCodec.ts:13`). A 20-card list drops from ~1200 chars to ~400. The prefix lets the decoder tell compressed payloads apart from legacy uncompressed ones (familyIds always start with a letter; the prefix is `~`, so there's no collision).

## Public surface

### Exports from `src/listMatching.ts`

- `matchesRestriction(card, restriction) → boolean` — predicate, pure.
- `bestMatchForWant(want, candidates, priceMode) → CardVariant | null` — cheapest matching variant; null when nothing matches. Treats null prices as worse than any real price (`src/listMatching.ts:29`). Called from: `ListsDrawer.tsx:236` (wants row thumbnail), `ListView.tsx:91` (shared-list resolution), `TradeSide.tsx` (overlap chip + propose auto-fill — covered by `c-trade-builder.md`).

### Exports from `src/hooks/useWants.ts`

- `useWants() → WantsApi` — primary hook; owns the wants list.
- `wantsAddReducer(items, input, deps) → { items, created }` — pure reducer extracted so the dedup invariant can be unit-tested.
- `restrictionKey(r) → string` — order-insensitive stable signature for dedup. Re-exported server-side via `lib/shared.ts`.
- `normalizeRestriction(r) → VariantRestriction` — collapses all-variant restrictions back to `{ mode: 'any' }` on read.

### Exports from `src/hooks/useAvailable.ts`

- `useAvailable() → AvailableApi`.
- `availableAddReducer(items, input, deps) → { items, created }` — pure reducer.

### Exports from `src/urlCodec.ts` (list half)

- `encodeWants(items)` / `decodeWants(param)` — with compression.
- `encodeAvailable(items)` / `decodeAvailable(param)`.
- `variantsToMask(variants)` / `maskToVariants(mask)` — bit helpers for the restriction field.

### Endpoints

- `GET /api/sync/wants` — auth required. Returns `WantsItemPayload[]` for the caller.
- `PUT /api/sync/wants` — auth required. Body is `WantsItemPayload[]`; upserts each, then deletes any server rows NOT in the array. This is the "full replace" contract that makes client → server sync idempotent — if the client state is truth, one PUT makes the server match.
- `GET /api/sync/available` / `PUT /api/sync/available` — symmetric.
- `POST /api/popular-wants` — body `{ familyIds: string[] }`. Returns `{ counts: { familyId: userCount } }`. Anonymous-safe. Short cache (`s-maxage=30, swr=120`) because counts change as users edit, but not second-by-second.
- `GET /api/user/<handle>` — public profile. `wants` is `null` when the user's `wantsPublic` flag is off; `available` is `null` when `availablePublic` is off. Cached `public, s-maxage=60, swr=300`.
- `GET /api/me/community` — auth required. Returns `{ wantFamilyIds, availableProductIds }` for mutually-enrolled guild members who've opted into rollups.

Note: `/api/sync/{wants,available}` and `/api/me/community` are served by consolidated dispatchers (`api/sync.ts`, `api/me.ts`) routed via `vercel.json` rewrites — see `j-infra.md` for the serverless function-count ceiling that drove consolidation.

### Hooks

- `useWants()` / `useAvailable()` — CRUD + persistence. Mutations are synchronous (`useState` set + `writePersisted` in one tick). `setAll` is the server-sync writeback path.
- `useServerSync(wants, available, user)` — attaches sync behavior. Returns `{ status, migrationPrompt }` — status is `idle | syncing | error | offline`.
- `useSharedLists()` — decoded `?w=`/`?a=` or `null`.
- `usePopularWants(familyIds)` — `Record<familyId, count>`; `{}` while loading or when input is empty.
- `useRecipientProfile(handle)` — `{ profile, fetchState }`; the propose bar + trade-side picker share this so they don't each fetch.
- `useCommunityCards(isSignedIn)` — `{ wantFamilyIds, availableProductIds, status }`.
- `useSelectionFilters({ variants, sets })` — persisted variant/set chips; pass storage keys to scope.
- `usePersistedState(key, schema, initial)` — generic localStorage-backed state.

### Components

- `<ListsDrawer wants available allCards percentage priceMode open onOpenChange />` — rendered once at App root.
- `<ListCardPicker listType allCards percentage priceMode wants? available? onPick onClose />` — embedded inside the drawer when `mode === 'picker'`.
- `<WantsRow item sampleCard familyCandidates isEditing onChangeQty onTogglePriority onRemove onToggleEdit onChangeRestriction />` — single wants row with inline `RestrictionEditor`.
- `<AvailableRow item card percentage priceMode wantCount? onChangeQty onRemove />`.
- `<ListView sharedLists senderHandle percentage priceMode onStartTrade />` — shared-link landing page.
- `<MigrationDialog prompt />` — conditional on `useServerSync`'s `migrationPrompt`.

## State + data flow

### Happy path: anonymous user adds a want

1. User opens Home, taps "Edit wishlist" → `openLists('wants')` sets `requestedTab='wants'` + `listsDrawerOpen=true`.
2. `ListsDrawer` mounts, its `useEffect` consumes `requestedTab` (`ListsDrawer.tsx:58-63`) and clears it so a later unparameterized `openLists()` doesn't stick on Wants.
3. User hits "Add Card" → `mode='picker'`. `ListCardPicker` mounts; its filters + query drive `useCardSearch`.
4. User picks the Hyperspace variant filter, types "luke", taps the Luke tile.
5. `onPick(card, { acceptedVariants: ['Hyperspace'] })` fires → drawer's callback builds `{ familyId: cardFamilyId(card), qty: 1, restriction: { mode: 'restricted', variants: ['Hyperspace'] } }` and calls `wants.add(input)`.
6. `wantsAddReducer` checks for an existing `(familyId, restrictionKey)` match. None found — it appends a fresh row and `writePersisted`s the whole list to `swu.wants.v2`.
7. Drawer re-renders. `WantsRow` reads `byFamilyAll.get(familyId)` and calls `bestMatchForWant` to resolve the thumbnail to the Hyperspace rep (restriction-aware).

### Happy path: signed-in user edits, sync mirrors to server

1. Same as above up through `wants.add(…)`.
2. `useServerSync`'s debounced effect (`useServerSync.ts:162`) sees `wants.items` change. Bumps `syncVersionRef`, schedules a push 500ms later.
3. If another mutation lands inside the window, the earlier schedule is cancelled (`clearTimeout`), new one starts. Only the most recent state gets pushed.
4. At T+500ms, `pushWants(items)` + `pushAvailable(items)` fire in parallel. Server UPSERTs each row and deletes any user rows not in the payload (full-replace semantics).
5. Status flips `syncing → idle` on success, `syncing → error` on failure.

The `writingBackRef` gate is crucial: when the initial pull applies server state via `wants.setAll` / `available.setAll`, that mutation would otherwise retrigger the debounced push effect and cause an infinite write loop. The ref suppresses the effect during writeback.

### First sign-in migration (`useServerSync.ts:107-159`)

1. User signs in with local items present. `prevUserRef` was `null` last render.
2. Sync kicks off. In parallel, pull `/api/sync/wants` + `/api/sync/available`.
3. Branch:
   - **Server has data** → pull wins; server rows overwrite local via `setAll`. Prior local items are effectively lost (LWW by design; returning-user-new-device is the common case here).
   - **Server empty + local empty** → no-op; user has nothing to migrate.
   - **Server empty + local has items** → emit `migrationPrompt`. Sync parks in `idle`; no writes happen until the user picks Import or Start Fresh.
4. `MigrationDialog` renders. On Import, `doImport` pushes local → server, then pulls back to normalize shape. On Start Fresh, `doSkip` just pulls (which zeroes out local — the in-memory arrays get replaced with `[]` via `setAll`, and `setAll` persists).
5. `initialSyncDoneRef` flips true; debounced mutation sync unblocks.

### Shared-list landing

1. User pastes `https://…/?w=<compressed>&a=<compressed>&from=alice`.
2. App boots; `useSharedLists` decodes both params. `App.tsx` notices the decoded lists + no trade params and routes to `ListView` (`routing/config.ts`).
3. `ListView` resolves each want via `bestMatchForWant(synthItem, byFamilyAll.get(familyId) ?? [], priceMode)` — the synth item has placeholder `id`/`addedAt` since the decoded entries only carry the trade-relevant subset (`ListView.tsx:85-102`).
4. User taps "Start a trade" → `onStartTrade('alice')` flips view mode + passes the decoded lists through to the trade-builder as `sharedLists` source chips. See `c-trade-builder.md` for how source chips consume this.

### Popular-wants badge on an available row

1. `ListsDrawer` computes `availableFamilyIds` from `available.items` (`ListsDrawer.tsx:109-117`). Only populated when signed in — anonymous users don't see the badge.
2. `usePopularWants(availableFamilyIds)` normalizes + sorts the input, debounces 300ms, POSTs to `/api/popular-wants`.
3. Server excludes the viewer, groups by familyId, returns `{ counts }`.
4. `AvailableRow` looks up `wantCounts[familyId]` and renders the badge when `> 0`.

## UI/UX patterns

### Color reservation

The lists subsystem reuses the app-wide color assignment (see SWU design invariants memory):
- **Wants → blue** (mirrors Receiving, "I want this coming to me")
- **Available → emerald** (mirrors Offering, "I have this to give")
- **Gold** — drawer chrome (title, Share button, priority star when active), also the "Any" pill in the picker to signal "cross-variant save"
- **Crimson** — destructive hover states (Remove, dec-to-zero)

These aren't cosmetic. They line up with the trade panels so a user who's drilled the Offering/Receiving split in trade-builder knows instinctively that wants→blue means "things I want to receive" and available→emerald means "things I'm offering." Consistency across the split Home modules and the in-trade picker source chips reinforces this further.

### Drawer modes

The drawer is a Radix Dialog with two modes driven by `[mode, setMode]` state (`ListsDrawer.tsx:49`):

- **`list` mode** — default. Renders the wants or available list rows, with a sticky "Add Card" footer. On mobile, a bottom sheet (`max-h-[85dvh] rounded-t-2xl`); on desktop a centered modal.
- **`picker` mode** — embedded `ListCardPicker`. On mobile, expands to full viewport (`100dvh`, no rounding) so search results have breathing room. On desktop stays inside the existing modal bounds.

Esc behavior is custom-handled (`ListsDrawer.tsx:138-145`): in picker mode, Esc only closes the picker; a second Esc dismisses the drawer itself.

### Priority stars

Tapping the star toggles `isPriority`. Sort order in the drawer is priority-first then by `addedAt` ascending (insertion order) — see `ListsDrawer.tsx:95-102`. Same sort applies in the Home Wishlist module. The star uses `var(--color-gold-bright)` — explicitly the "special moments" variant per the palette memo — because priority IS a deliberate user signal worth elevating.

Matchmaker ranks: priority wants weight higher when the subset-sum composer picks what to offer/request. See `c-trade-builder.md`'s matchmaker section for the scoring details; the important fact for this area is that `isPriority` is a first-class column on wants (both client and server) and flows through `WantEntry.isPriority` into `src/utils/matchmaker.ts` ranking.

### Restriction editor

The segmented toggle + variant chip group (`ListRows.tsx:144`) has a few intentional edges:

- Switching Any → Specific defaults to `['Standard']` (narrowest sensible starting point, `ListRows.tsx:161`). User widens by tapping additional chips.
- Tapping the last active chip in Specific mode is a no-op (`ListRows.tsx:175`) — schema requires min 1, so we can't drop below. Flipping back to Any requires the header toggle.
- Chips are filtered to variants that actually exist for this family (`ListRows.tsx:220-223`). A Pyke Sentinel has no Prestige printing, so we don't offer one. A variant already locked in the saved restriction stays visible even if missing from the dataset, so the user can deselect stale state after a dataset update.

### Picker badges

Picker tiles carry a badge showing what a tap WILL save (`ListCardPicker.tsx:84-106`):

- **Available** — single pill with the tile's exact variant (because `productId` is exact).
- **Wants with 0-variant filter** — gold "Any" pill (not the variant label — because tapping saves cross-variant).
- **Wants with 1-variant filter** — single pill with that variant in its canonical color.
- **Wants with 2+ variant filters** — one pill per variant in order, each in its variant color. Multi-variant is scannable — you can see every printing the restriction will accept.

Saved tiles also carry a gold "×N" counter and a decrement button (`ListCardPicker.tsx:240-257`). Decrement finds the newest matching item (pops the last id) — for available this is just the productId match; for wants it's scoped to `(familyId + active-filter-restriction-key)` so a Hyperspace-filtered decrement doesn't nuke the Any-variant row.

### Shared-list landing UX

`ListView` deliberately renders a compact row layout, NOT a card grid, because the recipient is scanning for matches. Rows get:
- Small thumb (32×44) — enough to recognize the art, not enough to dominate.
- Set code pill + variant badge (or multi-variant restriction label when a want accepts multiple).
- Priority star when `isPriority` is set.
- Qty on the right; price when known.

Signed-out landings use the slim header variant (`ListView.tsx:204-208`) so sign-up chrome doesn't crowd the recipient before they've seen what they came for. Signed-in viewers get the full nav because they're likely a returning user checking a trade partner's list.

## Tech debt + known gaps

- **`normalizeRestriction` fix (`src/hooks/useWants.ts:19`)** — background: before this function existed, users could end up with `{ mode: 'restricted', variants: [<every canonical variant>] }` — effectively "any" but flagged restricted. Symptom: `matchesRestriction` computed correctly (every variant passed) but the UI label said "10 variants" instead of "Any variant," and the matchmaker/overlap code sometimes used the array length heuristically and got confused. Fix collapses on read; a side-effect write re-persists the cleaned shape (`src/hooks/useWants.ts:129-135`). Two width cases handled: current 10 canonical variants, and the original 8 (pre Gold + Rose-Gold). See Resolved Bugs memory (`project_swutrade_bugs`) — this is the one cited there.

- **v1 wants are not migrated (`src/persistence/schemas.ts:68`)** — `swu.wants.v1` keyed by `baseCardId` (per-printing) is silently abandoned. A user who had a v1 list before the v2 cut gets an empty list on upgrade. Was acceptable at the time (small user base); would now require a migrator. The `schemas.test.ts:6-12` test pins the behavior: v1-shaped data explicitly fails to parse.

- **`useServerSync` uses an 'auth-expired' string sentinel (`useServerSync.ts:21-33`)** — it unwraps the typed `apiGet`/`apiPut` result and re-throws via an `Error` whose message is inspected at the catch site. Comment in-file acknowledges this should be a typed discriminated-union flow once Phase 4 lands a context-layer auth lifecycle. For now it works but is brittle to `apiClient` renaming its reason codes.

- **Server sync debounce is hardcoded at 500ms (`useServerSync.ts:181`)** — no env override, no user-tunable. Fine for desktop, occasionally tight on flaky mobile networks.

- **Sync error state is sticky (`useServerSync.ts:155`)** — once `status === 'error'` from a 401, the only recovery is a page reload. There's no retry button in the UI and no polling recovery; a user whose session expired has to manually hit refresh. The `offline` status has the same stickiness. Phase 4 would add a small toast/banner with a retry.

- **No cross-device sync broadcast** — a user editing their lists on desktop doesn't see the change on mobile until a page reload on the mobile side (the initial pull runs on sign-in, not on focus). Acceptable given the single-device trading loop most users run, but surprising if you're on both devices at once.

- **`sharedLists` parse has no popstate-driven update in practice (`useSharedLists.ts:40-45`)** — the listener is defensive; in-app navigation doesn't normally push new `w`/`a` URLs, the share flow is reload-mounted. The listener exists for parity with `useTradeIntent`, not because of a current consumer.

- **`popular-wants` is computed per-request (`api/popular-wants.ts:47-55`)** — a single grouped SQL scan over `wantsItems ⋈ users`. Cache is edge-level (`s-maxage=30, swr=120`) via response header; no DB-side materialized view. Works fine at current scale; at 10× the current wants table we'd likely want a periodic rollup.

- **Community rollup is recomputed per-request too (`api/me.ts:491-557`)** — three queries: viewer's enrolled guilds, mutual users, distinct families/products. Per-user caching via `private, no-store` (explicitly — the consent model makes this user-scoped). Hot path for the trade-side picker's source chip; would benefit from materialization.

- **`useRecipientProfile`'s ref-dedupe pattern (`useRecipientProfile.ts:30`)** — a comment in-file flags this as a workaround for the "state-in-deps effect trap" called out in `PHASE4_TESTING.md`. Works; not idiomatic. A proper rewrite would use SWR/React Query but we're not pulling in a data-fetching library for three hooks.

- **`maxUnitPrice` on wants is schema-defined but not wired end-to-end (`src/persistence/schemas.ts:35`)** — the restriction editor doesn't expose it; matchmaker doesn't read it. Reserved for a future "budget cap" feature. Noted here so a future author doesn't discover it by accident and assume it's a bug.

- **No server-side validation of the `notInArray` delete batch size (`api/sync.ts:110-119`)** — a malicious or very large client PUT could send thousands of ids, making Postgres do a big `NOT IN` scan. In practice client lists cap well under 100; worth a soft cap if abuse shows up.

- **Drawer tab hint is single-consumer (`DrawerContext.tsx:37-44`)** — `requestedTab` is a ref-like one-shot. If two `openLists('wants')` calls land before the drawer mounts and consumes one, the second wins — currently fine because callers are user-driven taps, not programmatic. Documenting so a future programmatic caller doesn't assume queue semantics.

## Decisions worth remembering

- **Wants key by `familyId`, available by `productId`** — the core data-model asymmetry. The question that drove it: "if I want a Luke Skywalker (JTL), does a seller offering the Hyperspace printing count?" Answer: yes by default, no if the user restricts. That makes wants cross-printing and available per-printing. Encoding both the same way would either force users to enumerate printings on their wishlist (annoying) or force available to drop precision (wrong — market prices differ between printings).

- **Restriction = discriminated union, not a nullable array** — alternatives considered: `variants: string[] | null`. The union is more explicit: reading code branches on `mode`, not on nullability; `VariantRestrictionSchema` rejects empty-restricted at parse time so downstream code never has to handle the "does empty mean any?" ambiguity.

- **Positive-selection filters** — alternatives considered: "exclude this variant" semantics. Positive selection (empty = allow all, non-empty = only these) matches user intuition on SWU-specific filters ("show me Hyperspace cards" is what people say, not "exclude non-Hyperspace"). Also makes the empty state trivially a no-op and drops a whole class of "double-negative when zero filters selected" bugs.

- **Per-surface filter keys** — `picker.*` vs `trade.*` persist independently. Trade-off: duplicated state; benefit: a Hyperspace picker filter set while curating a list doesn't hijack trade search when the user closes the drawer and returns to building a trade.

- **Full-replace sync semantics on PUT** — server deletes rows not in the payload (`api/sync.ts:110-119`). Alternative: per-row PATCH + explicit DELETE. Full-replace is simpler, idempotent, and matches the mental model "local is truth; make the server look like local." Cost: a large list gets re-upserted each sync, but list sizes are small and the upsert is id-keyed so it's cheap.

- **LWW in favor of server on returning-user-new-device** — when the server has data and local has data, pull wins. The alternative (merge) is fraught — you'd need three-way diff with a base. LWW server-wins preserves the invariant "your signed-in lists are consistent across devices" at the cost of losing local edits made before an import on a second device. Migration prompt covers the one narrow case where losing local would hurt (first sign-in with genuine local curation and empty server).

- **Compressed share URLs with a sentinel prefix (`~`)** — alternatives considered: always uncompressed, or always compressed. Always-compressed breaks legacy share links in the wild; always-uncompressed blows past the ~2000-char URL ceiling for 30+ card lists. The `~` prefix lets both formats coexist indefinitely without version bumps.

- **URL encoding via bitmask, not a variant-slug list** — a 2-char hex field replaces what would otherwise be a comma-separated slug list. A 10-variant restriction is 1-3 hex chars instead of 60+ chars of slugs. Tolerates future variant additions up to 32 total (and we have 10 today).

- **Popular-wants exclude-viewer is unconditional when signed in (`api/popular-wants.ts:45`)** — even if the viewer is public, we never count them toward their own "N others want this" number. Subtle but important: without the exclusion, a user's first-day experience is "1 person wants this card I have" and the 1 is themselves; the badge becomes noise.

- **Inventory-as-first-class (UX-A1)** — pre-UX-A1, the wants + available lists lived inside a drawer with a header button. Promoted to first-class Home modules because "these are my cards" is load-bearing for the trade loop, not a sidebar affordance. The drawer still exists as an in-trade quick-edit surface but it's no longer the primary entry point. See the comment at `HomeView.tsx:123-126` and cross-link to `e-home-nav.md`.

- **Wishlist / Binder split (2026-04-21)** — Follow-on to UX-A1. The drawer's shared-tab model lied about the relationship between wants (hunting) and available (holding): different mental models, different data shapes (wants has priority + restriction; available has neither), but forced to share UI. Split into two dedicated views (`WishlistView` / `BinderView`) at `?view=wishlist` / `?view=binder` with reconciled vocabulary (user-facing copy = Wishlist / Binder; schema names = wants / available stay internal). NavMenu's "My Lists" entry replaced with "My Wishlist" + "My Binder" rows routing to the views; Home's Wishlist + Binder modules route to the views; drawer retained as trade-builder-local quick-edit via a new "Lists" button in the action strip. Panel bodies (`WantsPanel` / `AvailablePanel`) are shared between drawer and views so both stay in sync for parity-level changes but can accept per-caller overrides (e.g. distinct empty-state copy). Enhancement backlog lives in NEXT.md under "Wishlist / Binder enhancement backlog" — 7 Wishlist ideas + 8 Binder ideas + 3 cross-cutting notes to pick from per slice.

## Cross-references

- [`c-trade-builder.md`](./c-trade-builder.md) — consumes wants/available via source chips, sharedLists prop, and the matchmaker (`src/utils/matchmaker.ts`). `bestMatchForWant` is also called from there for the overlap chip + propose auto-fill.
- [`e-home-nav.md`](./e-home-nav.md) — Home's Wishlist and Binder modules, UX-A1 promotion, DrawerContext wiring, `openLists(tab)` callers.
- [`f-community-profile.md`](./f-community-profile.md) — `ProfileView` renders `/api/user/<handle>` data (same shape `useRecipientProfile` fetches). The profile visibility toggles (`wantsPublic`, `availablePublic`) gate what this area exposes.
- [`g-auth.md`](./g-auth.md) — session requirement on `/api/sync/*`, iron-session cookie layer, ghost-user merge (which migrates wants + available server-side when a ghost gets promoted to a real user).
- [`h-cards-pricing.md`](./h-cards-pricing.md) — `cardFamilyId` definition, `CardVariant` shape, `extractVariantLabel`, price resolution used by `bestMatchForWant` + available row price display.
- [`i-discord-bot.md`](./i-discord-bot.md) — bot-side slash commands that also read wants/available (e.g. partner-lookup). The read path is the same `/api/user/<handle>` endpoint documented above.
- [`j-infra.md`](./j-infra.md) — function-count consolidation (`api/sync.ts` + `api/me.ts` as dispatchers), vercel.json rewrites, migration tooling for the server `wants_items` / `available_items` tables.
