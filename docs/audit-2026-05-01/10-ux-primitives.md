# UX primitives inventory — 2026-05-01

Scope: every `src/components/` file. Method: enumerate primitives → find implementations → flag divergence. File:line refs throughout.

## Inventory table

| Primitive | Canonical | Implementations | Status |
|---|---|---|---|
| Number stepper / qty | `ui/NumberStepper.tsx` | `NumberStepper` (used `ListRows.tsx:8-18`, `SignalBuilderView.tsx:735,792`); inline `TradeRow.tsx:279-295`; inline pill `CardTile.tsx:191-202`; inline pill `FamilyRow.tsx:144-156`; ad-hoc qty mutation `SessionSuggestComposer.tsx:84-99`, `SignalBuilderView.tsx:243-356` | ❌ Diverged |
| Modal / dialog | — (Radix `Dialog` de-facto) | Radix: `ProposeBar.tsx:534`, `ListsDrawer.tsx:88`. Hand-rolled `role="dialog"`: `NudgeDialog.tsx:75`, `HandlePickerDialog.tsx:210`, `TradeImageModal.tsx:78`, `TutorialOverlay.tsx:86`, `TradeSummary.tsx:226`. Hand-rolled no role: `SessionSuggestComposer.tsx:134`, `SessionTimelinePanel.tsx:149`, `TradeSearchOverlay.tsx:223`, `SignalBuilderView.tsx:597` | ⚠️ 3 patterns |
| Dropdown / select | `Popover`+listbox (`SetFilter.tsx`) | Custom listbox: `SetFilter.tsx:15-141`. Native `<select>`: `SignalBuilderView.tsx:454,775`, `SettingsView.tsx:884,954`, `ProposeBar.tsx:714` | ⚠️ Mixed |
| Search input | — | `ListCardPicker.tsx:520`, `HandlePickerDialog.tsx:276`, `SettingsView.tsx:426,983`, `ListView.tsx:259`, `SessionView.tsx:1158,1259` | ⚠️ ~7 inline |
| Kebab menu | `KebabMenu.tsx` | Used by TradeRow, MobileActionsKebab | ✅ |
| Popover | `Popover.tsx` | Used by KebabMenu, SetFilter, PriceSlider | ✅ |
| Avatar (user) | — | `CommunityView.tsx:854`, `SettingsView.tsx:1003`, `HomeView.tsx:1177`, `SessionView.tsx:996`, `TradesHistoryView.tsx:671`, `TradeDetailView.tsx:538`, `HandlePickerDialog.tsx:545` | ❌ 7 copies |
| Avatar (guild) | — | `CommunityView.tsx:869`, `SettingsView.tsx:1018`, `HomeView.tsx:977` | ❌ 3 copies |
| Status badge | `ui/StatusBadge.tsx` | `TradesHistoryView.tsx:478`, `TradeDetailView.tsx:152` | ✅ |
| Variant badge | `VariantBadge.tsx` | TradeRow, ListRows, ProfileView | ✅ |
| Generic chip / pill | — | qty pill `CardTile.tsx:194` + `FamilyRow.tsx:148`; spread `TradeRow.tsx:171,182`; want `ListRows.tsx:303`; overlap `CommunityView.tsx:846`; tab-count `ProfileView.tsx:465`, `TradesHistoryView.tsx:330` (~16 sites) | ⚠️ Many similar |
| Toast | — | none — by design (ErrorState inline) | n/a |
| Empty state | `ui/states.tsx` `EmptyState` | Heavily used. Strays: `ProfileView.tsx:402` free-text; `SignalBuilderView.tsx:663` defines own local `EmptyState` | ⚠️ Stray |
| Loading state | `ui/states.tsx` `LoadingState` | Used widely. Inline `animate-pulse`: `ProfileView.tsx:184`, `AutoBalanceBanner.tsx:198`, `EditBar.tsx:204` | ⚠️ 3 strays |
| Error state | `ui/states.tsx` `ErrorState` | CommunityView, TradesHistoryView | ✅ |
| Card thumbnail | — | `TradeRow.tsx:28-69` (adaptive landscape), `CardTile.tsx`, `FamilyRow.tsx:168` CardStack, `ListRows.tsx:38`, `TradeSummary.tsx`, `ListCardPicker.tsx`, `SessionSuggestComposer.tsx` | ❌ ~6 inline |
| Tabs | — | `CommunityView.tsx:387` GuildTabs (rounded-md gold-bg); `CommunityView.tsx:624` SortTabs (rounded-full uppercase); `ProfileView.tsx:425` (border-b blue/emerald); `TradesHistoryView.tsx:305` (gold underline); `ListRows.tsx:236` SegmentedOption (toggle) | ❌ 4 variants |
| Confirm prompt | — (`ClearAllButton.tsx` modeled) | `window.confirm`: `SignalBuilderView.tsx:156`, `ProposeBar.tsx:187`, `MobileActionsKebab.tsx:50`, `SessionView.tsx:222`. Two-tap-arm: `ClearAllButton.tsx:13`, `TradesHistoryView.tsx:585` BulkActionBar | ❌ 3 styles |
| Form input + label | — | All inline; no `<TextField>` | ⚠️ Generic |
| Breadcrumbs | `ui/Breadcrumbs.tsx` | Via `AppHeader` | ✅ |
| Action button | — (`PrimaryActionBar` is host) | Inline Send/Accept/Decline in EditBar, CounterBar, ProposeBar, TradeDetailView | ⚠️ Bespoke |
| Pagination | — | "See all N →" text-link `CommunityView.tsx:474` | n/a |
| List row / divider | — | `ListRows.tsx:35` RowShell, plus row layouts in TradesHistoryView, CommunityView, SessionView | ⚠️ Generic |

## High-impact findings

### 1. Number stepper — three inline reimplementations of the canonical UI primitive

- **Where:**
  - Canonical: `src/components/ui/NumberStepper.tsx:44-150` — typeable input, ArrowUp/Down keys, clamp on blur, gold accent, `Increase/Decrease` aria-labels.
  - `src/components/TradeRow.tsx:279-295` — split `+/−`, side-colored emerald/blue (`QTY_BTN_COLORS:83-86`), `aria-label={qty <= 1 ? 'Remove' : 'Decrease quantity'}` / `Increase quantity`, `hit-area-44`.
  - `src/components/CardTile.tsx:191-202` — single `rounded-full` pill `×N −`, side-colored, `aria-label={qty <= 1 ? 'Remove ${name}' : 'Decrease quantity of ${name}'}`. Increment via tile click.
  - `src/components/FamilyRow.tsx:144-156` — same pill style as CardTile; `qtyBadgeClass: Record<'gold'|'emerald'|'blue', string>` redefined byte-identically at `CardTile.tsx:39-49` and `FamilyRow.tsx:53-63`.
- **Divergence:** styling (gold-input vs side-color buttons vs side-color pills); a11y (one `ariaLabel` prop vs four hand-written conventions); behavior (typeable+ArrowKeys vs click-only); API (`onChange(next)` vs `onChangeQty(delta)` vs `onChangeQty(next)`).
- **Why it matters:** Side coloring is a deliberate SWU invariant, so the *colors* must stay; but button geometry, hit-area, hover/active classes, qty-1=remove logic, and the `qtyBadgeClass` map are duplicated three times with quiet drift.
- **Proposed fix:** Extract `ui/QtyAdjuster` with `accent: 'gold'|'emerald'|'blue'` and `variant: 'split'|'pill'`. TradeRow → split-emerald/blue, CardTile + FamilyRow → pill-emerald/blue, ListRows keeps NumberStepper for typeable.
- **Risk:** medium · **Effort:** M · **Confidence:** high.

### 2. Avatar duplicated 7× (user) + 3× (guild)

- **Where:** `CommunityView.tsx:854-884`, `SettingsView.tsx:1003-1033`, `HomeView.tsx:977-1006,1177-1190`, `SessionView.tsx:996-1009`, `TradesHistoryView.tsx:671`, `TradeDetailView.tsx:538`, `HandlePickerDialog.tsx:545-568`.
- **Divergence:** size grid (`w-10 h-10` baked vs prop-driven `sm/md/lg`); fallback text size (`text-sm` vs none); HandlePicker `sm` uses `text-[10px]`, others `text-xs`; guild rounding (`rounded-full` vs `rounded-md`). Prop shapes diverge: `{avatarUrl, name}` vs `{avatarUrl, username}` vs `{user: UserStub}`.
- **Why it matters:** Refactor agent #N3 already flagged this and it's still untouched. A11y improvements ship to one consumer only.
- **Proposed fix:** `ui/Avatar` with `{ src, name, size, shape? }` and `ui/GuildAvatar` wrapping it with the Discord CDN URL composer. Replace all 10 sites.
- **Risk:** low · **Effort:** S · **Confidence:** high.

### 3. Modal/dialog has three competing patterns

- **Where:** Radix `Dialog.Root` (`ProposeBar.tsx:534`, `ListsDrawer.tsx:88`); hand-rolled `role="dialog" aria-modal="true"` (`NudgeDialog.tsx:75`, `HandlePickerDialog.tsx:210`, `TradeImageModal.tsx:78`, `TutorialOverlay.tsx:86`); hand-rolled no role (`SessionSuggestComposer.tsx:134`, `SessionTimelinePanel.tsx:149`, `TradeSearchOverlay.tsx:223`).
- **Divergence:** Radix gets focus trap + `inert` siblings + ESC + body-scroll-lock free; hand-rolled with-role versions implement ESC themselves but skip focus trapping; hand-rolled no-role versions don't announce. Click-outside (`onClick={e => { if (e.target === e.currentTarget) onClose(); }}`) reimplemented thrice.
- **Why it matters:** SR users get inconsistent dialog announcements; keyboard users can tab out of half the dialogs.
- **Proposed fix:** Migrate the three small dialogs (`NudgeDialog`, `HandlePickerDialog`, `TradeImageModal`) to Radix `Dialog.Root` (already in deps). Leave page-overlays alone but factor `ui/PageOverlay` for ESC + role + scroll-lock.
- **Risk:** medium (focus-trap behavior change) · **Effort:** M · **Confidence:** medium.

### 4. Tabs — 4 incompatible visuals for the same primitive

- **Where:** `CommunityView.tsx:387` GuildTabs (rounded-md, gold/20 bg active); `CommunityView.tsx:624` SortTabs (rounded-full, uppercase tracking); `TradesHistoryView.tsx:305` (gold underline as `<span absolute>`); `ProfileView.tsx:425` ProfileListTab (border-b underline, blue/emerald per tab id, gap-6).
- **Divergence:** four mutually exclusive active-tab affordances. A11y is uniform (`role="tab"` + `aria-selected`); visuals are not.
- **Why it matters:** Visual hierarchy goes noisy across views.
- **Proposed fix:** `ui/Tabs` with `variant: 'underline'|'pill'|'sort-pill'` and optional per-tab accent for ProfileView's blue/emerald (preserve the side-color invariant).
- **Risk:** low · **Effort:** M · **Confidence:** high.

### 5. Confirm prompt — native `window.confirm` mixed with two-tap-arm

- **Where:** Native `window.confirm`: `SignalBuilderView.tsx:156`, `ProposeBar.tsx:187`, `MobileActionsKebab.tsx:50`, `SessionView.tsx:222`. Two-tap-arm: `ClearAllButton.tsx:13-68`, `TradesHistoryView.tsx:585-649`.
- **Divergence:** OS-native chrome breaks SWU palette; two-tap timeouts differ (3s vs 4s).
- **Proposed fix:** Adopt `ClearAllButton`'s two-tap as canonical → extract `ui/ArmedActionButton({ holdMs })`. For "Clear all cards" (only true modal-y case), add tiny `ui/ConfirmDialog` on Radix.
- **Risk:** low · **Effort:** S · **Confidence:** medium.

### 6. Card thumbnail — 6 inline implementations, only one detects landscape

- **Where:** `TradeRow.tsx:28-69` (adaptive landscape via `naturalWidth > naturalHeight`); `CardTile.tsx`; `FamilyRow.tsx:168-200` CardStack; `ListRows.tsx:38-40`; `TradeSummary.tsx`; `ListCardPicker.tsx`; `SessionSuggestComposer.tsx`.
- **Divergence:** only TradeRow flips aspect for leaders; others portrait-crop them.
- **Why it matters:** Leader cards (Luke, Vader) crop weirdly outside TradeRow. User-visible inconsistency on every list/picker.
- **Proposed fix:** Extract `ui/CardThumb` (with the orientation detection) from TradeRow; migrate the 5 other call sites; `CardStack` composes it. Subsumes synthesis N7.
- **Risk:** low · **Effort:** M · **Confidence:** high.

### 7. Empty/Loading state strays + a duplicate local definition

- **Where:** `ui/states.tsx` is canonical. Strays: `ProfileView.tsx:184` (loading text), `ProfileView.tsx:402` (empty text), `AutoBalanceBanner.tsx:198`, `EditBar.tsx:204`. Plus `SignalBuilderView.tsx:663` defines a *different* local `EmptyState`.
- **Divergence:** SignalBuilder local `EmptyState` differs in padding/border. Free-text empties skip the bordered card chrome.
- **Proposed fix:** Replace 4 inline strays + delete local SignalBuilder definition.
- **Risk:** low · **Effort:** XS · **Confidence:** high.

## Lower-priority debt

- **Generic chip/pill** — 16 inline `inline-flex … rounded-full border` sites. `ui/Chip` with `tone` prop possible but variance is mostly intentional semantics (qty/count/spread/want).
- **Search input** — 7 inline `<input>`s rhyme but aren't byte-identical.
- **Native `<select>`** — 5 sites (settings forms); native acceptable, defer.
- **Action button** — Send/Accept/Decline inline across EditBar/CounterBar/ProposeBar/TradeDetailView. Variance matches bespoke composition; defer.
- **CounterpartAvatar** triplicate folds into finding #2.
- **`SegmentedOption` in ListRows** is a *toggle*, not navigation — do not merge into Tabs.

## Anti-recommendations

Don't re-flag in the next audit:

- **Emerald/blue side coloring** on TradeRow/CardTile/FamilyRow stepper buttons is a SWU invariant. A `ui/QtyAdjuster` extraction must keep `accent: 'gold'|'emerald'|'blue'`. No collapse to a neutral accent.
- **NumberStepper has typeable input; TradeRow/CardTile/FamilyRow are click-only by design.** Variant prop, not a single behavior.
- **`SetFilter`'s custom-listbox-on-Popover** is the deliberate solve for unstyle-able `<select>`. Don't rip it out.
- **Page-replacing overlays** (`TradeSearchOverlay`, `SessionSuggestComposer`, `TradeSummary`) are intentionally not Radix Dialogs. They take over the viewport, not overlay it.
- **Two-tap-arm destructive pattern** (ClearAllButton, BulkActionBar) is intentional in-context confirm. Don't replace with modal confirms.
- **`SegmentedOption`** (Any/Specific in ListRows) is a toggle, not a tab.
- **Per-tab accent** in `ProfileView.tsx:425-475` (blue/emerald) is the side-coloring invariant — must survive any Tabs merge.
- **`title=""` hover tooltips** (`TradeRow.tsx:227`, `VariantBadge.tsx:6-17`) are deliberate cheap path; no tooltip lib.
- **`MobileActionsKebab`'s `window.confirm`** for "Clear all cards from both sides" is the strongest "do you really mean it" surface; don't downgrade until `ui/ConfirmDialog` exists.
- **`StatusBadge`/`VariantBadge`** are correctly canonical.
- **`Breadcrumbs`/`AppHeader`/`PrimaryActionBar`/`KebabMenu`/`Popover`** are consolidated and correct.
- **No toast system by design** — all error surfacing is inline (`ErrorState`, send-error under `PrimaryActionBar`).
