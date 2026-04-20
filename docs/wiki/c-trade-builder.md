# C — Trade builder + balance

> **Owner scope**
>
> The solo-mode "calculator" surface — two panels, a balance strip, the picker overlay, and the URL codec that makes any of it shareable. Specifically:
>
> UI — `src/App.tsx` (the `renderTradeBuilder()` body), `src/components/TradeSide.tsx`, `src/components/TradeRow.tsx`, `src/components/TradeBalance.tsx`, `src/components/TradeSummary.tsx`, `src/components/TradeSearchOverlay.tsx`, `src/components/AutoBalanceBanner.tsx`, `src/components/CardTile.tsx`, `src/components/CardResultsGrid.tsx`, `src/components/SearchResults.tsx`, `src/components/PanelDivider.tsx`, `src/components/ShareButtons.tsx`, `src/components/ShareLiveTradeButton.tsx`, `src/components/ClearAllButton.tsx`, `src/components/MobileActionsKebab.tsx`, `src/components/VariantBadge.tsx`, `src/components/SelectionFilterBar.tsx`, `src/components/SetFilter.tsx`, `src/components/CollapsibleChipFilter.tsx`, `src/components/PriceSlider.tsx`, `src/components/PriceModeToggle.tsx`, `src/components/KebabMenu.tsx`, `src/components/Popover.tsx`, `src/components/TradeImageModal.tsx`.
>
> State + codec — `src/hooks/useTradeUrl.ts`, `src/hooks/useTradeIntent.ts`, `src/hooks/useTradeViewMode.ts`, `src/hooks/useCardSearch.ts`, `src/urlCodec.ts`, `src/applySelectionFilters.ts`, `src/utils/forceBalance.ts`, `src/utils/matchmaker.ts`, `src/utils/filterSummaries.ts`, `src/services/tradeActions.ts` (the *send* path used from `TradeSummary`; the server-side lifecycle is B's).
>
> Tests — `src/urlCodec.test.ts`, `src/applySelectionFilters.test.ts`, `src/utils/forceBalance.test.ts`, `src/utils/matchmaker.test.ts`, `src/hooks/useTradeIntent.test.ts`, `src/hooks/useCardSearch.test.ts`, `e2e/trade-flow.spec.ts`, `e2e/swap-variant.spec.ts`, `e2e/search.spec.ts`, `e2e/matchmaker.auth.spec.ts`, `e2e/mobile.spec.ts`.

## Overview

The trade builder is the app's single most-used surface: two side-by-side panels (Offering / Receiving), a running-balance strip at the bottom, and a full-screen card picker. Every other view in the app either *feeds* this one (Home CTA, profile "Start a trade", shared-list landing, proposal Edit/Counter) or *consumes the output* (Summary, Save, Propose, Share-to-Discord, Session). One sentence: **all trade UX in SWUTrade flows through two panels plus a balance strip, with the URL carrying the cards and pricing state so any click-target can deep-link back into the exact calculator state.**

The builder is the root view for signed-out users (no Home to return to) and one of several views for signed-in users, toggled via `?view=trade`. It's mounted unconditionally inside `App.tsx`, not a route — the entire app's body renders inside one React tree with `viewMode` switching content, so the builder's internal state (cards, pricing) survives navigation to/from Community, Settings, Profile, etc. without unmount.

## Key concepts / glossary

- **Offering side** — `yourCards`, emerald accent. "What you give up." The left panel (desktop) / top panel (mobile). **Load-bearing invariant** — see the [SWU design invariants](../../.claude/projects/-Users-parker-code-swutrade/memory/project_swutrade_invariants.md) memo; emerald = you-giving is hardcoded across the app (ProposeBar, CounterBar, session views, summary tiles, OG image). Do not change.
- **Receiving side** — `theirCards`, blue accent. "What you get." The right / bottom panel. Same invariant: blue = you-getting, everywhere.
- **Balance tone** — gold (neutral / balanced), amber (disturbance), crimson (chaos). Reserved for the balance strip and nothing else; see `src/utils/forceBalance.ts:124` (`balanceChrome`).
- **Favored direction** — `BalanceFavored` = `'you' | 'them' | 'none'`. Computed in `src/utils/forceBalance.ts:57` — `'them'` means **the trade tilts toward the counterpart** (you're offering more than receiving). Inverted from the raw diff sign because "your total" is what you're giving up.
- **Tiers** — `empty → balanced → ripple → disturbance → chaos`, with absolute-dollar floors so a $2 gap can't escalate into "great disturbance" language. See `src/utils/forceBalance.ts:67-82`.
- **URL codec** — `y=...` encodes offering, `t=...` encodes receiving; `pct=` + `pm=` encode the pricing knobs. Card-codec keys are `['y', 't', 'pct', 'pm']` — exported as `TRADE_CODEC_KEYS` from `src/routing/config.ts:40` and consumed by `useTradeUrl` as the set of params it owns.
- **Trade intent** — the five `?propose=/?from=/?counter=/?edit=/?autoBalance=` URL signals that tell the builder to mount a composer bar (or the AutoBalanceBanner). Owned by `useTradeIntent` (`src/hooks/useTradeIntent.ts`).
- **Source chips** — the picker's scope filter. Four kinds: `mine` (your own list), `theirs` (counterpart's list), `overlap` (intersection), `community` (guild rollup). See `src/components/TradeSide.tsx:323-362`.
- **Family / productId** — family = base card identity across prints (e.g. "Luke, Hero of Yavin"); productId = one specific printing (Standard vs Hyperspace vs Showcase). Wants are family-scoped with a variant restriction; Available is productId-scoped. The picker / matchmaker bridge the two.
- **PricingContext** — shared `{ percentage, priceMode, setPercentage, setPriceMode }` state with localStorage persistence. Imported wherever a price is rendered — TradeBalance, TradeSummary, TradeRow, CardTile, etc. The URL codec also reads/writes these two values (see "Pricing state" below).

## File map

### UI — trade builder body

**`src/App.tsx`** — Root component. Hosts `yourCards` / `theirCards` state (`App.tsx:87-88`), mounts the mutex bar (Edit / Counter / Propose / AutoBalanceBanner at lines `575-624`), both `TradeSide` panels, the `TradeBalance` strip, the summary modal, the footer, and the view-level action strip (toggle / Share / Clear). Also defines `TradeViewToggle` + `TradeTabBar` at the bottom of the same file.

**`src/components/TradeSide.tsx`** — One panel. Owns its own card list and the search overlay; computes source-chip pools (mine / theirs / overlap / community), the saber-bar accent on the left edge, the collapse chevron, and the Add-Card footer. Threaded by `App.tsx` with accent color, cards array, qty/remove handlers, and context (`sharedLists`, community rollup, `autoScopeToTheirs`, `counterpartHandle`).

**`src/components/TradeRow.tsx`** — One row inside a panel. CardThumb (adaptive portrait/landscape detection on image load) + base name + VariantBadge + per-row spread badge + qty stepper + kebab. `readOnly` collapses to a static `× N` badge for session terminal states.

**`src/components/TradeBalance.tsx`** — The running-balance strip. Reads totals via `calcTotal` (`TradeBalance.tsx:19-24`), derives tier+chrome from `computeBalance` + `balanceChrome`, shows inline PriceModeToggle + PriceSlider, surfaces the "Ask for $X" / "Offer $X" action line and the "View full summary" CTA that opens `TradeSummary`.

**`src/components/TradeSummary.tsx`** — Modal receipt overlay. Re-uses the Offering/Receiving split as tile grids with card art, pricing pill + Share pills in the header, and a "Save this trade" + "Send as proposal" action row. Send-as-proposal hands off via the URL codec + `?propose=<handle>` (no server call, full-page nav, see `handleProposeTo` at `TradeSummary.tsx:159-164`).

**`src/components/TradeSearchOverlay.tsx`** — Full-screen card picker. Owns its own `useCardSearch`, chip state, filter-drawer open/close state, and seed consumption (pre-fill query or activate chips from the parent). Mounts `SearchResults` (the tile grid).

**`src/components/AutoBalanceBanner.tsx`** — The "Trade with @X" banner that surfaces only on `?from=<handle>` for signed-in users. Fetches the sender's public profile once, derives a speculative `computeMatch` result, shows "You could offer / receive N cards" with a Load-trade button. When `?autoBalance=1` is also present, auto-applies the result and strips the param from the URL so reloads don't re-fire.

**`src/components/CardTile.tsx`** — One tile inside the picker grid. Whole tile is the add-button; hover-revealed decrement button lives on the qty badge. Spread badge ("Δ25%") only appears when **both** ratio ≥25% AND dollar-gap ≥$0.50 — see `CardTile.tsx:65` for the why.

**`src/components/SearchResults.tsx`** — Thin wrapper that binds `CardResultsGrid` to the trade context (threads `tradeCards` so tiles know their current qty; wires the decrement path to onRemove when qty=1).

**`src/components/CardResultsGrid.tsx`** — Virtualized / flex-grid renderer of `SetSearchGroup[]`. Leader / base groups get a landscape aspect via the grid's per-group column count; non-leader groups render 5:7 portrait.

**`src/components/PanelDivider.tsx`** — Mobile-only drag handle between the two panels. Pointer capture + clamp [0.15, 0.85]. Emits ratio to `App.tsx`, which passes it to each `TradeSide` as `flexBasis`.

**`src/components/ShareButtons.tsx`** — The "Link" + "Image" pills in the action strip. Link copies the current URL (stamps `?from=<your-handle>` if signed in). Image opens `TradeImageModal` pointed at `/api/og?...`.

**`src/components/ShareLiveTradeButton.tsx`** — "Invite someone" button (cyan). POSTs `/api/sessions/create-open` with current cards seeded into both halves, navigates to `/s/<id>`. Works for anonymous users (the endpoint mints a ghost user). Session lifecycle lives in a-sessions.

**`src/components/ClearAllButton.tsx`** — Two-click "Clear all" with a 3-second auto-disarm. First tap turns red + asks "Clear?"; second confirms. Disarms on blur too.

**`src/components/MobileActionsKebab.tsx`** — Overflow menu on mobile (Link / Image / Clear). Replaces the desktop pill row in the action strip and in the summary header.

**`src/components/VariantBadge.tsx`** — The colored pill identifying a card's print variant. Renders nothing for Standard (implicit baseline). Title-attribute hovers carry a one-line variant explainer.

**`src/components/SelectionFilterBar.tsx`** — Variant + Set chip rows inside the picker's filter drawer. Pure presentational; hook state comes from `useSelectionFilters`.

**`src/components/SetFilter.tsx`**, **`src/components/CollapsibleChipFilter.tsx`** — Primitives the filter bar composes out of.

**`src/components/PriceSlider.tsx`**, **`src/components/PriceModeToggle.tsx`** — The TCG % preset grid and the Market/Low 2-button toggle. Both read + write PricingContext directly via their hosting parent (TradeBalance, TradeSummary).

**`src/components/KebabMenu.tsx`**, **`src/components/Popover.tsx`** — UI primitives. KebabMenu is used on trade rows + mobile action overflow; Popover is the PriceSlider's positioning host.

**`src/components/TradeImageModal.tsx`** — Full-screen preview of the OG image endpoint. Uses `window.location.search` as the querystring for `/api/og`, so the image reflects exactly what the user sees.

### State + codec

**`src/hooks/useTradeUrl.ts`** — The two-way binder between `(yourCards, theirCards, pct, pm)` and the URL. On mount, parses the URL, seeds the React state from `y=` / `t=` refs (deferred until `allCards` loads — see `pendingRef`). On state change, rewrites `y=` / `t=` / `pct=` / `pm=` while **preserving all unknown params** (the merge at lines 99-107 — this is the 2026-04-17 bugfix; previously it replaced the whole search string and dropped `?propose` + `?from` on every card add).

**`src/hooks/useTradeIntent.ts`** — Unified `?propose=/?from=/?counter=/?edit=/?autoBalance=` store. Replaces five earlier separately-lazy-init hooks that each silently ignored pushState (see the note at `useTradeIntent.ts:7-14` and commit `aeb0aa2`). Seeds from URL, re-syncs on popstate, mirrors from `nav` helpers in `App.tsx:267-341` on in-app navigation.

**`src/hooks/useTradeViewMode.ts`** — Per-device split-vs-tabbed toggle. localStorage key `swu.tradeView`. Cross-tab storage-event sync included. Deliberately NOT synced to the server profile — a phone's tabbed preference shouldn't change the desktop view.

**`src/hooks/useCardSearch.ts`** — Picker search. `parseQuery` extracts set-code aliases and variant keywords; `localSearch` runs a name + set + variant filter; `browseAllGroups` is the no-query catalog mode. Leader / base groups always sink to the bottom of each set — see the test `src/hooks/useCardSearch.test.ts:117-128` for why (leader card art eats scroll real estate).

**`src/urlCodec.ts`** — Pure encode/decode for the trade-codec params (`y` / `t` / `pct` / `pm`) plus the shared-list params (`w` / `a`). Cards encode as `productId.qty[,productId.qty,…]`. Shared-list params are `deflateSync`-compressed and prefixed with `~` so the decoder can distinguish them from legacy uncompressed encodings.

**`src/applySelectionFilters.ts`** — Takes `SetSearchGroup[]` and a selected-sets + selected-variants pair; returns a filtered shape. Positive-selection model: an empty array means "allow all". Drops set-groups whose groups all got filtered out so the grid doesn't render empty sections.

**`src/utils/forceBalance.ts`** — `computeBalance(yourTotal, theirTotal, isEmpty) → BalanceState` — pure function, the whole balance-banner shape comes out of here. Also exports `balanceChrome(tone)` which maps the tone to Tailwind classes (gold/amber/crimson — see palette invariant).

**`src/utils/matchmaker.ts`** — Subset-sum matchmaker with two modes (`minimize-imbalance`, `maximize-priorities`). Pools capped at `SUBSET_SEARCH_CAP = 16` (`matchmaker.ts:55`), truncated priority-first then price-desc. Rewrite history: greedy → subset-sum in commit `d48efb3` (2026-04-17) after a $4-vs-$15 case in dogfooding produced a locally-greedy bad balance.

**`src/utils/filterSummaries.ts`** — `summarizeSelection(array, noneLabel, format?)` — shared "N selected" / "a, b, c" / full-label formatter used by both the picker's compact filter summary and the persistent filter bar.

**`src/services/tradeActions.ts`** — Stateless POST helpers (`cancelProposal`, `acceptProposal`, `declineProposal`, `nudgeProposal`, `promoteProposalToShared`, `bulkResolveProposals`). The builder calls NONE of these directly — TradeSummary sends proposals via a full-page navigation to `/?propose=<handle>&y=...` which the receiving load mounts ProposeBar, which calls through `useComposerBar`. The send path that *does* use `/api/trades` directly is TradeSummary's "Save this trade" (see `TradeSummary.tsx:182-210`), which is a personal save, not a proposal. Proposal send + lifecycle lives in b-proposals.

## Data model

The builder's runtime state is tiny and entirely in-memory:

```ts
// src/App.tsx:87-88
yourCards: TradeCard[]
theirCards: TradeCard[]

// TradeCard (src/types.ts)
interface TradeCard { card: CardVariant; qty: number }
```

`CardVariant` is the per-printing shape loaded from the pricing feed (h-cards-pricing). A `TradeCard` holds a specific printing plus an integer 1–99 qty — quantities above 99 are clamped in both the URL decoder (`urlCodec.ts:255-259`) and the `changeQty` handler (`App.tsx:386`).

### Non-obvious invariants

- **Dedup key** — `tradeCardKey(card)` is `productId` if present, else a synthesized name-based fallback. Adding a card that's already in the trade bumps its qty (`App.tsx:367-380`).
- **Qty bounds** — URL: `[1, 99]`. Runtime stepper: decrement at qty=1 routes to remove (`TradeRow.tsx:263`), increment caps at 99 (`App.tsx:386`). The two paths have to agree.
- **Price nulls are NOT zero** — a missing price stays `null` through the reducer and is loudly flagged (red border + icon) in the row, not silently added as $0. `countMissingPrices` aggregates the badge that appears in TradeBalance + TradeSummary.
- **Zero-card-on-one-side trades are legal** — pure-cash trades (e.g. "you give me $20, I hand you nothing" or vice versa) work end-to-end: the summary renders, the OG image handles the empty side, and a proposal can carry one empty side. The AutoBalanceBanner and various "no cards yet" empty states exist so the user isn't stranded, but nothing gates on "both sides populated".

### URL-codec shapes

```
?y=<pid>.<qty>,<pid>.<qty>,…    Offering
?t=<pid>.<qty>,…                Receiving
?pct=<1..100>                    Percentage slider
?pm=m|l                          Price mode (m=market, l=low)
```

`pct` + `pm` are **omitted on bare URLs when at defaults** (80% / market) so the clean URL stays clean; they're **always** emitted when there's a trade so share links carry the sharer's intent (don't pick up the receiver's persisted prefs). See `urlCodec.ts:86-98`.

The `w` / `a` list-codec params are owned by `d-lists` but decoded side-by-side here because `useTradeUrl` runs in the same container — that's purely a host convenience, not a semantic coupling.

### Persistence keys

- `swu.trade.selVariants` / `swu.trade.selSets` — the picker's variant/set selection, shared between Offering and Receiving via one `useSelectionFilters` instance (`App.tsx:119-122`). Sessions use the **same** keys (`SessionView.tsx:56-57`) — the picker feels like one tool, so its selection state is shared across contexts.
- `swu.tradeView` — split vs tabbed. Local-only, see "Key concepts."
- PricingContext owns its own keys (`h-cards-pricing` territory).

## Public surface

The builder is a leaf of `App`, not an area with external consumers — the only "public surface" is the URL it reads + writes.

### URL surface (read/written)

- **Trade codec** — `y`, `t`, `pct`, `pm`. Owned by `useTradeUrl`; round-tripped through `src/urlCodec.ts`.
- **Trade intent** — `propose`, `from`, `counter`, `edit`, `autoBalance`. Owned by `useTradeIntent`; read by the mutex-bar switch in `App.tsx:575-624`.
- **View flag** — `view=trade|list|home|...`. Owned by routing/config; read by `detectViewMode` in `App.tsx:166`.

### Components used by other areas

Other areas import these three of ours directly:

- **`<TradeSide readOnly>`** — `SessionView` (a-sessions) mounts it with `readOnly` + `readOnlyEmptyLabel` for terminal-state session canvases. The prop hides the qty stepper, the kebab, the Add-Card footer, and the search overlay; it renders `× N` qty badges in a static, muted tone. See `TradeSide.tsx:85-91` for the prop contract.
- **`<TradeBalance>`** — Also mounted by `SessionView` as the running balance for the shared canvas. Works on any `{ yourCards, theirCards }` pair.
- **`<TradeSummary>`** — Trade-detail view uses its tile layout for completed proposals. (Save action hides when the trade isn't in the signed-in user's history.)

### Exports (pure functions)

- `buildTradeSearch(state) / parseTradeUrl(search)` — the top-level encode/decode. Called by `useTradeUrl`, and by `TradeSummary` for the send-as-proposal hand-off.
- `computeBalance / balanceChrome` — used by TradeBalance + TradeSummary (+ SessionView for the session canvas).
- `computeMatch` — the matchmaker. Called by AutoBalanceBanner, ProposeBar (b-proposals area). Two-mode `MatchMode` flag.
- `applySelectionFilters` — called by TradeSearchOverlay and by ListView (d-lists).

## State + data flow

### Happy path: user adds a card

1. User taps a tile in the picker → `CardTile.handleAdd` → `onAdd(card)` prop → `SearchResults` → `TradeSearchOverlay.onAdd` prop → `TradeSide`'s `onAdd` prop → `App.handleAddYour` (or `handleAddTheir`).
2. `handleAddYour` is `addCard(setYourCards)` — a memoized updater (`App.tsx:367-380`) that either bumps the existing `TradeCard.qty` or appends `{ card, qty: 1 }`.
3. React re-renders. Downstream:
   - `TradeSide` recomputes its source-chip pools (they're qty-aware and subtract in-trade copies — `TradeSide.tsx:170-221`), the total, the thumbnail size.
   - `TradeBalance` recomputes `computeBalance()` + chrome, re-picks tone/tier, re-renders headline + action line.
   - `useTradeUrl`'s URL-sync effect fires (`useTradeUrl.ts:69-133`), calls `buildTradeSearch`, MERGES the result into the current URL search (preserving `propose`, `from`, etc.), and either `pushState`s (new history entry) or `replaceState`s (if `suppressPushRef` was set — initial load, URL-round-trip). Pending-cards guard prevents rewriting the URL before the async resolve has completed (`useTradeUrl.ts:114-120`).

### Mount-time URL restore

1. On mount, `useTradeUrl` parses the search and stores pending productId refs in `pendingRef`. It also applies `pct`/`pm` to state directly (raw setters, so localStorage isn't overwritten).
2. `suppressPushRef = true` marks the next URL-sync as a replace, not a push.
3. When `allCards` (the pricing feed) arrives, the second effect resolves `productId → CardVariant` via `buildCardMap`, calls `setYourCards` + `setTheirCards`, and nulls `pendingRef` once every ref resolved.
4. A URL with unresolvable productIds (e.g. a share from a future set the receiver hasn't loaded) silently drops the unresolved refs — the resolved ones still land, and `pendingRef` stays set so the URL isn't rewritten to strip the lost productIds prematurely.

### Mount-time intent seeding

`useTradeIntent` is completely separate from `useTradeUrl`. On mount it parses the **same** URL search independently for the five intent params, re-syncs on `popstate`, and exposes an imperative `setIntent` for in-app pushState navigation to mirror URL writes into state. The two hooks' responsibilities don't overlap — trade codec vs trade intent — but they both consume the same URL, and both write back to it. `useTradeUrl` **only owns** `TRADE_CODEC_KEYS` and passes every other param through untouched; that's the fix from `a1baace` (2026-04-17).

### Propose mode (from the builder's perspective)

1. User navigates to `/?propose=alice` — either by typing the URL, landing from Home's HandlePicker, or via the Summary's "Send as proposal" button.
2. `App` mounts. `useTradeIntent` seeds `intent.propose = 'alice'`. The mutex-bar switch (`App.tsx:575-624`) renders `<ProposeBar>` instead of `<AutoBalanceBanner>`.
3. `useRecipientProfile('alice')` fetches Alice's public lists once (`App.tsx:140`). Both `ProposeBar` (for Suggest + status hint) and `TradeSide` (for the source chips' `theirs` + `overlap` pools) read the same snapshot via `effectiveSharedLists` — no double fetch.
4. In this mode `autoScopeToTheirs = true` (`App.tsx:668`). When the user opens the picker, `openOverlay` auto-activates the `overlap` chip if it has cards, falling back to `theirs` — so the first thing a proposer sees is the intersection pool, not the full catalog (`TradeSide.tsx:369-375`).
5. User clicks cards → adds via the usual onAdd path → cards land in `yourCards` / `theirCards` → URL carries `y=...&t=...&propose=alice`.
6. User clicks Send in ProposeBar (b-proposals territory). ProposeBar POSTs `/api/trades` with the snapshot; on success, navigates away from the builder.

ProposeBar is a b-proposals component; the builder only knows it's there because `App.tsx:595-608` mounts it in the mutex slot when `proposeHandle` is non-null.

### AutoBalanceBanner flow

Triggered only when **all of** the following hold:
- signed-in user (`isSignedIn`),
- `?from=<handle>` present,
- no cards already in the trade (`!hasCards`), OR the banner has already applied a match,
- no `?propose` / `?counter` / `?edit` in the URL (those activate their own composer bar and displace this one).

Behaviour (`AutoBalanceBanner.tsx`):
1. Reset all internal state when `senderHandle` changes (`useEffect` at `AutoBalanceBanner.tsx:80-87`).
2. Fetch `/api/user/<handle>` once per sender. `fetchStartedRef` dedupes against the useEffect-with-state-in-deps cleanup trap (see the note at lines 72-77 for the prior bug).
3. `preview` is a `useMemo` over `computeMatch(my wants, my available, their wants, their available, allCards, priceMode, pct)`. Recomputes cheaply when lists or knobs shift.
4. If `autoBalanceRequested` was true at mount AND the preview is non-empty, auto-apply exactly once: set both sides from the match, scrub `?autoBalance=1` from the URL via `replaceState` so reloads/shares stay clean, call `onAutoBalanceConsumed` to clear the intent store.
5. Otherwise show the preview ("You could offer 3, receive 2") with a "Load trade" button.
6. Dismissable per sender via the x; `dismissed=true` bails the effect chain.

The `data-state` attribute on the banner's outer div (`AutoBalanceBanner.tsx:237-250`) exposes internal state for traces and future e2e tests — kept deliberately after a flaky-test debugging session.

### View-mode transitions

Split → tabbed toggling swaps the panel container (`App.tsx:642-758`). Split mode: two `TradeSide`s side-by-side (desktop) or stacked with `PanelDivider` + collapse chevrons (mobile). Tabbed mode: a `TradeTabBar` (running count + $ for the hidden side) at top + ONE `TradeSide` below with `headerless` (so the in-panel label + count + total don't duplicate the tab's content — see `TradeSide.tsx:77-81`). Toggling doesn't reset `activeTradeTab`; the user keeps their current focus.

## UI/UX patterns

### Color reservation

Strict, documented in the [SWU design invariants](../../.claude/projects/-Users-parker-code-swutrade/memory/project_swutrade_invariants.md):

- **Emerald = Offering** (everywhere — side headers, saber bars, totals pill, proposer-side summary tiles, OG image left column).
- **Blue = Receiving** (same — everywhere).
- **Gold / amber / crimson = balance tone** (exclusively). Balance headline / action line / banner glow. Never used for sides.
- **Cyan** is the "live session" / "invite" color (`ShareLiveTradeButton.tsx:62`). Don't reuse it for builder chrome.

### Saber bar

Every trade panel and every summary panel renders a 3px left-edge gradient bar — bright core → muted tail with a soft glow, mimicking a lightsaber blade. Tint matches the side's accent. See `TradeSide.tsx:102-105`, `TradeSummary.tsx:104-106`.

### Mobile vs desktop

- **Desktop (md+)**: side-by-side panels, inline Share/Clear pills, no collapse chevrons, no drag handle, no mobile kebab.
- **Mobile**: stacked panels with per-panel collapse chevron (colored to match the side's accent — `TradeSide.tsx:109-112`), draggable `PanelDivider` between them, `splitRatio` state in `App.tsx:106`, kebab for Link/Image/Clear, PriceSlider popover that also carries the Market/Low toggle (`PriceSlider.tsx:66-73`) since the inline toggle can shed on narrow viewports.
- **Thumbnail sizing**: `TradeSide.tsx:117-127` picks size by count — mobile caps at `md` even at 1 card because `lg` would eat too much viewport.
- **Balance banner**: default-collapsed on mobile (`App.tsx:108-113`) to give the card lists vertical breathing room; expands on tap.
- **Action strip** (`App.tsx:534-548`): "Invite someone" is always visible; Share/Clear show only when there are cards.

Mobile and desktop are both first-class surfaces — mobile gets priority attention only because it's harder to get right, not because desktop is secondary (per feedback memo).

### Picker overlay

Full-screen over the builder (`inset-0`). Header zone: saber accent + "Adding to <side>" + counterpart context ("for @alice") when in propose/shared-list mode + Done button tinted the side's color. Search input beneath. **Collapsed filter-summary button** (`TradeSearchOverlay.tsx:402-461`) shows "Overlap (3) · Hyperspace · All sets" — one compact row that expands on tap to the full source-chips + SelectionFilterBar. Beta feedback: multiple always-visible filter rows felt overloaded.

The overlay's DOM stays mounted while closed (for the fade/translate transition — see `TradeSearchOverlay.tsx:241-246`). The "Picked so far" summary line is gated on `open` because strict-mode Playwright locators matching a qty digit would otherwise find both the hidden overlay text AND the visible panel row (`TradeSearchOverlay.tsx:261-265`).

Results render via `deferredResults = useDeferredValue(filteredResults)` so chrome paints before hundreds of browse tiles fill the grid.

### Source-chip semantics

Computed in `TradeSide.tsx:170-362`:

- **`mine`** — the viewer's own list. Offering side: their `available`. Receiving side: their `wants` (projected to a pickable card via `bestMatchForWant`).
- **`theirs`** — counterpart's list from `effectiveSharedLists`. Offering side: counterpart's `wants`. Receiving side: counterpart's `available`. No counterpart context → chip hidden.
- **`overlap`** — the intersection of `mine` and `theirs`, respecting `matchesRestriction`. Always visible (`alwaysVisible: true`) when there's a counterpart context, **even at count 0** — "0" is itself a useful signal ("no match pool, go look at 'They want' to discover what to source"). Labels are side-specific ("Their wants you have" / "Yours they have") — plain-English labels beat jargon, and the "Overlap" term was confusing first-time users.
- **`community`** — Phase 4 rollup (signed-in users in enrolled guilds). Hidden entirely when in propose / shared-list context because the user is already zoomed in on one counterpart.

All pools are **qty-aware** — a card already added to the trade subtracts from the pool, so chips visibly drain as the user builds the trade. Pool empty → chip auto-hides (except `overlap.alwaysVisible`). Active-but-now-empty chips auto-deactivate (`TradeSearchOverlay.tsx:140-147`) so the grid doesn't get stuck on an empty source while nothing's selected.

### Pricing controls

PriceModeToggle (Market/Low) + PriceSlider (50/60/70/80/90/100%). The slider is a popover — tap the pill, get a 3x2 (mobile) / 6x1 (desktop) preset grid. PricingContext owns persistence; `useTradeUrl` serializes the current value when there's a trade, so share links carry the sharer's intent. Both knobs live inside TradeBalance's body (`TradeBalance.tsx:200-209`) and TradeSummary's header (`TradeSummary.tsx:240-246`) — intentionally adjacent to the totals they modify so the cause/effect loop is visible.

`adjustPrice(getCardPrice(card, mode), pct)` is the canonical application (`src/services/priceService.ts`). Called from TradeRow, CardTile, TradeBalance, TradeSummary, matchmaker, forceBalance — every price on screen routes through the same pair.

### Balance strip chrome

- **Empty** — quiet "Trade balance" label in muted gray, no glow. Deliberately recessive; the ProposeBar or AutoBalanceBanner above is the primary CTA in that state, and two gold-tinted display-font bars fighting for attention made the page feel unfocused (`TradeBalance.tsx:141-143`, `forceBalance.ts:34-48`).
- **Populated** — full swu-display drama: headline ("A disturbance in the Force"), action line ("Ask for $12.50 more — cards or cash"), totals pill (emerald / blue), pricing controls, missing-price warning if any, "View full summary" CTA.
- **Chaos tier** adds `animate-pulse-crimson` — a slow, low-intensity pulse to make lopsided trades visible at a glance without being alarmist.
- **Favored direction → verb**: if the trade tilts toward **them** (you're offering more), the action line reads "Ask for $X more"; if it tilts toward **you**, "Offer $X more". The "or settle in cash" framing existed in earlier copy and was kept in the propose path — users didn't realize cash was a valid balancing tool without it.

## The four-bar mutex

One horizontal strip between the action row and the trade panels. Exactly one of the following renders at a time:

| Condition | Component | Role |
|-----------|-----------|------|
| `editId` | `<EditBar editingTradeId={editId} …>` | Amend a pending outbound proposal |
| `counterId` | `<CounterBar originalTradeId={counterId} …>` | Counter an inbound proposal |
| `proposeHandle` | `<ProposeBar recipientHandle={proposeHandle} …>` | Compose a new outbound proposal |
| *(else)* | `<AutoBalanceBanner senderHandle={from} autoBalanceRequested={autoBalance} …>` | "Trade with @X" suggestion / auto-balance |

See `App.tsx:575-624`. The first three are b-proposals components; the fourth is ours.

### Tech debt — UX-A2

The audit flagged this as **UX-A2: collapse into one TradeContextStrip**. Each bar currently has its own card, its own copy, its own layout rules, and its own mount/unmount lifecycle. Users who navigate Propose → Counter → Edit see three different-sized strips with slightly different affordances. Planned consolidation: one strip that reads the current intent and renders the appropriate controls + copy inline. Queued in `NEXT.md`; no ETA.

## Tech debt + known gaps

### Four-bar mutex (UX-A2)

Described above. The mutex logic itself is clean (the conditional in `App.tsx:575-624` is explicit), but the four distinct components produce visual and interaction churn.

### Pending-cards URL flicker edge case

When a shared URL references productIds that the current pricing feed hasn't loaded yet, `useTradeUrl` waits (pendingRef guards the URL rewrite at `useTradeUrl.ts:114-120`). If the feed **never** resolves a particular productId (unknown card, dataset regression), the pending ref stays non-null forever for that one ref, but `allResolved` at `useTradeUrl.ts:59-64` is gated on the whole set — so one unresolvable card wedges the URL sync indefinitely until another event clears `pendingRef`. In practice this is rare (all shipped sets are in the feed), but the guard is strict-all, not any.

### Matchmaker pool cap

`SUBSET_SEARCH_CAP = 16` (`matchmaker.ts:55`). Pools larger than 16 get truncated priority-first then price-desc, dropping the long-tail cheap cards. For most users' lists this is fine, but a power-user with 100+ available cards matching a single counterpart's wants will not see the long tail considered for balance. The tail doesn't matter much for price (cheap cards are cheap) but it matters for quantity — a player wanting to move 30 bulk commons in one trade can't with this matchmaker. Documented in the file header (`matchmaker.ts:50-54`).

### Single `readOnly` escape hatch

`TradeSide.readOnly` was added for Phase 5b (SessionView). It hides the picker, qty stepper, kebab, and Add footer. That's four separate collapse rules expressed as one prop — fine today, but if a future mode needs "read-only except the kebab still shows View on TCGPlayer", this prop will need to split. `readOnly` is referenced in `TradeSide.tsx:156-158`, `TradeRow.tsx:114-116`, `TradeRow.tsx:250-283`.

### Textarea cramping — resolved

The ProposeBar send-confirm textarea was cramped in an earlier iteration; now 5 rows with `resize-y` and a 100px min-height (`ProposeBar.tsx:535-537`). Called out in the composer-UX audit as CU4; fix shipped. Keep the 5-row minimum when refactoring the composer.

### AutoBalanceBanner fetch-start ref

`fetchStartedRef` exists to work around a useEffect-with-state-in-deps trap (see `AutoBalanceBanner.tsx:72-77`). Reliable today, but the fact that we need a ref for a single-fire pattern points at a state-machine shape that's more complex than it looks. A future refactor should consider moving to a query library (SWR / TanStack Query) or a dedicated state machine rather than hand-rolled refs.

### Picker filter persistence shared across contexts

`tradeSelVariants` / `tradeSelSets` are **the same** localStorage keys in App and SessionView (`App.tsx:119-122` + `SessionView.tsx:56-57`). This is deliberate — "the picker feels like one tool" — but it does mean a user who set narrow filters for a calculator trade carries those filters into a shared session, sometimes surprisingly. `handleStartTrade` (`App.tsx:242`) calls `filters.clearAll()` exactly once, on the profile → trade hand-off, to prevent stranding a user in a "no matches" view. No other entry point clears filters.

### Overlay DOM stays mounted when closed

`TradeSearchOverlay` keeps its DOM when `open=false` for the fade+translate transition (`TradeSearchOverlay.tsx:241-245`). The "Picked so far" summary is gated on `open` as a guard against strict-mode Playwright matchers; if anyone adds a **new** text node to the overlay body, they need to remember the same guard or add one test at a time until CI complains.

### No keyboard shortcuts

The builder is pure-click / pure-tap. No hotkeys to add-card, flip sides, toggle split/tabbed. Deliberate for now (trading-card audience skews mobile), but calls for attention if we pick up power users.

## Decisions worth remembering

### URL codec owns trade state, localStorage owns preferences

Cards + qty live in the URL. Pricing knobs (pct / pm) live in **both** URL and localStorage with the URL authoritative when present — `useTradeUrl` reads URL values on mount and only falls back to persisted localStorage when the URL doesn't specify (`useTradeUrl.ts:37-38`). Rationale: a share link MUST carry the sharer's intended pct / pm (otherwise the receiver sees different numbers), but a bare URL SHOULD inherit the receiver's own persisted prefs. The "emit pct/pm only when non-default or when there's a trade" rule at `urlCodec.ts:92-96` implements both sides of this.

### Preserve unknown URL params (2026-04-17)

Originally `useTradeUrl` replaced the whole search string with the trade codec output on every state change. That silently dropped `?propose`, `?from`, `?counter`, `?edit`, `?profile`, `?view`, etc. on every card add. Within a single session the lazy-init hooks cushioned the failure (stale capture of intent at mount), but reload lost everything. Fix (commit `a1baace`): merge trade-codec keys into the existing URLSearchParams while passing every other key through untouched. The `TRADE_CODEC_KEYS` tuple in `routing/config.ts:40` is the single source of truth for "what keys does `useTradeUrl` own."

### Subset-sum matchmaker with two modes (2026-04-17)

Greedy matchmaker produced a locally-greedy bad balance on small skewed pools (a real $4-vs-$15 dogfood case). Replaced with subset-sum (commit `d48efb3`) over both pools' subsets, scoring by `imbalance → card count → priority count`. The second mode (`maximize-priorities`) force-includes every priority-starred overlap card; non-priority cards only land if they improve or preserve balance. Rationale: two distinct user intents — "settle a balanced card trade" vs "clear my wishlist" — justify two explicit buttons rather than one algorithm that tries to guess.

Pool cap at 16 is the subset-sum feasibility boundary (`2^16 = 65k` subsets; pairwise enumeration stays under 10M ops per mode, fine for a UI-thread `useMemo`).

### Balance tier uses absolute-dollar floors, not pure ratio

A $2 gap on a $5 trade is 40% ratio-wise, but nobody calls it "a great disturbance in the Force." `src/utils/forceBalance.ts:25-26` floors the tiers: below $5 gap → stays at most "ripple"; below $15 → stays at most "disturbance". Keeps the swu-title-level alarming language reserved for trades where the dollar gap itself is meaningful. Tested at `forceBalance.test.ts:28-43`.

### Leader + base cards sink to the bottom of each browse group

`browseAllGroups` (`useCardSearch.ts:46-52`) sorts leader / base groups last within each set. Playable tradable cards (units / events / upgrades) are what people scroll the catalog for; leader / base splash art is large and eats the first several rows otherwise. Covered in `useCardSearch.test.ts:117-128` as a load-bearing UX rule.

### TradeBalance owns its own collapse + tap target

Earlier iterations of the balance banner were click-through to the summary with no collapse state. Beta feedback: the banner competed with card-list scroll height on mobile. Resolution (`TradeBalance.tsx:99-128`): collapsed-state is a single-purpose tap-to-expand; expanded-state splits zones — the header toggles collapse, the body is informational, and only the footer "View full summary" opens the modal. This removes the ambiguity of "what does tapping the banner do?" while still keeping the modal reachable.

### ShareLiveTradeButton seeds both halves of a session

When a user clicks "Invite someone" with cards already in the builder, we seed **both** `initialCards` (my side) AND `counterpartInitialCards` (their side) from the current local state (`ShareLiveTradeButton.tsx:44-50`). Rationale: the calculator's mental model is "here's the trade I was thinking about" — dropping the counterpart-side work the user just did would surprise them. The scanner can still edit their half once they claim; it's a starting point, not a constraint.

### AutoBalanceBanner auto-strips `?autoBalance=1`

One-shot signal, designed to **not** survive reloads or share copies (`AutoBalanceBanner.tsx:158-166`). The URL strip and the intent-state clear happen in lockstep — either alone would let a stale state re-apply on the next render. Relevant when users share "Trade with @me" links that include autoBalance for the landing — the very first apply strips it, so the URL that actually shows up in the clipboard after page load is clean.

### Cash residual is derived, not stored

Whatever the matchmaker returns as `imbalance` is the implied cash settlement. We surface it in the banner, the action line, and the proposal DM, but we never *store* a cash field — the cards are the truth, and recomputing the residual from totals is cheap. Avoids needing a migration when pricing feeds update: the stored proposal replays on new prices and the receiver sees the current implied cash, not a stale one. See `matchmaker.ts:74-75`.

## Cross-references

- [`a-sessions.md`](./a-sessions.md) — the `/s/:id` shared canvas that `ShareLiveTradeButton` hands off to, and that reuses `<TradeSide readOnly>` / `<TradeBalance>`.
- [`b-proposals.md`](./b-proposals.md) — the ProposeBar / CounterBar / EditBar composer bars that mount in our mutex slot, and the `/api/trades` proposal lifecycle. We call `tradeActions.ts`'s helpers from the Summary send path; full handler side lives there.
- [`d-lists.md`](./d-lists.md) — wants + available + shared lists. We consume them via `effectiveSharedLists`, `useWants`, `useAvailable`, `sharedLists.wants|available`; we don't document the list storage model.
- [`e-home-nav.md`](./e-home-nav.md) — HomeView / view-mode detection / `nav` helper construction — the set of callers that hand off into the builder with various intent signals.
- [`f-community-profile.md`](./f-community-profile.md) — ProfileView's "Balanced trade with @X" CTA that sets `?from=` + `?autoBalance=1` and hands off here.
- [`h-cards-pricing.md`](./h-cards-pricing.md) — `CardVariant`, `getCardPrice`, `adjustPrice`, PricingContext, `countMissingPrices`. We apply those primitives; they're sourced there.
- [`i-discord-bot.md`](./i-discord-bot.md) or [`j-infra.md`](./j-infra.md) — `/api/og` OG image generation (Share-to-Discord "Image" pill + TradeImageModal). Endpoint + handler live wherever the OG page ships to; we only link to it.
- [`j-infra.md`](./j-infra.md) — CI pipeline that runs the e2e trade specs, vercel.json rewrites, build config.
