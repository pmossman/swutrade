# 05 — Trade builder UI

Static review. React-hygiene + perf focus.

## High-impact findings

### 1. `TradeSide` is the prop-drilling hot spot — 24 props, two sibling instances
- **What:** App.tsx passes 24 props twice (769-824) into `<TradeSide>`. Six (`wants`, `available`, `sharedLists`, `filters`, `community*`, `setCards`) are identical both sides.
- **Where:** `src/App.tsx:769-824`, `src/components/TradeSide.tsx:22-109`.
- **Why:** `TradeSide` isn't `memo`'d. Every parent render — minute-tick (App.tsx:408-412), URL sync, intent change, any composer setState — propagates into both. Inner memos (`mineCards/theirsCards/overlapCards/communityCards/sourceChips`, lines 199-391) re-run on parent identity churn.
- **Fix:** Lift shared props (wants, available, sharedLists, community ids, filters) into a `TradeBuilderContext`. Wrap `TradeSide` in `React.memo`. Drops to ~10 side-specific props.
- **Risk:** medium · **Effort:** M · **Confidence:** high

### 2. `TradeSearchOverlay` is always-mounted, re-renders with both sides
- **What:** TradeSide.tsx:441-461 mounts `<TradeSearchOverlay>` unconditionally; only `open` toggles. Inside, useEffects fire each render and `browsePool`/`savedEntries` re-memo on cards-array churn (181-219).
- **Where:** `src/components/TradeSide.tsx:441`, `src/components/TradeSearchOverlay.tsx:107-300`.
- **Why:** Two hidden 8000-card pickers paying full render tax forever. Re-mount key (line 235) compounds: every seed change rebuilds the `useCardSearch` index and `ListCardPicker`'s `familyVariantsMap` (ListCardPicker.tsx:240-256).
- **Fix:** Lazy-mount on `overlayOpen`. Replace `key={seed-…}` with an imperative `setQuery` exposed by picker so seed changes don't blow away the index.
- **Risk:** low-medium · **Effort:** S · **Confidence:** high

### 3. `App.tsx` is 1235 LOC — routing + trade-builder in one file
- **What:** `App` owns view routing (482-607), the trade-builder render (`renderTradeBuilder`, 609-997), and inline `TradeViewToggle`/`ListsTriggerButton`/`TradeTabBar`/`TradeTab`/`AutoBalancePrimaryAction` (1039-1233).
- **Where:** `src/App.tsx`.
- **Why:** Every view's render goes through one function with all hooks/effects active even on Settings or Profile. `TradeViewToggle` was listed as its own file in this audit's scope — inlined in reality.
- **Fix:** Extract `renderTradeBuilder` into `TradeBuilderRoot.tsx`, move inline helpers, keep `App` thin. Confines Finding-1 churn to the trade view.
- **Risk:** medium · **Effort:** M · **Confidence:** high

### 4. `SearchResults.tsx` is dead code (72 lines)
- **What:** No imports outside its own file. Trade picker routes through `TradeSearchOverlay → ListCardPicker`.
- **Where:** `src/components/SearchResults.tsx`.
- **Why:** Maintenance trap; looks live to picker readers.
- **Fix:** Delete file.
- **Risk:** low · **Effort:** XS · **Confidence:** high

### 5. Card image landscape detection re-runs per tile mount
- **What:** `CardTile` (CardTile.tsx:67-73, 148-150) + `CardThumb` (TradeRow.tsx:28-69) keep state that fires on `onLoad`. Virtualized grids re-mount tiles as users scroll, so the same Luke leader detects again and again.
- **Where:** `src/components/CardTile.tsx:67-152`, `src/components/TradeRow.tsx:28-69`.
- **Why:** `isLeaderOrBaseGroup` is already known upstream (`CardResultsGrid.tsx:187`) and threaded as `landscape` prop. `TradeRow`'s caller passes nothing — always falls back.
- **Fix:** Thread `landscape` from the side panel using `cardType` lookup. Drop the `useState` fallback.
- **Risk:** low · **Effort:** S · **Confidence:** medium

## Lower-priority debt

- `TradeSide.tsx:155-187` destructures 23 props — split candidate: `TradeSidePanel` (chrome) vs `TradeSideController` (picker state + chip math).
- `calcTotal` inlined in three files (TradeBalance.tsx:19-24, TradeSummary.tsx:23-28, App.tsx:1117-1120). Lift to one util.
- `App.tsx:1039-1065` `TradeViewToggle` inline; audit plan expected own file.
- `PriceDataContext.tsx:20-22` `useEffect([priceData.loadAllSets])` depends on a hook-returned function — works only if `usePriceData` memoizes with `[]` deps.
- `TradeSearchOverlay.tsx:144-150` ESLint-disabled `seed` effect; `TradeSide.tsx:416-421` `autoOpenSharedLink` effect — both fine as one-shots but ref-guard would harden.
- `MobileActionsKebab.tsx:55` `imageUrl` rebuilds every render — `useMemo`-able.
- `ShareLiveTradeButton.tsx:83-86` reimplements `extractVariant`; `variants.ts:extractVariantLabel` is canonical.
- `useCardSearch.ts:257-266` "re-run when allCards changes" bypasses debounce. Could chunk if catalog grows.
- `Popover.tsx:80-90` portals to body but no edge-flip — right-aligned kebabs near viewport edge could clip.
- `TradeSummary.tsx:166-172` + `TradeSearchOverlay.tsx:164-174` both attach global ESC `keydown`. Concurrent open isn't reachable today; if it becomes so, ESC stacks.

## Anti-recommendations

- emerald/blue side colors + gold/amber/crimson balance palette across all trade-builder components is intentional invariant (sides vs balance state). Don't "consolidate to a generic accent token."
- `tradeCardKey` (types/index.ts:45-47) `productId || name` + `set` — name-fallback is legitimate for cards lacking productId. Don't tighten.
- `cardFamilyId` uses `::` separator + slug bodies use `-`; `SignalBuilderView.tsx:127` `familyId.split('::')[0]` IS sound. The hyphenated-set-slug qty-stepper fix referenced in the prompt doesn't point here.
- `setMinuteTick` (App.tsx:408-412) + `useTradeUrl` (App.tsx:417-424) cause frequent root-renders — root cause behind Finding 1's impact, but both are correct (minute-tick is cheap; URL-sync required for share links).
- `TradeSearchOverlay` always-mounted (TradeSide.tsx:441-461) keeps card index warm for instant first-open. Trade-off is intentional; Finding 2 challenges it only because the index work is heavy — verify via profile before flipping.
- `Popover` portals to body — load-bearing inside `overflow-hidden` ancestors. Don't downgrade.
- `TradeSearchOverlay`'s `key={seed-…}` re-mount (line 235) is a real perf pin but solves a real bug (initialQuery only firing on first open). Load-bearing until the imperative-setQuery fix from Finding 2 lands.
- Hover-reveal kebab (TradeRow.tsx:273, index.css:194-207) opacity-0 desktop / 0.7 touch is the correct pattern — touch fallback is in place.
