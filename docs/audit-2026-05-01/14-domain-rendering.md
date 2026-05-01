# Domain-data rendering audit — 2026-05-01

## Inventory tables

### 1. Card name

- **`extractBaseName(card.name)`:** TradeRow `:232`, TradeSummary `:80,189`, TradeExpandPeek `:150`, TradeSide search seed `:410`.
- **Inline `displayName ?? name.replace(/\s*\([^)]*\)\s*$/, '')`** (5 copies of canonical `cardBaseName`): FamilyRow `:88`, ProfileView `:492`, ListView `:410`, SignalBuilderView `:121`; ListRows `:87-88` does the same via `extractBaseName` fallback.
- **HomeView `:812`:** `extractBaseName` only — never reaches `displayName`.
- **Raw `card.name`:** TradeDetailView snapshot `:585`, ProposeBar snapshot `:783`, CardTile aria `:125,195`, SessionSuggestComposer `:231`, SessionSuggestions `:217,376`.
- **Slug-titlecase fallback (lossy):** CommunityView `:727-737`.
- **Local `extractBaseName` copy:** `api/og.ts:354,568,705`, `api/search.ts:129`.

`cardBaseName` (`variants.ts:202`) is canonical; only `groupCards` consumes it.

### 2. Variant labels

- **`<VariantBadge>` wrapper:** TradeRow `:234`, ProfileView `:520`, TradeExpandPeek `:178`.
- **Bare `extractVariantLabel` / `variantChipLabel` + `variantBadgeColor`** (no wrapper): CardTile `:177`, SignalBuilderView chip `:760-762`.
- **`extractVariantLabel` (used to drive logic, not chrome):** ListView `:407`, ListRows `:287`.
- **Raw `c.variant` in uppercase-tracking pill:** TradeDetailView `:586`, ProposeBar `:788`.
- **Raw `card.variant` in `(parens)`:** SessionSuggestions `:218-220`.
- **Mixed chip helpers:** ListCardPicker `:186-200` (uses `variantDisplayLabel`, `variantShortLabel`, `variantBadgeColor` together).
- **Restriction join (read-only):** ListView `:417`, ProfileView `:495` → `variants.map(variantChipLabel).join(' / ')`.
- **Restriction label (editor):** ListRows `:65-70` → `'Any variant'` / `'Only X'` / `'X or Y'` / `'N variants'`.
- **Local `extractVariant` (drops `(\d+) → 'Regional'`):** ShareLiveTradeButton `:83`, `api/og.ts:117`, `api/search.ts:32`.

### 3. Set display

- ListView right-rail `:411`: `SET_CODE_BY_SLUG.get(card.set) ?? card.set.toUpperCase().slice(0, 4)`.
- SignalBuilderView chip `:125` and `lib/signalMatching.ts:67-70`: parse `familyId.split('::')[0]` → setCode.
- CardResultsGrid sticky heading `:134`: `setName` (full).
- SetFilter chips `:69-80`: `set.name` + `set.code`.
- CommunityView wants fallback `:727-737`: parses + titlecases slug.

### 4. Price display

`formatPrice` (`priceService.ts:47-50`) → `$1.23` / `'N/A'`. Consumers: TradeRow, TradeSide, TradeSummary tile, CardTile, FamilyRow.

Inline `` `$${n.toFixed(2)}` `` (renders `$0.00` for null): `TradeBalance.tsx:26-28`, `TradeSummary.tsx:214,278,283`, `TradeDetailView.tsx:530,573,589`, `ProposeBar.tsx:771,792,829-842`, `ListRows.tsx:299`, `ListView.tsx:457`, `ProfileView.tsx:530`, `TradeSearchOverlay.tsx:267`. Spread tooltips: `CardTile.tsx:184`, `TradeRow.tsx:173`.

### 5. Handle / display name

- `Trade with @{handle}`: AccountMenu `:128`, ProfileView CTA `:218`, SessionView breadcrumb `:128`.
- `with @{handle}` (no "Trade"): SessionTimelinePanel header `:165` — anti-rec.
- Plain `@{handle}`: TradesHistoryView `:454`, CommunityView `:541,786`, SignalBuilderView preview `:485`.
- HandlePickerDialog `:471`: `@{handle}` + secondary `username` line; avatar `name` prop `:408,435,468` uses `username || handle`.
- TradesHistoryView avatar initial `:675`: `user.username` (every other Avatar derives from `handle`).

### 6. Time display

5 relative-time helpers + 2 absolute formatters + 5 bare-locale sites:
- `timeAgo` `App.tsx:70-78` — no date fallback.
- `timeAgo` `TradeDetailView.tsx:489-499` — 30d fallback.
- `relativeTime` `TradesHistoryView.tsx:686-694` — no fallback.
- `timeAgoShort` `HomeView.tsx:1165-1175` — 30d fallback.
- `formatRelative` `CommunityView.tsx:565-577` — 7d fallback.
- `formatTime` `SessionTimelinePanel.tsx:487-497` (absolute clock); `formatTerminalDate` `SessionView.tsx:817-820`.
- Bare `toLocaleString`: `App.tsx:955`, `BetaBadge.tsx:15`, `NudgeDialog.tsx:116`, `TradeDetailView.tsx:234,241`.

### 7. Card key / family id (parsers)

- `tradeCardKey` (`types/index.ts:45-47`): `${productId||name}-${set}`. SessionView key→productId Map (`:158-164`) is the recent-bug fix; App/TradeSide/SearchResults/TradeSummary use the key as a comparator only. Safe.
- `cardFamilyId` (`variants.ts:239-241`): `${set}::${slug}`.
- **Parsers (the recent-bug class):** `SignalBuilderView.tsx:122` and `lib/signalMatching.ts:67-70` parse `familyId.split('::')[0]` for setCode (safe but fragile). **`CommunityView.tsx:727-737`** parses `::` then re-splits card-slug on `-` to titlecase — actively lossy ("of" and parens lost); comment `:721-725` self-flags.
- ListCardPicker `:437` builds `${familyId}::${variant}` (builder).
- `synthesizeBaseCardId` (`variants.ts:226`) uses single `:` — divergent from `cardFamilyId`'s `::`. Enrichment-only.

### 8. Quantity rendering

- `×{qty}` (majority, no space): CardTile/FamilyRow steppers, HomeView, ProfileView, TradeSummary badge, SessionSuggestions, Timeline, ListView, TradeExpandPeek badge.
- `× {qty}` (prefix + space): TradeRow `:300`, TradeSummary/TradeExpandPeek titles `:52,:155`.
- `{qty}×` (suffix): TradeDetailView `:584`, ProposeBar `:782`.
- Decrement-button glyph reuses `×` (TradeRow:285, CardTile:200, FamilyRow:154) — same character, different semantic.

## High-impact findings

### F1 — Three places parse `familyId` instead of looking up a card
`SignalBuilderView.tsx:122`, `CommunityView.tsx:727-737`, `lib/signalMatching.ts:68` all do `familyId.split('::')[0]` to recover the set slug. CommunityView additionally re-splits the card-slug on `-` to titlecase — actively lossy ("Luke Skywalker Hero Of Yavin" loses "of" and parens). Same parser-instead-of-map pattern that broke the qty stepper; CommunityView is a real bug today. **Fix:** familyId → {card, setCode, label} lookup at module load (mirrors `PRODUCT_TO_FAMILY` at `lib/signalMatching.ts:78-86`); comment at `CommunityView.tsx:721-725` is the spec. **Risk:** low · **Effort:** S · **Confidence:** high.

### F2 — Three duplicate `extractVariant` copies miss the regional-promo rule
`api/og.ts:117-120`, `api/search.ts:32-36`, `ShareLiveTradeButton.tsx:83-86` each implement local `extractVariant`. None applies the canonical `if (/^\d+$/.test(raw)) return 'Regional'` rule (`variants.ts:164-170`). OG images and share-link payloads with regional-promo cards render the literal string "77" as the variant — permanent in saved snapshots. **Fix:** re-export `extractVariantLabel` to a location reachable from `/api`. **Risk:** low · **Effort:** XS · **Confidence:** high.

### F3 — `formatPrice` bypassed in 8+ proposal/summary surfaces
Trade builder uses `formatPrice`; proposal/session surfaces (TradeBalance, TradeSummary balance, TradeDetailView, ProposeBar, ListRows, ListView, ProfileView, TradeSearchOverlay) inline `` `$${n.toFixed(2)}` ``. Inline copies render `$0.00` for null prices instead of `N/A` — most misleading on a proposal review. `countMissingPrices` (`priceService.ts:67-73`) exists but is unused outside one banner. **Fix:** adopt `formatPrice`; surface `countMissingPrices` on TradeSummary + ProposeBar + TradeDetailView. **Risk:** low · **Effort:** S · **Confidence:** medium-high.

### F4 — Five `relativeTime` reimplementations + 5 raw `toLocaleString` sites
Refactor agent said 4. Confirmed 5 helpers + 2 absolute formatters + 5 bare `toLocaleString`. Three helpers fall back at different thresholds (7d / 30d / never). Same event renders as "5d ago" / "Apr 26" / "4/26/2026, 3:14:22 PM" depending on view. **Fix:** N2's `src/utils/relativeTime.ts`. **Risk:** low · **Effort:** S · **Confidence:** high.

### F5 — Card name fallback inlined in 5 places (+2 in `/api`)
`cardBaseName(card)` (`variants.ts:202-204`) is the canonical helper. Inlined in `FamilyRow.tsx:88`, `ProfileView.tsx:492`, `ListView.tsx:410`, `SignalBuilderView.tsx:121`, `ListRows.tsx:87-88`. `HomeView.tsx:812` skips `displayName` entirely — unenriched cards matching swuapi still render the raw TCGPlayer suffix. **Fix:** replace inline copies with `cardBaseName`. **Risk:** low · **Effort:** XS · **Confidence:** high.

### F6 — Restriction-label divergence: editor vs read-only vs dedup key
Editor (`ListRows.tsx:65-70`): `'Any variant'` / `'Only X'` / `'X or Y'` / `'3 variants'`. Read-only (`ListView.tsx:417`, `ProfileView.tsx:495`): `'HS / SC'`. Dedup key (`useWants.ts:42-45`, `WantsPanel.tsx:87`): `Hyperspace|Showcase`. Same entry, three labels. **Fix:** `formatRestrictionLabel(r, mode)` next to `restrictionKey`. **Risk:** low · **Effort:** XS · **Confidence:** medium.

### F7 — Quantity glyph: prefix vs suffix inconsistency
`×{qty}` (majority) vs `{qty}×` (TradeDetailView, ProposeBar) vs `× {qty}` (TradeRow:300). Lower priority. **Fix:** pick `×{qty}`. **Risk:** low · **Effort:** XS · **Confidence:** medium.

## Lower-priority debt

- `SignalBuilderView.tsx:784`'s `~$` prefix is an undocumented estimate-marker.
- `CardResultsGrid.tsx:134` shows `setName` where every other tile-grid uses `setCode`.
- `HandlePickerDialog`'s `username || handle` for avatar `name` coexists with `@handle` — load-bearing but undocumented.
- `TradesHistoryView.tsx:675` derives avatar initial from `username`; everywhere else, from `handle`.
- `SessionSuggestions.tsx:218-220` shows `(Standard)` parens for non-Standard variants — out-of-band rendering with a `≠ 'Standard'` magic-string guard.
- ProposeBar/TradeDetailView snapshot lists use uppercase-tracking pills, visually distinct from the colored `<VariantBadge>` used elsewhere.

## Anti-recommendations

- `Trade with @handle` (breadcrumb) vs `with @handle` (timeline drawer) is intentional.
- `tradeCardKey` name fallback stays; recent fix is the key→productId Map at `SessionView.tsx:158-164`.
- `cardFamilyId` `::` separator stays. F1 flags the *pattern* of recovering data via `split`, not the separator.
- `'3 variants'` editor collapse at length ≥ 3 is deliberate readability — F6's helper should preserve count-collapse for long mode.
- `formatPrice` returning `'N/A'` (not `$0.00`) is the documented choice; F3 means *more* surfaces show `N/A`.
- `HandlePickerDialog`'s dual `@handle` + `username` is the documented "stable identity vs spoken name" pattern.
- `CommunityView.tsx:721-725` self-flags its slug-titlecase as a placeholder — comment is the spec for F1's fix.
- Two qty conventions (live-edit `×{qty}` vs read-only snapshot `{qty}×`) are *consistently* split. Only `TradeRow.tsx:300`'s `× {qty}` is unambiguous drift.
