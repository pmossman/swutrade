# Accessibility audit — 2026-05-01

Scope: every interactive element under `src/components/`. Method: aria-labels, role usage, keyboard support, focus management, color-only signals. Companion to `10-ux-primitives.md` — same primitive divergence, viewed through the a11y lens.

## High-impact findings

### 1. Number-stepper aria-labels diverge across four implementations

- **Where:**
  - `ui/NumberStepper.tsx:109,141` composes `Decrease ${ariaLabel.toLowerCase()}` / `Increase …`. With `ariaLabel="Quantity"` (`ListRows.tsx:15`, `SignalBuilderView.tsx:740`) → `Decrease quantity` / `Increase quantity`.
  - `TradeRow.tsx:283,291` → `aria-label={qty <= 1 ? 'Remove' : 'Decrease quantity'}` / `Increase quantity` — no card name.
  - `CardTile.tsx:195` → `Remove ${card.name}` / `Decrease quantity of ${card.name}`; no separate increase button (increment via tile-as-button at `CardTile.tsx:121-125`, labeled `Add ${card.name} (${variant}) to ${actionTarget}`).
  - `FamilyRow.tsx:118,149` mirrors CardTile.
  - `ListRows.tsx:24` `RemoveButton` says `aria-label="Remove"` (no target) next to a NumberStepper saying `Decrease quantity` — every wishlist row reads `Decrease quantity, 1, Increase quantity, Remove`.
- **Why it matters:** TradeRow / ListRows screen-reader users can't tell *which* card is being decremented; CardTile + FamilyRow get full context. Same widget, three label conventions.
- **Proposed fix:** when extracting `ui/QtyAdjuster` (UX U1), require card name; compose `Decrease quantity of ${name}` / `Increase quantity of ${name}` uniformly.
- **Risk:** low · **Effort:** S · **Confidence:** high.

### 2. Hand-rolled dialogs miss focus-trap and focus-restore

- **Where:** `NudgeDialog.tsx:75-86`, `HandlePickerDialog.tsx:210-220`, `TradeImageModal.tsx:78-95`, `TutorialOverlay.tsx:84-105`. Each declares `role="dialog" aria-modal="true"` + handles Escape, but only HandlePicker focuses an input on open (`HandlePickerDialog.tsx:68`); none restores focus on close, none traps Tab. NudgeDialog's `tabIndex={-1}` panel never calls `.focus()`. `SessionTimelinePanel.tsx:148` and `TradeSearchOverlay.tsx:222` don't even declare `role="dialog"`.
- **Why it matters:** keyboard users in Nudge can Tab out into the (still-rendered) page below; on close, focus lands on `<body>` instead of the trigger. Radix `Dialog.Root` (already in deps; used in `ProposeBar.tsx:534`, `ListsDrawer.tsx:88`) solves all three for free.
- **Proposed fix:** migrate the three small dialogs to Radix. For page-replacing overlays, factor `ui/PageOverlay` (role + scroll-lock + returnFocusRef). Folds into UX 10-3.
- **Risk:** medium · **Effort:** M · **Confidence:** high.

### 3. Tabs declare `role="tablist"`/`role="tab"` but no `tabpanel` pairing

- **Where:** `CommunityView.tsx:403-421` (GuildTabs), `CommunityView.tsx:632-643` (SortTabs), `TradesHistoryView.tsx:314-340`, `SignalBuilderView.tsx:438,648`. Only `ProfileView.tsx:396` pairs tabs with `role="tabpanel"`. No tab carries `aria-controls`; no panel carries `aria-labelledby`. Radix-backed `ListsDrawer.tsx:138-175` is correct (Radix wires it).
- **Why it matters:** the WAI-ARIA tabs pattern requires the relationship to be machine-readable. Right now an active tab and a static button look identical to assistive tech.
- **Proposed fix:** when the unified `ui/Tabs` component lands (UX 10-4), wire panels with stable ids and emit `aria-controls` + `aria-labelledby` automatically.
- **Risk:** low · **Effort:** S · **Confidence:** high.

### 4. KebabMenu trigger missing aria-haspopup / aria-expanded / aria-controls

- **Where:** `KebabMenu.tsx:42-59`. The button has only `aria-label={ariaLabel}`. Compare `AccountMenu.tsx:47-48,101-102` and `NavMenu.tsx:42-43` which both wire `aria-expanded={open}`. KebabMenu has the same `open` flag from `Popover`'s render-prop (`KebabMenu.tsx:41`) but doesn't forward it.
- **Why it matters:** every kebab in TradeRow + MobileActionsKebab is silent about open state. JAWS/NVDA hear `More actions, button` with no signal that pressing it expands a menu, or that it's currently open.
- **Proposed fix:** thread `open` into the trigger; add `aria-haspopup="menu"` + `aria-expanded={open}` + `aria-controls={useId()}`.
- **Risk:** low · **Effort:** XS · **Confidence:** high.

### 5. Custom `role="button"` tiles reimplement what `<button>` gives free

- **Where:** `CardTile.tsx:120-125,140`, `FamilyRow.tsx:113-117`. `<div role="button" tabIndex={0}>` + `onKeyDown` for Enter+Space. Nested image at `CardTile.tsx:140` has its own `onClick` without a key handler. Neither tile sets `aria-disabled` when "in trade" (semantically still "addable" when state is "click-to-decrement").
- **Proposed fix:** convert outer tile to `<button>`; nested image-click becomes a no-op.
- **Risk:** low · **Effort:** XS · **Confidence:** medium.

### 6. Native `window.confirm()` breaks ARIA tree + palette

- **Where:** `MobileActionsKebab.tsx:50`, `SignalBuilderView.tsx:156`, `ProposeBar.tsx:187`, `SessionView.tsx:222`. OS dialog: no aria-label, inconsistent button order, no SWU palette. iOS Safari sometimes dismisses on background gestures.
- **Proposed fix:** replace with two-tap-arm (`ui/ArmedActionButton`) or Radix `ConfirmDialog`. Folds into UX 10-5.
- **Risk:** low · **Effort:** S · **Confidence:** high.

### 7. Color-only error signaling on TradeBalance + AutoBalanceBanner

- **Where:** `TradeBalance.tsx:222-229` shows `missingTotal` as red text on red-tinted card — only signal is color (warning icon is `aria-hidden`). `AutoBalanceBanner.tsx:190-193` shows `Couldn't reach @${handle}'s lists` in `text-red-300` with no `role="alert"`. `ProposeBar.tsx:626` does set `role="alert"`; banner doesn't.
- **Proposed fix:** add `role="alert"` to AutoBalanceBanner error branch; remove `aria-hidden` from TradeBalance's warning icon and label it.
- **Risk:** low · **Effort:** XS · **Confidence:** high.

## Lower-priority debt

- `PriceModeToggle.tsx:8-32` — two-button group: no `role="group"`, no `aria-label`, no `aria-pressed`. `SessionView.tsx:617-630` gets all three; mirror it.
- `TradesHistoryView.tsx:426-428` `role="checkbox"` on `<button>` flips aria-label instead of using `aria-checked`.
- `Popover.tsx:80-90` portaled panel has no `role` — KebabMenu's child injects `role="menu"` but container is unstructured.
- `HandlePickerDialog.tsx:282` `<input> onKeyDown` only Enter — no Arrow-nav into suggestions.
- `SetFilter.tsx:58` listbox correctly labeled but no `aria-activedescendant` — Tab in, can't arrow-navigate.
- `BetaBadge.tsx:20` duplicates `title` and `aria-label` (harmless).
- `TutorialOverlay.tsx:122-128,142-147` two backdrop buttons both labeled `Skip tutorial`; Tab order may visit Skip before CalloutCard Next.

## Anti-recommendations

Don't re-flag these:

- **`title=""` hover tooltips** on `TradeRow.tsx:227`, `VariantBadge.tsx:63` — deliberate, no tooltip lib.
- **Decorative SVG `aria-hidden`** (Logo, chevrons, ×) is correct — parent button carries the label.
- **Empty `alt=""` on card thumbnails** (`CardTile.tsx:145`, `FamilyRow.tsx:197`) is correct — row owns the name.
- **`PriceSlider.tsx:40-46` dynamic aria-label** (reads current %) is correct, don't normalize.
- **`window.confirm` in `MobileActionsKebab.tsx:50`** stays until `ui/ConfirmDialog` exists.
- **Hover-reveal kebab + 0.7-opacity touch fallback** at `index.css:194-207` — intentional (5-trade-ui.md).
- **Missing `role="tabpanel"` on non-Profile tabs** — panels swap whole sections; fix is to wrap the swap target, not restructure views.
- **`tabIndex={-1}` on dialog panels** (`NudgeDialog.tsx:85`, `HandlePickerDialog.tsx:220`) — never called; Radix migration moots it.
- **Color-only side coloring** (emerald/blue) — SWU invariant; side labels always read "Yours / Theirs / Offer / Receive" so colors are additional signal, not the only signal.
- **`role="checkbox"` on `<button>`** (TradesHistoryView.tsx:426) — documented bulk-select pattern; only the aria-attribute choice (pressed vs checked) is wrong.

---

Fix order: 4 (XS) → 7 (XS) → 1 (folds into UX U1). Findings 2 + 6 are bigger lifts, most user-impactful.
