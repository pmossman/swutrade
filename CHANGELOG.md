# Changelog

Release notes for production cuts. Dates match the git tag (`v<date>-stable`) on `main`. Not every commit lands here — just the user-facing shape of each release.

## v2026.04.16-stable — 2026-04-16

Foundation-hardening pass before Phase 2 (accounts + sync). No new user-facing features — the scope was code quality, data integrity, test coverage, and component architecture. Everything below is internal.

### Data integrity
- **34 duplicate product rows removed** from the TCGPlayer fetch pipeline. Cards that appeared twice in the picker grid (e.g., Luthen Rael in SEC) are now deduped at ingest with a build-time uniqueness guard.
- **Gold and Rose Gold** variants recognized as first-class print variants (42 SEC cards promoted from gray "unknown" pills to yellow / rose pills). Appended to `CANONICAL_VARIANTS` — existing share-link bitmasks stay backward-compatible.
- **SRP / OPP regional-prize cards** relabeled: numeric parentheticals like `(77)` collapse to a teal "Regional" pill; tournament-placement labels (Champion, Finalist, Top 4/8/16, Day 2) get a shared violet pill. Previously rendered as unlabeled gray unknowns.
- **Enrichment** gained a name-based fallback for sets where TCGPlayer ships empty collector numbers (SECW). Match rate: 93.58% → 94.16% (+40 cards). A regression guard now fails the build if any mapped set drops to 0% enrichment.
- **Share URLs compressed** via deflate + base64url (`fflate`). A 20-card wants list goes from ~1200 chars to ~530 chars (57% reduction). Old uncompressed links still decode correctly.

### Bug fixes
- **`pct=999` in URL** no longer inflates prices 9.99x — `parseTradeUrl` now clamps the percentage to [1, 100].
- **Trade qty stepper** capped at 99 — clicking + past 99 previously went to 100, 101, etc.
- **Search query misrouting** fixed: promo-set slug words like "of", "the", "force" were auto-aliased to set codes, so the swap-variant flow's seeded query "Luke Skywalker - Hero of Yavin" routed to Ashes of the Empire and returned nothing. Aliases now restricted to unambiguous set codes + 2 hand-curated overrides.

### Test coverage
- **74 → 143 unit tests** across 5 new test files. Load-bearing pure logic extracted from hooks into testable reducers: `wantsAddReducer`, `availableAddReducer`, `toggleSetReducer`, `replaceGroupReducer`. `applySelectionFilters`, `browseAllGroups`, `parseQuery`, and `localSearch` now have dedicated suites.
- **17 Playwright e2e specs** added, covering: app boot, search + set-code aliases, trade flow + qty stepper + URL roundtrip, swap-variant kebab, shared-list landing → start-trade handoff → source-chip activation, curator build-and-share (clipboard round-trip), wants dedup through the UI, drawer interactions (tab switch + restriction editor + priority toggle + remove), qty-aware source chip, and mobile viewport sanity at 390×844.
- **E2e wired into CI** via a new GitHub Actions workflow with weekly-cached card data so fetch-prices only hits TCGPlayer once per ISO week. Playwright browser cached per lockfile hash.

### Component architecture
- **`TradeSide.tsx`** reduced from 838 → 393 LOC (−53%) via three extractions:
  - `TradeRow` — trade-panel card row (thumbnail, variant pill, spread badge, qty stepper, kebab menu).
  - `TradeSearchOverlay` — full-screen card picker with encapsulated `useCardSearch`. Parent communicates via `open/onDismiss` + declarative `seed` prop (matches the existing `autoOpenSharedLink` one-shot convention). Source chips generalized to `SourceChipConfig[]` so Phase 3/4 can add new sources without overlay edits.
  - `VariantBadge` — single source of truth for variant-pill chrome, collapsed from 4 inline duplicates.
- **Filter chip groups** (`VariantChipGroup`, `SetChipGroup`) shared between the trade overlay's `SelectionFilterBar` and the shared-list `ListView`. ListView's set-filter mutual-exclusion semantics unified with the trade overlay (group presets now clear individual chips, matching the hook's `replaceGroupReducer`).
- **`formatPrice`** deduplicated from 3 inline copies into `priceService.ts`.
- **`PickerTile`** gained an `aria-label` so screen readers (and e2e tests) can identify each tile in the drawer picker.

### CI / build
- **Refresh-prices cron** now checks the deploy hook's HTTP status and fails the workflow on non-2xx, so a rotated or revoked `VERCEL_DEPLOY_HOOK` secret can't silently succeed while prices go stale.

## v2026.04.15.2-stable — 2026-04-15

Adds in-person and native share surfaces to the lists drawer.

### Unified Share menu
- The drawer's separate "Link" and "Image" buttons consolidate into one **Share** action that opens a popover with every channel under one roof:
  - **Copy link** — same behavior as before.
  - **Share via…** — invokes the OS share sheet via `navigator.share` (AirDrop on iOS, Nearby Share on Android, Messages, WhatsApp, etc.). Hidden on desktop browsers that don't implement the API.
  - **Save as image** — same OG-image render flow, now inside the menu.
  - **Scan to open** QR code at the bottom of the popover so a nearby player can scan with their stock camera app — no install, no permissions, cross-platform.

## v2026.04.15.1-stable — 2026-04-15

Same-day follow-up focused on the shared-link receiving experience and the trade-side picker's sidebar real estate.

### Shared-list landing view
- Rewritten as a compact row layout — tiny thumbnail, name, set code, variant pill, qty, price per row — so a recipient can scan a long list without pagination.
- Ephemeral filter controls (text search + Variant + Set) to let recipients narrow to the subset they care about.
- Wants that carry a multi-variant restriction surface the whole restriction on the row (e.g. `HS / HSF / Std`) rather than just the cheapest-matching rep.

### Start-a-trade handoff
- Clicking "Start a trade" from a shared-list link now drops the user straight into the Offering side's search overlay with the "They want" source chip pre-activated — so the sender's wants are already the grid's contents.
- Variant / Set filters reset on this handoff so a persisted filter from an earlier session can't accidentally zero out the shared list.

### Trade picker: source chips replace sidebar sections
- The "From your Available" and "From the shared link · They want" collapsibles are gone. Their contents now flow into the main grid via two pill-toggle chips above the filters:
  - Offering side: **My available** · **They want**
  - Receiving side: **My wants** · **They have**
- Each chip carries a remaining-qty count (items still pending after what's already been added to this side of the trade) and auto-deactivates when that count hits zero.

### OG image
- Link-preview layout switched from a grid of card tiles (~6 per column) to a dense row list (~18 per column). Matches the web list view so the preview and the landing page look like the same thing.

### Polish
- Lazy-loaded card images use `alt=""` so the alt text doesn't flash in as tiles scroll into the virtualized viewport.

## v2026.04.15-stable — 2026-04-15

The Wants / Available lists feature fully lands, plus a picker rewrite and several rounds of filter/mobile polish. First post-baseline release since `v2026.04.14-stable`.

### Anonymous list sharing
- Build Wants and Available lists locally; share as a copyable link or a rendered OG image.
- Shared links open to a dedicated list view with a "Start a trade" CTA that carries the lists into the main trade UI.
- Link-preview metadata (Discord/Slack/iMessage) generated by `/api/og` for both trade shares and list shares.

### Picker rewrite
- Empty search shows every matching card in browse mode (set + card-number order, leaders/bases sunk to the end of each set) instead of a "type a card name" blank state.
- Virtualized grid via `@tanstack/react-virtual` keeps the picker snappy even with a thousand visible tiles.
- Tap a saved tile's `×N` badge to decrement or remove — no need to close the picker to undo a mistap.
- "Back to list" close, Esc-to-collapse, and search-input select-all on focus wire the type → tap → type → tap batch flow mobile users want.
- Add Card footer moved to the bottom of each trade panel, color-coded to the side.

### Filter redesign
- Variant and Set filters live in collapsible chip bars with per-surface persistence (trade search and picker remember their own selections independently).
- Set presets (All / Main / Special) are a mutually-exclusive three-way switch that clears any individual set chips; individual chips likewise clear the preset. No more redundant combinations.
- Sticky set header at the top of the scroll grid so you always know which set you're looking at.

### Wants variant UX
- Per-tile restriction badges surface exactly what a tap saves — one pill per selected variant in its own color, or a gold "Any" pill when no filter is active.
- The variant-restriction editor on saved Wants only offers variants that actually exist for that card family (a Pyke Sentinel no longer shows Prestige / Serialized / Showcase chips).
- Shared abbreviated chip labels ("HS Foil", "Pres Foil") across the picker and the editor.
- Available picker hides the variant filter entirely — every tap there commits an exact printing.

### Mobile polish
- Compact top bar: "My Lists" label shows alongside the icon on mobile, price pill stacks Mkt/80% vertically, TCG prefix dropped.
- Wants / Available tabs and their Add Card buttons color-coded to match Offering (emerald) and Receiving (blue) for cross-surface consistency.
- Wants-row variant editor is taller with larger tap targets and a dedicated close X.
- Lists sections in the trade search overlay default to collapsed with a tinted count badge so they don't eat the main grid's real estate.

### Data hygiene
- Enrichment now drops non-card SKUs (booster boxes, spotlight decks, prerelease kits) and resolves token/leader id collisions (Gar Saxon no longer appears under "Experience", Qi'ra no longer under "Shield").
- Card families merge by enriched `displayName` so TCGPlayer name typos (Cad vs Cade Bane) show as one card with all variants.

### Known parked work
- Foil / Hyperspace-Foil variants for SOR / SHD / TWI — those sets use TCGPlayer's foil toggle instead of separate SKUs; wiring them up needs a productId dedup-key change. See the roadmap.

## v2026.04.14-stable — 2026-04-14

Stable baseline before Wants / Available lists feature work.
