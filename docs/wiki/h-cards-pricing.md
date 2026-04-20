# Card data + pricing

> **Owner scope**: the atomic `CardVariant` shape plus every pipeline that produces, enriches, stores, indexes, or prices one. If you're reading a trade row's thumbnail, looking up a card by productId, switching Market↔Low, tweaking the % slider, or watching the "Prices updated Xd ago" label tick, the code lives here.
>
> Files owned by this page:
>
> - `src/types/index.ts` — `CardVariant`, `TradeCard`, `PriceMode`, `SETS`, `tradeCardKey`
> - `src/variants.ts` + `src/variants.test.ts` — variant parsing, ordering, badge chrome, `cardFamilyId`
> - `src/enrichment.ts` + `src/enrichment.test.ts` — pure swuapi↔TCGPlayer join
> - `src/services/priceService.ts` — price fetch/read/format/URL helpers
> - `src/contexts/PriceDataContext.tsx` — raw per-set catalog, timestamp, loading/error state
> - `src/contexts/CardIndexContext.tsx` — derived cross-printing indexes
> - `src/contexts/PricingContext.tsx` — user-controlled `percentage` + `priceMode`
> - `src/hooks/usePriceData.ts` — state machine that backs `PriceDataContext`
> - `src/components/PriceModeToggle.tsx`, `src/components/PriceSlider.tsx`, `src/components/VariantBadge.tsx` — pricing/variant UI surface
> - `src/persistence/schemas.ts` (the `percentage` + `priceMode` keys) — localStorage persistence
> - `scripts/fetch-prices.ts` — TCGPlayer price ingestion
> - `scripts/enrich-cards.ts` — swuapi metadata join + `family-index.json`/`product-index.json` builders
> - `scripts/cache/swuapi-all.json` — weekly-cached swuapi export (gitignored)
> - `public/data/*.json` — the static per-set catalogs + `manifest.json` + `product-index.json` + `family-index.json` served to the client
> - `.github/workflows/refresh-prices.yml` — the "cron" (a GitHub Actions scheduled deploy-hook trigger, not a Vercel cron — see Tech debt)
> - `api/og.ts` — OG image renderer (it consumes this subsystem; documented here for the `/tmp` + ESM-JSON gotchas)
>
> Not owned (cross-links at the bottom): how cards get **into** a trade (`c-trade-builder.md`), how they're stored in wants/available (`d-lists.md`), how they're frozen into a proposal snapshot (`b-proposals.md`).

## Overview

This subsystem exists to answer one question everywhere in the app: *"what is a card and what is it worth?"* The pipeline starts at TCGPlayer (SKUs, prices) and swuapi.com (typed card metadata). A build-time merge produces one static JSON catalog per SWU set plus two indexes — `product-index.json` (cheap flat lookups for the OG renderer) and `family-index.json` (grouped by cross-printing identity). The client loads those JSONs lazily into `PriceDataContext`, `CardIndexContext` derives the indexes in a single pass, and `PricingContext` layers on the user's negotiation knobs (`percentage`, `priceMode`). Everything else that renders a price — `TradeRow`, `TradeSummary`, `TradeBalance`, the OG image, matchmaker, shared-list share images — goes through `priceService.ts` so the conversion from raw TCGPlayer data to "the number on screen" happens in exactly one place.

**One-sentence pitch for a new teammate**: TCGPlayer + swuapi merged at build time into static JSON; loaded lazily in the browser via three stacked contexts (raw data → derived indexes → user knobs); rendered through `getCardPrice` + `adjustPrice` + `formatPrice`.

## Key concepts / glossary

- **CardVariant** — the atomic record. One row per *printing* (SOR Luke Skywalker Hyperspace Foil is a distinct `CardVariant` from SOR Luke Skywalker Standard). Defined in `src/types/index.ts:10`. Every price, every thumbnail, every trade line item dereferences one of these.
- **`productId`** — TCGPlayer's per-printing identifier (a numeric string). Primary key of `product-index.json`. Used by "I have this specific card" flows (available list, trade builder, OG image fetch). Drives `cardImageUrl` and `cardTcgPlayerUrl`.
- **`familyId`** — cross-printing identifier derived from `set` + slugified base name (`cardFamilyId`, `src/variants.ts:239`). Groups every printing of a card (Standard, Hyperspace, Showcase, Gold, Serialized) under one key. Used by "I want *any variant* of this card" flows (wants, matchmaker, popular-wants).
- **`baseCardId`** — swuapi's per-printing UUID-like id (e.g., `SOR_005`). Set during enrichment (`src/enrichment.ts:168`). Falls back to a synthesized `{setSlug}:{nameSlug}` for unmatched rows (`src/variants.ts:225`). Historically the key for wants v1, superseded by `familyId` in v2 — the schema comment at `src/persistence/schemas.ts:66` captures the migration rationale.
- **`variant`** — the printing label. One of `CANONICAL_VARIANTS` (`src/variants.ts:10`) or a tournament-proof string (`TOURNAMENT_PROOFS`, `src/variants.ts:32`) or the synthesized `"Regional"` label for bare numeric parentheticals. Extracted from the TCGPlayer product name with `extractVariantLabel` (`src/variants.ts:164`).
- **`PriceMode`** — `'market' | 'low'` (`src/types/index.ts:32`). Selects which of `marketPrice` / `lowPrice` the app reads off the card.
- **`percentage`** — user's negotiation multiplier (1–100). Applied by `adjustPrice(raw, pct)` (`src/services/priceService.ts:37`). Persisted to `swu.pct`; default 80.
- **`manifest.json`** — `{ timestamp, sets: { [slug]: { cards: N } } }` at `public/data/manifest.json`. Drives the footer's "Prices updated Xd ago" label and lets the client discover sets that shipped after the last `src/types/index.ts` update.
- **Family index** — `public/data/family-index.json`. A precomputed `{ familyId → [{ productId, variant, marketPrice, lowPrice, name }…] }`. Written by `scripts/enrich-cards.ts:226` so `api/og.ts` can render list OG images without pulling the megabyte-scale per-set JSONs.
- **Product index** — `public/data/product-index.json`. Compact `{ productId → { name, marketPrice, lowPrice, setName } }`. Built by `scripts/fetch-prices.ts:254`; inlined into `api/og.ts` at build time.

## File map

### Domain model (TypeScript types + pure helpers)

- **`src/types/index.ts`** — `CardVariant`, `TradeCard`, `PriceMode`, `SetInfo`, `SETS`, `tradeCardKey`. The canonical shape flows out of here into every other module, so keep it light on imports (it currently has none).
- **`src/variants.ts`** — variant parsing (`extractVariantLabel`, `extractBaseName`), ordering (`CANONICAL_VARIANTS`, `variantRank`), display chrome (`variantDisplayLabel`, `variantShortLabel`, `variantChipLabel`, `variantBadgeColor`), cross-printing identity (`cardFamilyId`, `synthesizeBaseCardId`), and `isLeaderOrBaseGroup` (landscape detection). Pure — no I/O, no React.
- **`src/variants.test.ts`** — exercises the invariants the callers depend on. The numeric-parenthetical → `"Regional"` collapse, the tournament-proof shared pill, the Showcase-fallback for landscape detection, and the Gold/Rose Gold ordering are all pinned here.
- **`src/enrichment.ts`** — `buildLookup`, `enrichCard`, `canonicalId`, `normalizeCardNumber`, `normalizeCardType`. Pure join logic so the build script and the tests can share it. No React, no fs, no fetch.
- **`src/enrichment.test.ts`** — pins the fallback hierarchy: by-canonical-id → by-name-key → synthesized. The SECW-style "empty number" regression (`enrichment.test.ts:142`) is the one to watch when swuapi or TCGPlayer ship sloppy data.

### Pricing service

- **`src/services/priceService.ts`** — the only place the app reads `marketPrice`/`lowPrice`. Exports `fetchSetPrices`, `fetchManifest`, `adjustPrice`, `formatPrice`, `getCardPrice`, `getAltPrice`, `countMissingPrices`, `cardImageUrl`, `cardTcgPlayerUrl`. The in-module `clientCache` is a per-tab cache that keeps set JSONs warm across navigation (no React state — it's a plain module-scope object).

### Contexts (state layer)

- **`src/contexts/PriceDataContext.tsx`** — thin wrapper over `usePriceData`. Adds an auto-`loadAllSets()` on mount. Fan-out point for raw `cards[slug]`, per-set `loading[slug]`, per-set `errors[slug]`, and `priceTimestamp`.
- **`src/contexts/CardIndexContext.tsx`** — derived. One `useMemo` over `allLoadedCards` builds `byFamily`, `byFamilyAll`, `byProductId`. Nothing but `PriceDataContext` feeds it; it has no state of its own.
- **`src/contexts/PricingContext.tsx`** — the user's knobs. `percentage` + `priceMode`, each backed by `usePersistedState`. `*Raw` setters bypass localStorage so URL-driven restores don't clobber the saved preference.
- **`src/hooks/usePriceData.ts`** — state machine. Owns `loadedRef` (a plain `Set<string>` ref) to dedupe in-flight loads, `retrySet` to reset a failed slot, and the `manifest.json` auto-discovery loop that picks up sets that aren't yet in `SETS`.

### UI surface (pricing-specific, owned here)

- **`src/components/PriceModeToggle.tsx`** — the two-pill Market/Low control. Gold pill = active. Keep it dumb — no context reads, just `value`/`onChange`.
- **`src/components/PriceSlider.tsx`** — the `%` pill + popover with six presets (50/60/70/80/90/100). On mobile the popover also carries the Market/Low toggle so the header can drop the inline one.
- **`src/components/VariantBadge.tsx`** — the colored variant pill with hover hints. Returns `null` for Standard (implicit baseline) so every trade row doesn't render a useless "STD" pill. Hints are a `title` attribute — the simplest thing that ships.

Other components (TradeRow, TradeSummary, TradeBalance) consume this subsystem but belong to `c-trade-builder.md`. The slices they own here are: the red-border missing-price UX (`TradeRow.tsx:160`), the Δ% spread badge (`TradeRow.tsx:164`), the `countMissingPrices` warning (`TradeSummary.tsx:179`, `TradeBalance.tsx:44`), and the subscript alt-price rendering — all thin renders over `priceService` exports.

### Build scripts

- **`scripts/fetch-prices.ts`** — discovers SWU sets from TCGPlayer aggregations, paginates each set 50 rows at a time, dedupes by `productId`, and writes `public/data/{slug}.json` + `manifest.json` + `product-index.json`. Gated by `FETCH_PRICES=1` so normal builds reuse Vercel's restored build cache.
- **`scripts/enrich-cards.ts`** — reads `swuapi-all.json`, joins onto each per-set JSON, drops non-card SKUs (boosters, prerelease kits) when the set had any matches, writes `family-index.json`. Has a regression guard (`enrich-cards.ts:256`) that fails the build if a *mapped* set enriches 0 cards — the only protection against silent data drift when swuapi renames a code.
- **`scripts/cache/swuapi-all.json`** — 7-day cache of the full swuapi export. Refetched when stale or `ENRICH=1`. Gitignored; regenerated by `npm run enrich-cards` as needed.

### OG renderer (consumer, not owner, but called out here for gotchas)

- **`api/og.ts`** — renders 1200×630 PNGs for trade + list share links. Inlines `product-index.json` and `family-index.json` as ESM JSON imports at build time so the function never self-fetches its own (potentially auth-walled) origin. Writes inlined base64 fonts to `/tmp` on cold start (resvg-js wants file paths, not buffers). See `feedback/project_swutrade_ogimage.md` for the constraints.

### The "cron"

- **`.github/workflows/refresh-prices.yml`** — runs every 2 hours (UTC), POSTs to `VERCEL_DEPLOY_HOOK?buildCache=false`, fails the job loud if the hook returns non-2xx. Intentionally a GitHub Actions cron, not a Vercel cron — see Tech debt.

## Data model

### `CardVariant` — the atomic record

```ts
interface CardVariant {
  name: string;         // raw TCGPlayer product name; may include "(Hyperspace Foil)" etc.
  variant: string;      // extracted label; "Standard" when no parenthetical
  printing: string;     // "Normal" | "Foil" (from TCGPlayer's foilOnly flag)
  rarity: string;       // "Common" | "Uncommon" | ... (TCGPlayer verbatim)
  number: string;       // collector number ("5", "224" — not "224/264"; normalized)
  marketPrice: number | null;
  lowPrice: number | null;
  set: string;          // internal slug (matches SetInfo.slug)
  setName: string;      // human-readable; TCGPlayer's exact API name
  productId?: string;   // optional only for legacy rows — effectively always present post-2025
  // Enrichment fields (optional for pre-enrichment cached data):
  baseCardId?: string;  // swuapi id when matched; synthesized fallback otherwise
  displayName?: string; // swuapi's canonical "Name - Subtitle"; defined only on real match
  cardType?: 'Leader' | 'Base' | 'Unit' | 'Event' | 'Upgrade' | 'Token Unit' | 'Token Upgrade';
  aspects?: string[];   // swuapi verbatim (Heroism, Villainy, Vigilance, etc.)
  traits?: string[];    // swuapi verbatim (Rebel, Republic, Trooper, etc.)
}
```

**Non-obvious invariants:**

1. **`productId` vs `familyId` split is load-bearing.** `productId` uniquely identifies a printing; `familyId` aliases all printings. `tradeCardKey` (`src/types/index.ts:46`) keys on `productId` — that's why adding "Luke Hyperspace" and "Luke Standard" to the same trade side yields two rows, not one.
2. **`displayName` is the real-match signal.** `baseCardId` is *always* set after `enrichCard` (synthesized when necessary), so presence of `baseCardId` tells you nothing. `displayName` is only defined when swuapi matched, so `enrich-cards.ts:169` uses `result.displayName !== undefined` as the match counter and the non-card-SKU filter at `enrich-cards.ts:189` trusts `cardType` (which also only lands on real matches).
3. **`variant` is redundant-but-authoritative.** The TCGPlayer product name carries the parenthetical (`"Luke Skywalker - Faithful Friend (Hyperspace Foil)"`), so `extractVariantLabel(card.name)` can always rederive it. `card.variant` is pre-extracted at ingest time — callers should prefer the field, but the fallback-to-`extractVariantLabel` pattern is used in several places (`api/og.ts:208`, `src/components/TradeRow.tsx:138`) because it survives mis-enriched rows.
4. **`marketPrice` null ≠ "$0".** Null means *TCGPlayer had no sale data at ingest time*. The app loudly flags these (red border, red icon, red line total) because they silently contribute $0 to totals otherwise (`src/components/TradeRow.tsx:155-162`). `countMissingPrices` (`src/services/priceService.ts:67`) is the shared counter that `TradeSummary` and `TradeBalance` both surface.
5. **`lowPrice` is "market low", not "lowest listing".** TCGPlayer's `lowestPrice` field comes from live listings filtered by sellerStatus+quantity+directInventory (`scripts/fetch-prices.ts:71-73`). Don't confuse it with retail floor.

### `SetInfo` + `SETS` — the authoritative set list

`src/types/index.ts:59`. Currently 27 entries: 7 main expansions + 20 promo-category sets. The `slug` is the URL-safe identifier TCGPlayer uses (e.g. `spark-of-rebellion`); the `code` is the short tag that lines up with swuapi's `setCode` in the happy path. `category: 'main' | 'promo'` drives UI grouping in set-filter pickers.

New sets don't strictly require a `SETS` entry — `usePriceData.loadAllSets()` (`src/hooks/usePriceData.ts:58-70`) walks the manifest and synthesizes a `SetInfo` for any slug it doesn't recognize. But without a hand-authored entry the display name is just the kebab-case slug, and enrichment won't know which swuapi code to key on. The build warns loudly (`scripts/fetch-prices.ts:226`) when TCGPlayer aggregations return a new set.

### `CANONICAL_VARIANTS` — the ordering invariant

`src/variants.ts:10`. The **position** of each variant in this array is load-bearing: `src/urlCodec.ts` encodes wants-restriction masks as `1 << CANONICAL_VARIANTS.indexOf(v)`. Existing share links in the wild encode with today's bit positions, so:

- **Never** insert a variant in the middle. Existing `?w=` params would decode to the wrong variant set silently.
- **Only** append. `"Gold"` and `"Rose Gold"` (indexes 8–9) were appended after launch; the comment at `src/variants.ts:6` documents this and `api/og.ts:48` keeps a manually-mirrored copy with the same constraint.
- The *display* order is separate (`VARIANT_ORDER` at `src/variants.ts:42`) so Standard/Foil/Hyperspace/HSF/Prestige/PrestigeF/Serialized/Gold/RoseGold/…Regional/tournament/Showcase can be reordered visually without touching the URL codec. Keep these two tables mentally distinct.

### `TOURNAMENT_PROOFS`

`src/variants.ts:32`. Seven strings (Champion, Finalist, Top 4/8/16, Day 2, Galactic Championship VIP). Intentionally not in `CANONICAL_VARIANTS` — they're *provenance*, not print finishes. The restriction editor won't offer them, persisted wants can't carry them, but `variantBadgeColor` recognizes them (single violet pill, label carries the placement).

### Storage shape — `public/data/`

Every SWU set has its own file. A size-ordered sample from `manifest.json`:

```
secrets-of-power.json           1222 cards
legends-of-the-force.json       1203
jump-to-lightspeed.json         1182
a-lawless-time.json              945
spark-of-rebellion.json          550
… (see manifest for full list)
manifest.json                    { timestamp, sets: {...} }
product-index.json               { [productId]: { n, p, l, s } }
family-index.json                { [familyId]: [{ p, v, m, l, n }…] }
```

Each per-set JSON is an array of `CardVariant`s. Served as a **static asset** from Vite's `public/` output — there's no API endpoint for prices; the browser just fetches `/data/{slug}.json` directly. This is what keeps the function count under Vercel's plan ceiling (see `api/context.md` and project memory `project_swutrade_function_ceiling`).

### localStorage keys

Defined in `src/persistence/schemas.ts:56-75`:

- `swu.pct` — the `%` slider (1–100 int, default 80)
- `swu.pm` — `"market"` or `"low"` (default `"market"`)

Both validated with Zod on read (`PercentageSchema`, `PriceModeSchema`). The `usePersistedState` third-tuple entry returns a "raw" setter that bypasses the write-back — used by `useTradeUrl` when restoring from a share URL so the share doesn't overwrite the user's saved knob.

## Public surface

### Exports from `src/types/index.ts`

- `type CardVariant` — the atomic record.
- `type CardType` — the union of enriched card types.
- `type TradeCard = { card: CardVariant; qty: number }` — what lives in `yourCards`/`theirCards` on every trade-adjacent surface.
- `type PriceMode = 'market' | 'low'`.
- `type CardGroup = { baseName, variants }` — consumed by `groupCards` for variant pickers.
- `type SetInfo` + `const SETS` — the set list.
- `tradeCardKey(card) → string` — dedup key for a TradeCard. Uses `productId || name` plus `set`. When `productId` is absent the name is load-bearing; don't drop the `|| name` fallback.

### Exports from `src/variants.ts`

- `cardFamilyId(card) → string` — the cross-printing key. `{setSlug}::{nameSlug}`.
- `synthesizeBaseCardId(card) → string` — single-colon variant (`{setSlug}:{nameSlug}`) used when swuapi has no match. Intentionally distinct shape from `cardFamilyId` so a stray enrichment miss can't collide with a real family key.
- `extractVariantLabel(name) → string` — parses the trailing parenthetical. Numeric → `"Regional"`. No parenthetical → `"Standard"`.
- `extractBaseName(name) → string` — strips the trailing parenthetical.
- `cardBaseName(card) → string` — prefers `displayName` (swuapi-canonical) and falls back to `extractBaseName`. Use this for any user-facing base-name rendering that spans enriched + unenriched data.
- `groupCards(cards) → CardGroup[]` — buckets a flat list by `cardBaseName`. Used by variant-swap pickers.
- `variantRank(label) → number` — for sorting. Unknown variants get rank 50 (before Showcase=99, after all known print variants).
- `variantDisplayLabel`, `variantShortLabel`, `variantChipLabel`, `variantBadgeColor` — three densities of variant label + one color function. Used in the respective UI surfaces; documented by the leading comment of each.
- `isLeaderOrBaseGroup(variants) → boolean` — landscape detection. Prefers `cardType`; falls back to Showcase-heuristic when no enrichment. The comment at `src/variants.ts:183` explains why the fallback misfires for Unit-with-Showcase cards (Darth Vader - Unstoppable) and why the typed path is authoritative.
- `CANONICAL_VARIANTS`, `TOURNAMENT_PROOFS` — tuples read by the url codec and the restriction editor.

### Exports from `src/services/priceService.ts`

- `fetchManifest() → Promise<Manifest>` — module-cached.
- `fetchSetPrices(set) → Promise<CardVariant[]>` — module-cached per slug.
- `getCardPrice(card, mode) → number | null` — the mode-selected raw price.
- `getAltPrice(card, mode) → number | null` — the non-active mode's price. Used for TradeRow's subscript "alt price" display.
- `adjustPrice(price, percentage) → number | null` — rounds to 2 decimals. Null-in, null-out.
- `formatPrice(price) → string` — `"$1.23"` or `"N/A"`. The canonical display renderer.
- `countMissingPrices(cards, mode) → number` — qty-weighted count of nulls. Used for the "N cards missing price" banner.
- `cardImageUrl(productId, size) → string | null` — returns a TCGPlayer CDN URL at `200x279` (sm/md) or `400x558` (lg). Null for empty/"0" productIds so callers can fall back to `?` placeholder.
- `cardTcgPlayerUrl(productId) → string | null` — store URL. Same null-gating rules.

### Exports from enrichment

- `buildLookup(cards) → EnrichmentLookup` — builds both `byCanonicalId` and `byNameKey` indexes in one pass. Handles token-vs-real-card collisions (`src/enrichment.ts:85-96`).
- `enrichCard(card, lookup, opts) → CardVariant` — by-id first, then by-name fallback, then synthesized. Always returns a new object; never mutates.
- `canonicalId(setCode, cardNumber)`, `normalizeCardNumber(raw)`, `normalizeCardType(raw)`, `nameSlug(name)` — the join primitives. All pure.

### Contexts (hooks)

- `usePriceDataContext()` — raw feed. Read `cards[slug]`, `loading[slug]`, `errors[slug]`, `priceTimestamp`, `isAnyLoading`. Mutate via `loadSet(set)`, `loadAllSets()`, `retrySet(set)`. `CardIndexProvider` depends on this, so it has to mount inside `PriceDataProvider`.
- `useCardIndexContext()` — `byFamily` / `byFamilyAll` / `byProductId` / `allLoadedCards`. Recomputed once per `cards` change. Every lookup the app does (wants → cheapest printing, productId → card, familyId → every printing) funnels through these maps — before the extraction each view had its own `useMemo` rebuilding them (`CardIndexContext.tsx:10-13` documents the regression that motivated the context).
- `usePricing()` — `{ percentage, setPercentage, setPercentageRaw, priceMode, setPriceMode, setPriceModeRaw }`. The `Raw` variants bypass localStorage; the non-Raw variants write through.

### HTTP surface

**None on the owned side.** Prices are static JSON (`/data/*.json`); the enriched indexes are static JSON; the images come from `product-images.tcgplayer.com`. `api/og.ts` is the only HTTP handler this subsystem exposes, and it consumes the indexes — it doesn't serve prices.

This is deliberate: price data changes at most every 2h; a Vercel static asset behind Vercel's edge cache is strictly cheaper and faster than any serverless handler we'd write, and it keeps us under the function count ceiling.

## State + data flow

### Build time

1. **Fetch (`scripts/fetch-prices.ts`).** Unless `FETCH_PRICES=1`, the script no-ops when `manifest.json` + `product-index.json` already exist in `public/data/` — Vercel restores the directory from build cache between deploys so regular builds finish in seconds. When forced: discover sets from TCGPlayer aggregations (`fetch-prices.ts:97`), paginate every set at 50 rows (`fetch-prices.ts:141-193`), dedupe by `productId` (first wins; warn on price mismatch — the warning fires when TCGPlayer's relevance-sort pagination returns a duplicate row mid-update). Write per-set JSONs + manifest + product-index.
2. **Enrich (`scripts/enrich-cards.ts`).** Load `scripts/cache/swuapi-all.json` (or refetch if stale or `ENRICH=1`). For each per-set JSON, run `enrichCard` on every row. Drop non-card SKUs (boosters, prerelease kits) *only when the set had at least one real match* — a zero-match set (e.g., Judge Promos) keeps everything because filtering on unenriched data would nuke real rows (`enrich-cards.ts:185-200`). Build `family-index.json`. Fail the build via the regression guard (`enrich-cards.ts:256`) if any *mapped* set (i.e., not in `KNOWN_UNMAPPED`) enriches zero cards.
3. **Package.** `vite build` bundles the client; the static JSONs are copied verbatim from `public/` to `dist/`. `api/og.ts` inlines `product-index.json` + `family-index.json` at compile time (ESM JSON imports, `assert { type: 'json' }`) so the serverless function doesn't need to read from disk at runtime.

### Runtime — first paint

1. **`<PriceDataProvider>` mounts** (in `App.tsx`'s provider stack). `useEffect` fires `loadAllSets()` on mount (`PriceDataContext.tsx:20-22`).
2. `loadAllSets` spawns a `loadSet` call for every entry in `SETS`, then awaits `fetchManifest()` to pick up any sets not yet in `SETS` and spawns those too. Each `loadSet` hits `loadedRef` to dedupe, then calls `fetchSetPrices(set)` which hits the in-module `clientCache` (warm across route changes) or issues a `fetch('/data/{slug}.json')`. Result lands in `state.cards[slug]`.
3. **`<CardIndexProvider>` mounts** inside the price provider. Its `useMemo([cards])` rebuilds `byFamily`/`byFamilyAll`/`byProductId` whenever any set's rows arrive. The memo's dependency is `cards` (the whole record), so the indexes grow set-by-set as loads complete — consumers see the latest index on every paint.
4. **Consumers render.** `TradeRow` pulls `percentage`/`priceMode` out of `usePricing`, calls `getCardPrice + adjustPrice`, renders. The footer pulls `priceTimestamp` from `usePriceDataContext` and renders `Prices updated {timeAgo(priceTimestamp)}` (`App.tsx:817-823`). A minute-tick `setState` (`App.tsx:344-351`) keeps the "Xm/Xh/Xd ago" labels ticking while the user is idle.

### Runtime — URL restore

`useTradeUrl` (see `c-trade-builder.md`) can be asked to restore state from `?y=…&t=…&pct=…&pm=…`. When restoring:

- Card references come in as productIds; the restore code uses `byProductId` from `CardIndexContext` to inflate them into `TradeCard`s.
- `percentage` and `priceMode` are applied via `setPercentageRaw` / `setPriceModeRaw` so the URL-restore path doesn't clobber the user's saved preference.

### Runtime — retry on fetch failure

When a `/data/{slug}.json` fetch fails, `usePriceData` writes `errors[slug]` and removes the slug from `loadedRef` so the next `retrySet` call can re-issue the fetch (`usePriceData.ts:48-53`). No auto-retry — a user-visible retry button is expected to drive it. As of writing, the only retry surface is on the way: `PriceDataContext` exposes `retrySet` but no component currently wires it.

### Runtime — ghost mode / unauthenticated

Prices and card data are entirely anonymous. No auth required to read `/data/*.json`; the OG renderer is anonymous too. This means a ghost user can build a trade, see balance, share a URL — the whole pricing pipeline is auth-free by design.

## UI/UX patterns

### Variant chrome (`VariantBadge` + color helpers)

- Standard → no pill. It's the implicit baseline; rendering a badge on every row would drown out the non-Standard variants that actually matter.
- Every print variant gets a distinct hue (`variantBadgeColor` at `src/variants.ts:130`). The comment there pins the constraint: **don't collide with emerald (offering) or blue (receiving)** — they're reserved side-identity colors.
- Tournament placements share a single violet pill (`src/variants.ts:152`). The label does the disambiguation; separate hues would be noise.
- Regional (numeric-parenthetical reprints) gets its own teal pill so it reads as "event-adjacent" without colliding with any print variant.
- Gold and Rose Gold (SEC era) get yellow + rose to read as "metallic gold / rose gold" without reusing the `gold` token that belongs to balance chrome.

### Price-mode toggle

- Two-pill segment (Market / Low). Gold-on-gold when active.
- On desktop the toggle lives inline in the header; on mobile the inline version hides and the popover inside `PriceSlider` carries it so users still reach it.

### Percentage slider

- Collapsed-by-default gold pill. Six presets (50/60/70/80/90/100); 3-column grid on mobile, 6-column on desktop.
- Label reads `"{value}%"` on desktop; on mobile it stacks `"Mkt 80%"` vertically so the pill stays narrow when both toggles live in the popover.
- The reason presets-only (no free-typing): negotiation framing is coarse — "at 80%" is a plausible opener, "at 83%" is noise. Forcing round numbers keeps the UX calm.

### Missing price — loud everywhere

The missing-price pattern isn't subtle, and it shouldn't be:

- `TradeRow` renders a red left border + tinted red background (`TradeRow.tsx:160`) plus a warning icon in the row label.
- Line total text flips to `text-red-400 font-bold` (`TradeRow.tsx:74`).
- `TradeBalance` and `TradeSummary` surface a row-count warning via `countMissingPrices` (`TradeBalance.tsx:44`, `TradeSummary.tsx:179`). `TradeSummary.tsx:343` renders "N cards missing price — balance is incomplete".
- The underlying cause is almost always a card with no recent TCGPlayer sales; the signal isn't "we failed to fetch", it's "TCGPlayer has no market price for this SKU right now".

### Δ% badge (Market↔Low spread)

`TradeRow.tsx:146-150`. Two thresholds must **both** be met to light the badge:

- `spreadPct >= 0.25` (relative — 25% or more gap).
- `spreadDollar >= 0.5` (absolute — at least 50¢).

The absolute floor keeps the badge from screaming about $0.30 vs $0.20 commons (33% spread, trivial dollars). The badge sits in amber; the `title` attribute spells out the raw Market + Low. Only rendered in `size: 'lg'` rows (`TradeRow.tsx:217`) — the dense rows can't afford the pixels.

### Prices-updated footer

`App.tsx:812-824`. While any set is still loading, shows `"Loading prices…"` in animate-pulse. Otherwise shows `"Prices updated {timeAgo}"` with `timeAgo` covering m/h/d (`App.tsx:64`). A `title` attribute carries the raw ISO timestamp so hovering gives precise data without cluttering the footer. Re-renders once per minute via the `setMinuteTick` effect at `App.tsx:344-351`.

### Images

`cardImageUrl(productId, size)` + `CardThumb` (`TradeRow.tsx:28-69`). Loads TCGPlayer's CDN directly (`product-images.tcgplayer.com/fit-in/{dims}/{productId}.jpg`). On `onLoad` the thumb compares `naturalWidth` to `naturalHeight` and flips its aspect class if landscape — leaders/bases are landscape-oriented cards and the portrait box would chop them in half. `onError` swaps in a `?` placeholder. Lazy-loaded (`loading="lazy"`) so deep scrolls in variant pickers don't thrash the network.

The `sm`/`md` sizes both fetch `200x279` (mobile retina can use the bigger one; `sm` exists to tag the CSS size class). `lg` fetches `400x558` for the picker-hero surface.

## Tech debt + known gaps

### The "cron" lives in GitHub Actions, not Vercel

`.github/workflows/refresh-prices.yml` pokes a Vercel deploy hook every 2h. The comment in `api/context.md` says "The refresh-prices cron is the only active one today" — which is **incorrect**; there's no Vercel cron, and there's no `crons` entry in `vercel.json`. The GitHub Actions workflow is the actual scheduler. Why:

- A Vercel cron would need to do the fetch from inside a serverless function and persist JSONs somewhere (Blob/KV) — the current pipeline writes to `public/data/` at build time, which only a full deploy can populate.
- Triggering a deploy is the cheapest way to get fresh prices into `public/data/` without re-architecting the pipeline.

The trade-off is that **every price refresh is a full deploy**. Beta + main both rebuild the whole site every 2h. `buildCache=false` guarantees `fetch-prices.ts` actually re-fetches (otherwise the skip-if-exists gate at `fetch-prices.ts:208` would no-op). For the current traffic level this is fine; for anything heavier we'd want an API-backed price service.

### Missing-price retry has no UI

`usePriceData.retrySet` is exposed through `PriceDataContext` but no component wires it. A transient `fetch` blip on first paint leaves the set blank with no user-visible recovery path until a full reload. The blast radius is small (the other sets still load; cards from the failed set just don't appear in search) but it's a known gap.

### `extractVariantLabel` fallback is silent

Unrecognized variant labels (anything not in `CANONICAL_VARIANTS ∪ TOURNAMENT_PROOFS ∪ "Regional"`) get `variantBadgeColor`'s gray fallback (`variants.ts:153`) and `variantRank`'s "50" slot (between Serialized and Showcase). There's no telemetry on how often the fallback fires; when TCGPlayer ships a new variant label we won't notice in production until someone sees a gray pill. The test (`variants.test.ts:65-67`) pins the fallback behavior but not its rate.

### Token-collision handling in `buildLookup` is subtle

`src/enrichment.ts:85-96`. When swuapi lists a token (Experience Token Upgrade at SHD_1) and a real card (Gar Saxon Leader at SHD_1) at the same canonical id, we prefer the non-token. The token-preference is correct but *fragile*: if swuapi changes its data shape (e.g. token variantType becomes "Standard"), the preference order could flip. The test coverage is indirect — `enrichment.test.ts` exercises the Standard-preference path but not the token path. Worth a dedicated test.

### Set-code override table ages poorly

`scripts/enrich-cards.ts:53-63`. Every SWU set whose TCGPlayer slug doesn't line up with swuapi's `setCode` needs a manual entry (`SET_CODE_OVERRIDES`). The regression guard catches *mapped* sets that regress to zero matches; it does **not** catch unmapped sets that gained swuapi coverage after launch. Those silently stay at 0% enrichment. A periodic audit (comment at `enrich-cards.ts:30-52` documents the last one on 2026-04-15) is the current mitigation.

### `JP` (Judge Promos) + `PRP` (Prerelease Promos) are unenriched by design

Both split across years (J24+J25, P25+P26) and TCGPlayer's single slug can't carry the year. The audit comment at `scripts/enrich-cards.ts:50-52` walks through why multi-code lookups generate false matches (Ki-Adi-Mundi inheriting K-2SO's metadata in the audit). Until a per-card disambiguator lands (name+number or a year column), these sets stay at 0% enrichment — cards still render, prices still work, but `cardType` / `aspects` / `traits` are unavailable.

### Two sources of truth for `CANONICAL_VARIANTS`

`src/variants.ts:10` and `api/og.ts:48`. Both must stay in sync because `api/og.ts` is bundled separately (the OG handler doesn't import from `src/`). The comment at `api/og.ts:45` documents the constraint; the risk is appending a variant to `src/variants.ts` and forgetting to mirror it — OG-rendered share images would miss the new variant's pill styling without the tests catching it.

### `clientCache` in `priceService.ts` never invalidates

`src/services/priceService.ts:7`. Module-scope object that fills once per tab and never empties. This is fine because the per-set JSONs are immutable within a deploy (new prices = new deploy). But a long-lived tab can see **stale prices** until reload, since the client won't pick up a new deploy's JSONs without a fresh page load. `priceTimestamp` in the footer is the user's signal — if it shows "18h ago" and the user expects hourly refreshes, they'll reload.

### `manifest.json` is the only timestamp

There's no per-card or per-set freshness tracking. A set that fails to re-fetch silently keeps its old JSON; the timestamp in `manifest.json` only reflects when `fetch-prices.ts` last wrote the manifest. If one set's fetch fails mid-run the manifest timestamp still advances (the current `fetch-prices.ts:141` doesn't skip the manifest write on partial failure). Unlikely in practice but worth noting.

### `CardVariant.productId` is typed optional

Legacy cached data from before productId was captured could deserialize without one, so the schema keeps `productId?`. In practice every row from the current TCGPlayer pipeline has a productId, and the filter at `fetch-prices.ts:162` explicitly drops rows without one. The optionality ripples into every consumer (`cardImageUrl` does null gating, `tradeCardKey` falls back to `name`, etc.). Tightening the type would require a data migration; deferred.

### No cardType-aware rarity rendering

`CardVariant.rarity` is TCGPlayer's string verbatim ("Common", "Uncommon", "Rare", "Special Rare", "Legendary"). No semantic enum, no display-helper. Fine for now because rarity is only shown in raw search-results contexts; if we ever want colored rarity chips (the way Magic + Pokémon apps do), the enum becomes the bottleneck.

## Decisions worth remembering

- **Static JSON over API endpoints for prices.** Under Vercel's function-count ceiling (see `api/context.md`), serving prices from a serverless handler would burn one of our scarce function slots and add latency for zero benefit — the data is refreshed on a 2h cadence, fits in Vercel's edge cache, and the client can load it lazily per set. `fetchSetPrices` goes straight to the static asset.
- **`familyId` over `baseCardId` as the wants key.** The v1 schema keyed wants on swuapi's `baseCardId`, which is *per-printing* (SOR_005 for Standard, SOR_505 for Hyperspace, etc.). That meant "I want Luke Skywalker" had to be three separate wants for the same card. The v2 migration (`src/persistence/schemas.ts:66`, `src/variants.ts:231`) switched to `cardFamilyId` (cross-printing) so "any variant" genuinely covers every printing. V1 data is **not** migrated — the comment calls this out explicitly. The fresh start was a deliberate call; the active user base at migration time was small enough to make a clean break preferable to a complex migration.
- **Tournament proofs as `variant`, not as a separate field.** Treating `"Finalist"`, `"Champion"`, etc. as values in the same `variant` slot as `"Hyperspace"` means the variant badge component handles them uniformly, and the share-URL mask automatically includes/excludes them without special-casing. The downside — you can't express "I want any Hyperspace *or* any tournament proof" — hasn't come up.
- **Enrichment is optional-idempotent.** `enrichCard` never fails; unmatched rows get a synthesized `baseCardId` and the other fields stay undefined. This is deliberate: the build must survive swuapi being down. The fallback is documented at `scripts/enrich-cards.ts:126-132` — if `fetchSwuApi` throws, we log the warning and continue with an empty lookup, every card gets a synthesized id, the app still works.
- **Regression guard on zero-match sets.** `scripts/enrich-cards.ts:256-280` was added after a silent drift: an override went stale, a mapped set regressed to 0% enrichment, and nobody noticed for a week. The guard now fails the build loud when a mapped set goes to zero matches. `KNOWN_UNMAPPED` is the escape hatch for sets where 0% is correct.
- **Three context layers, not one.** `PriceDataContext` (raw) / `CardIndexContext` (derived) / `PricingContext` (user). The separation matters because they invalidate at different rates: price data arrives over time as sets load; indexes rebuild when data arrives; user knobs rarely change. Merging them would re-memo everyone on every set-load. The comment at `CardIndexContext.tsx:10-13` documents the "ListsDrawer rendered familyId slugs" regression that motivated the extraction.
- **Per-tab module-scope cache in `priceService.ts`.** Considered `react-query` / TanStack Query, chose not to adopt it for prices. The data is effectively immutable within a deploy; a Map keyed on slug + a Promise-returning function is ~15 lines and covers every reload-within-session case. The trade-off is the stale-until-reload problem (Tech debt).
- **`manifest.json` auto-discovery of unknown sets.** `usePriceData.loadAllSets` walks the manifest to pick up sets not yet in `SETS` (`usePriceData.ts:62-70`). This means a TCGPlayer-published new set appears in search on the next deploy without a code change — we only need to add it to `SETS` for display-name polish. The category defaults to `'promo'` so it doesn't sneak into the "main expansions" section unattended.

## Cross-references

- [`c-trade-builder.md`](./c-trade-builder.md) — how cards are added to trades (TradeSide + picker), URL codec, TradeRow/TradeSummary/TradeBalance rendering. Those components *consume* this subsystem.
- [`d-lists.md`](./d-lists.md) — wants + available lists, which store cards by `familyId` (wants) and `productId` (available). The cross-printing split documented here is load-bearing for list matching.
- [`a-sessions.md`](./a-sessions.md) + [`b-proposals.md`](./b-proposals.md) — trade_sessions and trade_proposals snapshot the `CardVariant` shape at the moment of creation. The snapshot fields they store (`productId`, `name`, `marketPrice`, `lowPrice`, `variant`, `set`, `setName`) come from here; the freeze semantics are theirs.
- [`e-home-nav.md`](./e-home-nav.md) — where `PriceDataProvider`, `CardIndexProvider`, and `PricingProvider` mount in the provider stack.
- [`j-infra.md`](./j-infra.md) — the build pipeline that runs `fetch-prices` + `enrich-cards` as part of `npm run build`, and the GitHub Actions workflow that triggers the 2h refresh.
