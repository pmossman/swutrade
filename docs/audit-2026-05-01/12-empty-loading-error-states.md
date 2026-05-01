# Empty / Loading / Error states audit — 2026-05-01

Scope: every list/fetch/async surface in `src/`. Method: enumerate the canonical primitives in `src/components/ui/states.tsx` (`LoadingState`, `EmptyState`, `ErrorState`), then walk every consumer to confirm parity. The 10th-agent UX-primitives sweep flagged five strays for empty/loading; this deeper pass turns up ten more, plus a recurring "compose loading-state inline because the surface owns layout" pattern that explains why.

## Inventory — empty/loading/error per surface

| Surface | Empty | Loading | Error |
|---|---|---|---|
| **CommunityView** guild list `:165-169` | `EmptyState` (NoGuildsEmptyState `:240`) | `LoadingState` `:165` | `ErrorState` `:167` |
| **CommunityView** members `:483-491` | `EmptyState` `:488` | `LoadingState` `:483` | `ErrorState` `:485` |
| **CommunityView** activity `:516-528` | inline `bg-space-800/40` `:524` *(stray)* | `LoadingState` `:517` | `ErrorState` `:520` |
| **CommunityView** members panel `:594-619` | `EmptyState` `:601` | `LoadingState` `:596` | `ErrorState` `:598` |
| **CommunityView** popular wants `:680-689` | `EmptyState` `:686` | `LoadingState` `:680` | `ErrorState` `:682` |
| **TradesHistoryView** trades `:213-223` | `EmptyState` `:219` + `EmptyTabState` `:346-367` (3×) | `LoadingState` `:213` | `ErrorState` `:215` + inline `:208` (per-row mutation) |
| **TradeDetailView** `:127-135` | n/a | `LoadingState` `:127` | `ErrorState` `:129,134` + inline `:351,382` (action) |
| **TradeExpandPeek** `:40-61` | inline `:126` "No cards" | inline `border-t … text-gray-500` `:42` *(stray)* | inline red-tinted `:48` *(stray; opens detail)* |
| **SessionView** `:247-255` | n/a (TerminalBanner instead) | `LoadingState` `:247` | `ErrorState` `:249,252` |
| **SessionView InviteByHandleForm** `:1283-1287` | n/a | inline `Inviting…` button label `:1280` | inline `text-red-400` `:1287` *(stray)* |
| **SessionTimelinePanel** `:184-185` | local `EmptyState` `:244-250` *(duplicate definition)* | n/a | inline `text-red-400` `:180,213` *(stray)* |
| **SessionSuggestComposer** `:174-180` | n/a (picker grid handles) | inline button label `:199` | inline `text-red-400` `:175` *(stray)* |
| **SettingsView** account `:383-385` | n/a | `LoadingState` `:383` | `ErrorLine` `:1074-1076` *(local component)* |
| **SettingsView** prefs `:498-500` | n/a | `LoadingState` `:498` | `ErrorLine` `:500` |
| **SettingsView** servers `:564-580` | inline `bg-space-800/40` `:575` *(stray)* | `LoadingState` `:569` | `ReauthBanner` `:564` + `ErrorLine` `:566,571` |
| **SettingsView** server detail `:640-647` | `EmptyState` `:642` | n/a | n/a |
| **SettingsView** members list `:728-735` | `EmptyState` `:730` | `LoadingState` `:728` | n/a (errors swallowed) |
| **SettingsView** member prefs `:810-816, 849-853` | `EmptyState` `:812,850` | n/a | n/a |
| **HomeView** trades module `:418-431` | inline `bg-space-800/30` `:420` *(stray)* | `LoadingState` `:418` | n/a (status `error` falls through) |
| **HomeView** wishlist module `:678-684` | local `EmptyListState` `:840-861` *(stray)* | n/a (synchronous from hook) | n/a |
| **HomeView** binder module `:764-770` | local `EmptyListState` `:840-861` | n/a | n/a |
| **HomeView** communities `:918-932` | inline `bg-space-800/30` `:922` *(stray)* | `LoadingState` `:919` | n/a |
| **HomeView** partners `:1046-1053` | inline `bg-space-800/30` `:1050` *(stray)* | `LoadingState` `:1047` | n/a |
| **HomeView** username strip `:248-253` | n/a | inline skeleton `bg-space-700/60 animate-pulse` `:251` *(stray)* | n/a |
| **ProfileView** root `:181-196` | `text-center text-gray-500 py-16` `:402` *(stray)* | inline `animate-pulse` `:184` *(stray)* | inline `text-gray-400` w/ link `:192` *(stray; not red)* |
| **WishlistView** | `EmptyState` via WantsPanel `:113` | n/a | n/a |
| **BinderView** | `EmptyState` via AvailablePanel `:95` | n/a | n/a |
| **WantsPanel** `:113-114, 157-164` | local `EmptyState` `:157` *(third definition)* | n/a | n/a |
| **AvailablePanel** `:94-95, 122-129` | local `EmptyState` `:122` *(fourth definition)* | n/a | n/a |
| **AutoBalanceBanner** `:188-209` | inline `text-gray-400` `:206` | inline `animate-pulse` `:198` *(stray)* | inline `text-red-300` `:190` *(stray)* |
| **EditBar** `:202-228` | n/a | inline `animate-pulse` `:204` *(stray)* | inline `text-red-300` `:208,215,228` *(stray)* + `PrimaryActionBar` error |
| **CounterBar** `:196-222` | n/a | inline `animate-pulse` `:198` *(stray)* | inline `text-red-300` `:202,209,222` *(stray)* + `PrimaryActionBar` error |
| **ProposeBar** `:290-303, 625-632` | n/a (status text covers) | inline `animate-pulse` `:300` *(stray)* | inline `text-red-300` `:292,628` *(stray)* + `PrimaryActionBar` error |
| **HandlePickerDialog** `:299-334` | local `EmptyCommunityState` + inline copy `:331` *(strays)* | inline `text-gray-500 px-1 py-2` `:313` *(stray, distinct from LoadingState)* | inline `text-red-300` `:300,318` *(stray)* |
| **CardResultsGrid** `:113-120, 202-212` | local `CenteredMessage` `:202` *(fifth definition)* | local `CenteredMessage` `:114` "Searching…" | n/a |
| **TradeImageModal** `:100-112` | n/a | inline `animate-spin` SVG `:102` *(unique pattern)* | inline `text-red-400` `:109` *(stray)* |
| **App.tsx** price-fetch `:657-672` | n/a | inline pulse `:943` "Loading prices…" *(stray)* | inline `bg-red-900/20` per-set banner `:659` *(stray; with retry)* |
| **SignalBuilderView** `:449-471, 493-499` | local `EmptyState` `:663-699` *(sixth definition; differs structurally)* | inline `italic` text `:450` + amber `:452` *(strays)* | inline `role="alert"` `:555` *(stray)* |
| **SessionSuggestions** | (gated by `length === 0` — returns null) | n/a | n/a |
| **NudgeDialog** `:111-120` | n/a | button label only | inline `bg-red-500/5` block `:112` *(stray)* |
| **TradeSummary** `:338-341` | n/a (computed canvas) | `animate-pulse-crimson` for chaos balance `:263` (semantic, not loading) | inline `bg-red-950/60` "missing prices" `:338` *(stray; semantic)* |

## High-impact findings (top 5)

### 1. `EmptyState` reimplemented six times locally

Six surfaces define their own local `EmptyState` instead of importing `ui/states.tsx`:
- `SignalBuilderView.tsx:663-699` — `py-4`, no card chrome, embeds CTA buttons
- `SessionTimelinePanel.tsx:244-250` — center-aligned grey text, no border
- `lists/WantsPanel.tsx:157-164` + `lists/AvailablePanel.tsx:122-129` — byte-identical (`flex flex-col items-center text-center gap-2 py-10`)
- `CardResultsGrid.tsx:202-212` (`CenteredMessage`) — bordered card with distinct chrome
- `HomeView.tsx:840-861` (`EmptyListState`) — compact CTA + suffix variant, used by 4 modules

WantsPanel/AvailablePanel/SignalBuilderView are user-facing product copy and would fit canonical `EmptyState` directly. `EmptyListState`'s "underlined CTA followed by sentence fragment" shape doesn't map onto `title + children` — promote it as a third primitive (`<CTAEmptyState onClick suffix>`). Leave `CenteredMessage` (picker-internal) and `SessionTimelinePanel` (chat empty hint) as deliberate exceptions.
**Risk:** low · **Effort:** S · **Confidence:** high.

### 2. Inline `animate-pulse` loading text in five composer bars

`AutoBalanceBanner:198`, `EditBar:204`, `CounterBar:198`, `ProposeBar:300`, `ProfileView:184` each render their own `<span className="text-gray-400 animate-pulse">…</span>` — the exact pattern `LoadingState` was extracted to handle. Composer bars need flex-friendly inline rendering (`flex-1 min-w-0`); `LoadingState`'s `centered` prop is full-bleed and the default is `text-xs` block. The strays diverge on color (`text-gray-400` vs primitive's `text-gray-500`) and size — drift that lands first as a token decision.

**Fix:** add an `inline` variant to `LoadingState` returning a bare span (no wrapper div, no fixed text-size). Composer bars adopt it.
**Risk:** low · **Effort:** XS · **Confidence:** high.

### 3. Errors inline as bare `text-red-300/400` bypassing `ErrorState`

`ErrorState` is used by 4 surfaces. Meanwhile **20+ surfaces** render bare red text without it. Three of those reimplement `ErrorState`'s exact chrome (`rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300`) byte-for-byte: `NudgeDialog:112`, `TradesHistoryView:208`, `ProposeBar:628`. `SignalBuilderView:555` is the same with a `border-red-500/40` drift. `App.tsx:659` is a per-set retry banner. `SettingsView:1074` defines a local `ErrorLine` with `text-xs text-red-300 mb-1`.

The composer-bar inline errors (`EditBar:208,215,228`, `CounterBar:202,209,222`, `ProposeBar:292`, `AutoBalanceBanner:190`) and per-row mutation errors are deliberately not card-shaped — see anti-rec. The four near-duplicates above are the convergence target.

**Fix:** add `variant: 'card' | 'line' | 'banner'` to `ErrorState`; migrate the four near-duplicates + SettingsView's `ErrorLine`.
**Risk:** low · **Effort:** S · **Confidence:** high.

### 4. `HandlePickerDialog` reimplements all three states for one fetch

`HandlePickerDialog.tsx:312-334` handles `status === 'loading' | 'error' | 'ready'` but uses none of the primitives — `text-[11px] text-gray-500 px-1 py-2` for loading, `text-[11px] text-red-300 px-1 py-2` for error, separate `EmptyCommunityState` for empty. The compact `text-[11px]` is intentional for a dialog footer; primitives default to `text-xs/text-sm`. Cleanest case for `size: 'compact' | 'default'` on all three primitives — every stray is "same thing, smaller."
**Risk:** low · **Effort:** S · **Confidence:** medium.

### 5. `ProfileView` page-level loading + error are unique

`ProfileView.tsx:181-196` is the only top-level view skipping `LoadingState`/`ErrorState`. Its loading wraps `min-h-[100dvh] bg-space-900 …` around inline pulse text; its error is centered grey (not red) with a "Back to SWUTrade" link. `SessionView:247-255` solves the same problem with the canonical primitives because the bg-space-900 wrapper is already in its always-rendered root. ProfileView's wrapper exists *only* for the loading/error case.

**Fix:** restructure ProfileView to render a single root with breadcrumbs always present; use `LoadingState centered` + a new `ErrorState centered` variant. Removes 2 strays + the redundant viewport wrapper.
**Risk:** low · **Effort:** S · **Confidence:** medium.

## Lower-priority debt

- `TradeImageModal.tsx:100-112` — only `animate-spin` SVG loader in the app; pulse text would feel anemic for a hero preview.
- `SignalBuilderView.tsx:449-452` — three inline loading/empty/error messages packed into one `<label>`; each too short to merit a primitive.
- `TradeExpandPeek.tsx:40-61` — mini-loading + mini-error (one-line text in a divider). `border-t` only, no card — intentional because the peek renders *inside* a parent card.
- `SessionTimelinePanel.tsx:180,213` — chat-footer error states tied to specific actions (revert vs send).
- `App.tsx:659` price-fetch banner — retry button + per-set chrome diverge legitimately (wraps independent set fetches).
- `App.tsx:943` "Loading prices…" — trade-balance footer; pulse text is fine.
- `HomeView.tsx:251` username skeleton — only layout-stable skeleton in the app (reserves loaded-label height); keep standalone.
- `TradesHistoryView.tsx:346-367` `EmptyTabState` — three tab-specific empties using canonical `EmptyState`; correct pattern.
- `SettingsView.tsx:1074` `ErrorLine` — folds into finding #3.
- WantsPanel/AvailablePanel empty copy is product-tuned ("Your wishlist is empty" / "Your trade binder is empty") — folds into #1.

## Anti-recommendations

Don't re-flag in the next audit:

- **No toast system by design.** Errors surface inline near the action that failed. Don't add a toast/snackbar primitive.
- **Two-tap-arm destructive pattern** (`ClearAllButton`, `TradesHistoryView:585-649` BulkActionBar) is canonical destructive-confirm; errors during armed actions stay inline next to the button.
- **Composer-bar inline pulse text** needs flex-friendly inline layout — finding #2 adds an `inline` variant rather than forcing the block default.
- **`PrimaryActionBar.tsx:85-89`** owns the action-error surface (gold button → red caption beneath). Don't migrate composer-bar inline errors *into* `ErrorState` — bar pattern is intentionally separate.
- **Form-level vs field-level inline errors** (`HandlePickerDialog:299-305` with `aria-describedby`, `SessionView:1287` invite-by-handle) are local to the form by design. Don't aggregate.
- **`TradeExpandPeek:42-58`** uses `border-t` only because the peek renders inside a parent card; frame-stacking would visually orphan it.
- **`CardResultsGrid:202-212` `CenteredMessage`** is picker-internal; bordered card inside the virtualizer is intentional.
- **`TerminalBanner` (`SessionView:754-815`)** is settled/cancelled/expired status, not error chrome — correctly distinct.
- **`MergeReassuranceBanner`, `ReauthBanner`** are domain banners, not generic error chrome.
- **`status === 'idle' || 'loading'`** treated as one branch (`CommunityView:516`) prevents flicker.
- **`HomeView:251` skeleton** is the only layout-stable skeleton; it reserves the loaded-label height. Don't fold into `LoadingState` (which doesn't reserve layout).
- **Per-row mutation errors** (`TradesHistoryView:208` `rowError`, `TradeDetailView:351,382`) stay inline next to the row/action that failed.
- **`SignalBuilderView:663-699` `EmptyState`** embeds primary CTA buttons inline; canonical's `children` slot is too generic. Migrate only if a second consumer of `<EmptyState ctaSlot={…}>` emerges.
