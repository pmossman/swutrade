# E · Home, navigation, routing, global contexts

> **Owner scope**: this page covers the two home-level surfaces (signed-in `HomeView` + ghost `GhostHomeView`), the always-on chrome (`AppHeader` / `Breadcrumbs` / `NavMenu` / `AccountMenu` / `Logo` / `BetaBadge`), the shared UI primitives (`StatusBadge`, `LoadingState` / `EmptyState` / `ErrorState`, `ErrorBoundary`), the view router (`src/routing/config.ts` + the `renderBody()` switch in `src/App.tsx`), every global React context (`AuthContext`, `CardIndexContext`, `DrawerContext`, `NavigationContext`, `PriceDataContext`, `PricingContext`), and the shared nav utility `src/utils/dialogFocus.ts`.
>
> Specifically:
> - `src/components/HomeView.tsx`
> - `src/components/ui/AppHeader.tsx`
> - `src/components/ui/Breadcrumbs.tsx`
> - `src/components/ui/StatusBadge.tsx`
> - `src/components/ui/states.tsx`
> - `src/components/ui/ErrorBoundary.tsx`
> - `src/components/NavMenu.tsx`
> - `src/components/AccountMenu.tsx`
> - `src/components/Logo.tsx`
> - `src/components/BetaBadge.tsx`
> - `src/routing/config.ts`
> - `src/App.tsx` (the `renderBody()` switch + `nav` memo + popstate handler; the trade-builder body and card-management helpers belong to [`c-trade-builder.md`](./c-trade-builder.md))
> - `src/main.tsx` (provider order)
> - `src/contexts/*.tsx` (all six)
> - `src/utils/dialogFocus.ts`

## Overview

Everything that sits *around* the view happens here: which view renders for a given URL, how a click on "Trade with @X" flips the URL + React state + intent store in one atomic step, what the header looks like on every page, and which React contexts fan out the app-level singletons (auth, card index, pricing, drawer). One sentence: **this area owns the app's router, the chrome that wraps every view, and the global state that every view reads from.**

The model is a query-param-driven SPA on top of Vercel rewrites. There is no framework router; `detectViewMode(isSignedIn)` reads `window.location` and returns a `ViewMode`, and `App.tsx`'s `renderBody()` switch renders the matching view. Every in-app navigation goes through a single `useNavigation()` primitive whose methods guarantee URL + `useTradeIntent` state + `viewMode` stay in lockstep — the class of bug that caused the Home → Propose regression fixed in commit `aeb0aa2` is closed by construction.

## Key concepts / glossary

- **ViewMode** — union of nine values (`'home' | 'trade' | 'list' | 'settings' | 'community' | 'trades-history' | 'trade-detail' | 'session' | 'profile'`). Declared at `src/routing/config.ts:25`. The `renderBody()` switch in `src/App.tsx:421` reads this to pick a component.
- **`detectViewMode(isSignedIn)`** — pure function at `src/routing/config.ts:212` that reads `window.location` and returns a `ViewMode`. Uses the `VIEW_ROUTES` table's `matches()` predicates in declaration order; first match wins.
- **`VIEW_ROUTES`** — ordered table of `{ mode, matches, paramKeys }` at `src/routing/config.ts:113`. The `paramKeys` are consulted by `useTradeUrl`'s merge-write so a non-trade-builder view's params don't get stripped when a card is added.
- **`VIEW_PARAM_KEYS`** — superset at `src/routing/config.ts:52` used by `nav.toX()` methods to blow away stale view params before setting the destination's. Deliberately excludes trade-codec keys (`y`/`t`/`pct`/`pm`) and trade-intent keys (`propose`/`counter`/`edit`/`from`/`autoBalance`).
- **`NavigationApi`** — interface at `src/contexts/NavigationContext.tsx:28`. Methods named by destination (`toHome`, `toTradesHistory`, `toSettings`), not by URL structure. Every in-app nav flows through one of these.
- **Signed-in hint** — `localStorage` key `swu.signedInHint` at `src/hooks/useAuth.ts:41`. Pre-seeds `isSignedIn` on first render so a returning signed-in user doesn't flash the trade-builder view before `/api/auth/me` resolves. Advisory only; server remains the trust surface.
- **Ghost user** — anonymous user minted by a shared-trade claim or open-session creation (see [`g-auth.md`](./g-auth.md)). `auth.user?.isAnonymous === true`. From the user's POV, ghost === guest — the same chrome a pure signed-out visitor sees. Routing's `home` rule gates on real-user-only so ghosts land on the trade builder regardless of bare URL or `?view=home`. The separate `GhostHomeView` surface was deleted as part of the two-state user collapse (2026-04-22).
- **Trade intent** — the five query-param signals (`propose`, `from`, `counter`, `edit`, `autoBalance`) owned by `useTradeIntent`. The `NavigationApi` mirrors them into React state whenever a nav is issued so pushState-driven nav works without a reload (see `aeb0aa2`).
- **`STANDALONE` views** — `profile`, `settings`, `community`, `trade-detail`, `trades-history`, `session`. Defined in `isStandaloneView` at `src/routing/config.ts:239`. `useTradeUrl` bails its merge-write on these views so its trade-codec rewrites can't strip their URL params.
- **State badge** — the trade-state palette owned by `HomeView.tsx`'s `BADGE_TONES` / `stateBadgeSpec()` (`src/components/HomeView.tsx:517`). Canonical visual language for `TradeRowState`; other areas (history, detail) use `StatusBadge` which is a parallel primitive for `TradeStatus`.
- **Module (in HomeView)** — one of four parallel panels on the signed-in dashboard, arranged in a 2×2 grid: row 1 = `TradesModule` + `CommunitiesModule`, row 2 = `WishlistModule` + `BinderModule`. All use the shared `ModuleSection` chrome. `CommunitiesModule` was briefly removed in UX-A4 (2026-04-21) then reinstated the same day as the walk-back (see tech-debt section). `StoresModule` (Phase 4 LGS placeholder) was removed in the walk-back — reserving a dimmed quadrant for a feature that'll ship its own surface wasn't earning its real estate.

## File map

### Home surfaces

**`src/components/HomeView.tsx`** — Signed-in dashboard. Four modules in a 2×2 grid (row 1: Trades / Communities, row 2: Wishlist / Binder) plus the `NeedsResponseCallout` at the top. Also exports the `BADGE_TONES` record + `stateBadgeSpec()` that map `TradeRowState → tone` (the canonical trade-state visual language other areas consume). `CommunitiesModule` was briefly deleted in UX-A4 then reinstated as a peer module in the same-day walk-back; `StoresModule` was deleted in that walk-back.

### Chrome

**`src/components/ui/AppHeader.tsx`** — Chrome-only top bar: Logo + optional Back button + optional Breadcrumbs + NavMenu + AccountMenu. Deliberately has no contextual-action slot (see "Decisions").
**`src/components/ui/Breadcrumbs.tsx`** — Orientation-only trail. Mobile collapses to just the current-page label; parent-back lives as AppHeader's dedicated Back button.
**`src/components/NavMenu.tsx`** — Hamburger content-nav popover (Home / My Wishlist / My Binder / My Trades / My Communities). Split from AccountMenu by design; see "Decisions". "My Lists" was replaced by "My Wishlist" + "My Binder" in the 2026-04-21 Wishlist/Binder split — both entries route to their dedicated views via `?view=wishlist` / `?view=binder`.
**`src/components/AccountMenu.tsx`** — Identity-only popover (Profile / Settings / Sign out, or a Sign-in-with-Discord CTA when signed out).
**`src/components/Logo.tsx`** — Inline SVG wordmark. Two cards (emerald + blue) leaning toward a gold balance point — reinforces the palette's "sides are emerald/blue, balance is gold".
**`src/components/BetaBadge.tsx`** — Small kicker pill that renders when `isBetaChannel()` returns true. Tooltip reveals commit + build time.

### Shared UI primitives

**`src/components/ui/StatusBadge.tsx`** — `TradeStatus` chip (pending / accepted / declined / cancelled / expired / countered). Used by `TradesHistoryView` and `TradeDetailView`. Parallel to — not the same as — HomeView's `StateBadge` for `TradeRowState`.
**`src/components/ui/states.tsx`** — `LoadingState`, `EmptyState`, `ErrorState` card primitives. Every list-fetching view picks up these to stay visually consistent.
**`src/components/ui/ErrorBoundary.tsx`** — One instance wraps the whole app at root; per-view boundaries with a scoped `fallback` can nest inside later.

### Routing / view switch

**`src/routing/config.ts`** — `ViewMode` union, `VIEW_ROUTES` table, `detectViewMode()`, `isStandaloneView()`, `VIEW_PARAM_KEYS`, `TRADE_CODEC_KEYS`, `TRADE_INTENT_KEYS`.
**`src/App.tsx`** — `renderBody()` switch at line 421, the `nav` memo at line 267 (implements `NavigationApi`), the popstate handler at line 180, and the `isSignedInRef` live-ref at line 176. Also owns `handleStartTrade` (the legacy pre-`nav` entry point, still used by `<ListView>` + `<ProfileView>` Start-trade CTAs).
**`src/main.tsx`** — Provider stack. Order matters; see "Data flow" below.

### Global contexts

**`src/contexts/AuthContext.tsx`** — Thin wrapper around `useAuth()` so every view reads from one source. Owns `user`, `isLoading`, `isSignedIn`, `botInstallUrl`, `login`, `logout`.
**`src/contexts/CardIndexContext.tsx`** — Cross-printing indexes (`byFamily`, `byFamilyAll`, `byProductId`, `allLoadedCards`) derived from the price catalog. Lives BELOW `<PriceDataProvider>` in `main.tsx` so it can read the catalog.
**`src/contexts/DrawerContext.tsx`** — Shared ListsDrawer open-state + `requestedTab` hint (UX-A1). One drawer, one open boolean.
**`src/contexts/NavigationContext.tsx`** — `NavigationApi` interface + Provider. `useNavigation()` throws if mounted outside the provider — catches misuse at render time.
**`src/contexts/PriceDataContext.tsx`** — Price catalog wrapper. Calls `loadAllSets()` once on mount so every view starts with the full index available.
**`src/contexts/PricingContext.tsx`** — Shared `percentage` + `priceMode` knobs with `Raw` setters that bypass localStorage (used by `useTradeUrl`'s URL-restore path).

### Utils

**`src/utils/dialogFocus.ts`** — `preventAutoFocus` helper for Radix `Dialog.Content` `onOpenAutoFocus` props. Skips programmatic focus so Chromium doesn't paint a `:focus-visible` ring on whichever button happens to be first in the dialog DOM.

## Data model

This area doesn't own a schema table — it orchestrates shapes read from elsewhere. The non-obvious types are:

### `ViewMode` (`src/routing/config.ts:25`)

```
'home' | 'list' | 'trade' | 'profile' | 'settings'
| 'community' | 'trade-detail' | 'trades-history' | 'session'
```

**Invariants:**
- SSR fallback is `'trade'` (no window → `detectViewMode` returns early at `src/routing/config.ts:213`). Matches the original pre-extraction behavior.
- For a bare URL (no params, no special pathname) the fallback depends on `isSignedIn`: signed-in → `'home'`, signed-out → `'trade'`. This is the only branch that reads `isSignedIn`; every other `matches()` predicate is URL-only.
- `STANDALONE` views (`profile`, `settings`, `community`, `trade-detail`, `trades-history`, `session`) are treated differently by `useTradeUrl` — it skips its merge-write on these to avoid stripping params it doesn't understand.

### Signed-in hint — `swu.signedInHint` localStorage key

Stored as `'1'` when true, absent otherwise. Read on `useAuth()` mount into `initialHint` (`src/hooks/useAuth.ts:67`). `isSignedIn` combines the hint with loading state: `!!user || (isLoading && initialHint)` — meaning during the `/api/auth/me` round-trip we believe the hint; after it resolves, `!!user` is authoritative. Writes happen on every `/api/auth/me` response (success writes true, failure writes false) and on logout (clears).

### `BreadcrumbSegment` (`src/components/ui/Breadcrumbs.tsx:28`)

```ts
{ label: string; href?: string }
```

**Invariant:** the last segment is the current page and omits `href`. The AppHeader Back button (`AppHeader.tsx:79`) reads the second-to-last segment's `href` as the parent URL — if that segment lacks `href`, no Back button renders.

### `NavigationApi` (`src/contexts/NavigationContext.tsx:28`)

Ten methods named by destination. Every method that sets an intent param guarantees the intent state is mirrored; every method that navigates away from the trade builder clears stale intent. Options bags (`{ tab?, guildId?, memberHandle? }`) are open-shaped so new drill-down keys can land without breaking existing callers.

## Public surface

### Hooks / contexts

- **`useAuthContext()`** — returns `AuthApi`. Throws outside the provider. Every view reads user/isSignedIn/login/logout from here.
- **`useCardIndexContext()`** — returns `{ byFamily, byFamilyAll, byProductId, allLoadedCards }`. `byFamily` prefers the `Standard` variant when multiple printings exist (`src/contexts/CardIndexContext.tsx:34`) — that's the "representative" printing used for display.
- **`useDrawerContext()`** — returns `{ listsDrawerOpen, openLists, closeLists, setListsDrawerOpen, requestedTab, clearRequestedTab }`. `openLists(tab?)` sets `requestedTab` as a hint; ListsDrawer consumes + clears on mount.
- **`useNavigation()`** — returns `NavigationApi`. Throws outside `<NavigationProvider>`.
- **`usePriceDataContext()`** — returns the price catalog + load functions. Calls `loadAllSets()` once on provider mount.
- **`usePricing()`** — returns `{ percentage, setPercentage, setPercentageRaw, priceMode, setPriceMode, setPriceModeRaw }`. `Raw` setters bypass localStorage persistence.

### Components

- **`<AppHeader>`** — pass `auth`, optional `breadcrumbs`, optional `slim`. Every view that isn't "slim mode" mounts this at its root. Slim mode hides NavMenu + AccountMenu for shared-link / pre-signup surfaces. The `onOpenLists` prop was removed in the 2026-04-21 split — the drawer is now trade-builder-local and the NavMenu doesn't offer a "My Lists" entry.
- **`<Breadcrumbs>`** — typically consumed via `AppHeader`'s `breadcrumbs` prop. Single DOM tree; non-current segments hide on mobile via Tailwind `md:` utilities (Playwright strict-mode locators depend on "current page renders exactly once").
- **`<NavMenu>`** — consumed internally by `AppHeader`. Exports are the component itself.
- **`<AccountMenu>`** — consumed internally by `AppHeader`.
- **`<ErrorBoundary>`** — root instance in `main.tsx`. Takes an optional `label` + `fallback`.
- **`<LoadingState>`, `<EmptyState>`, `<ErrorState>`** — shared list-fetch primitives.

### Exports from `src/routing/config.ts`

- `detectViewMode(isSignedIn: boolean): ViewMode`
- `isStandaloneView(parts: RouteParts): boolean`
- `VIEW_ROUTES`, `VIEW_PARAM_KEYS`, `TRADE_CODEC_KEYS`, `TRADE_INTENT_KEYS`
- `type ViewMode`, `type ViewRoute`, `type RouteParts`

## State + data flow

### Boot sequence (signed-in, returning user)

1. `main.tsx` mounts `<ErrorBoundary>` → `<AuthProvider>` → `<PriceDataProvider>` → `<CardIndexProvider>` → `<DrawerProvider>` → `<PricingProvider>` → `<App/>`. Order matters: `CardIndexProvider` reads `usePriceDataContext()` inside; `App` reads all of the above.
2. `AuthProvider` runs `useAuth()`, which reads `swu.signedInHint` synchronously into `initialHint` and fires `GET /api/auth/me`. During the in-flight request, `isSignedIn` is `true` via the hint alone.
3. `App` renders. `useState(() => detectViewMode(isSignedIn))` seeds `viewMode` using the hint — a returning user on a bare URL lands directly on `'home'` with no flash of `'trade'`.
4. `PriceDataProvider`'s mount effect calls `loadAllSets()` — catalog begins streaming in. `CardIndexProvider` rebuilds its `useMemo` each time `cards` changes.
5. `/api/auth/me` resolves. If confirmed signed-in, the hint stays set and nothing visible changes. If signed-out, the hint clears and the `useEffect` at `src/App.tsx:194` re-runs `detectViewMode(false)` — if `prev` was `'home'` or `'trade'` we flip; any explicit view sticks.

### In-app navigation (e.g., Home → Trades history)

1. Click handler calls `nav.toTradesHistory()`.
2. `nav.toTradesHistory` (`src/App.tsx`) computes the next `URLSearchParams`:
   - `reset([])` drops every key in `VIEW_PARAM_KEYS` from the current params (so a stale `settings=1` or `community=1` can't survive).
   - Adds `trades=1` via the `extras` parameter.
3. `pushTo(next)` writes `window.history.pushState(null, '', ...)` and calls `setViewMode(detectViewMode(isSignedIn))` — the new URL has `?trades=1`, which matches the trades-history route rule (`src/routing/config.ts:146`), so `viewMode` flips to `'trades-history'`.
4. Intent state isn't touched — trades-history doesn't own any trade-composer intent.

These atomic writes (URL, `viewMode`, intent) are the in-lockstep triad every `nav.toX()` method guarantees by construction. The pre-`nav` code path had them scattered across inline closures, which caused a Home → Propose regression (`aeb0aa2`) — the URL got `?propose=...` but `useTradeIntent` never re-read it, so the composer stayed blank. Propose-to-a-handle nav happens via full-page `<a href="/?propose=handle">` links (from ProfileView + related surfaces) — those trigger App re-mount, which naturally re-reads URL + intent + viewMode in sync without needing a dedicated `nav.toX()` method.

### popstate (browser back/forward)

1. User clicks browser back. `window.location` changes; React state does NOT automatically re-render.
2. Two independent handlers fire:
   - `App`'s popstate listener at `src/App.tsx:180` calls `setViewMode(detectViewMode(isSignedInRef.current))`. The `isSignedInRef` live-ref is the trick — the effect runs once on mount, so closing over `isSignedIn` directly would capture a stale value forever. The ref is kept fresh by a separate effect at line 177.
   - `useTradeIntent`'s popstate listener (`src/hooks/useTradeIntent.ts:106`) re-reads the URL and resets its state.
3. Both updates land in the same tick, `App` re-renders, the right view + right intent both arrive.

### Signed-in flicker fix — the full story

Without the hint, the first render of a returning user on `/` would:
- `isSignedIn` starts `false` (user is still loading, `initialHint` is `false`)
- `detectViewMode(false)` on a bare URL falls through to the trade rule, returns `'trade'`
- Trade-builder briefly paints
- `/api/auth/me` resolves, the `useEffect` on `isSignedIn` runs `detectViewMode(true)` → flips to `'home'`

The hint (`swu.signedInHint`) is a best-effort prediction of what the server will say. It's written on every confirmed auth response and cleared on logout / confirmed-not-signed-in. It's not a trust surface — a hint of "signed in" that the server contradicts is self-correcting because the `useEffect` at `src/App.tsx:194` depends on `isSignedIn` (the derived flag, not `user`) — a stale true-hint that resolves to "actually signed out" still re-runs the effect and flips us back to `'trade'`.

The "bare URL" guard at line 198 (`if (prev !== 'home' && prev !== 'trade') return prev;`) means an explicit view like `settings=1` is never overwritten by the auth-resolve flip, only the two implicit defaults.

### `NavigationApi` — three-step shape, per method

Each `nav.toX()` method follows the same three steps:

1. Compute next URLSearchParams via `reset(keep, extras)`. `reset` always drops every key in `VIEW_PARAM_KEYS` then re-adds `keep` (preserved params) and `extras` (this destination's new params).
2. `pushTo(next)` pushes the URL and runs `setViewMode(detectViewMode(isSignedIn))`.
3. Mirror intent state: views that set intent params (`toBuildTrade`) call `intent.setIntent(...)`; views that leave the composer (`toHome`) call `intent.clearIntent()`. Views that don't touch intent (`toSettings`, `toCommunity`, `toProfile`, `toTradeDetail`, `toTradesHistory`) leave intent alone — this matches the "user has a half-built propose, peeks at Community, comes back" mental model.

`toSession` is the one exception: it does a full-page `window.location.href` navigation rather than pushState, because session state is server-authoritative (there's no SPA state worth preserving across session boundaries) and SessionView's mount needs to cleanly read the pathname.

### Provider order (`src/main.tsx:17`)

```
ErrorBoundary
└── AuthProvider
    └── PriceDataProvider
        └── CardIndexProvider
            └── DrawerProvider
                └── PricingProvider
                    └── App
```

Order matters:
- **ErrorBoundary outside providers** — a throw in provider init itself still surfaces the fallback instead of a blank page.
- **AuthProvider outermost** — most downstream hooks (server sync, matchmaker, community) need `user` to decide whether to fetch.
- **PriceDataProvider before CardIndexProvider** — CardIndexContext's `useMemo` reads `cards` from PriceDataContext. Flipping the order would `throw 'usePriceDataContext must be used inside PriceDataProvider'`.
- **DrawerProvider before PricingProvider** — no dependency either way; current order is arbitrary.
- **PricingProvider below everything** — nothing reads Pricing before App, so it can be innermost.

`NavigationProvider` is mounted INSIDE `App` (not in `main.tsx`) because the `nav` object closes over app-level setters (`setViewMode`, `intent.setIntent`, `filters.clearAll`). Keeping the provider inside `App` means the hook can always resolve; the consumer throws at render time instead of silently no-oping.

## URL shapes (the full catalogue)

Every URL shape the SPA must serve, with its routing rule and the backing rewrite. The smoke spec at `e2e/routes-smoke.auth.spec.ts` covers all of these — each route is expected to return 200, render the app chrome, and emit no unexpected console errors.

| URL shape | View mode | Matched by | Backed by |
|---|---|---|---|
| `/` (signed-in) | `home` | `src/routing/config.ts:196` fallback | SPA default |
| `/` (signed-out) | `trade` | `src/routing/config.ts:196` fallback | SPA default |
| `/?view=home` | `home` | explicit `view=home` | SPA default |
| `/?view=trade` | `trade` | explicit `view=trade` | SPA default |
| `/?view=list` | `list` | explicit `view=list` | SPA default |
| `/?trades=1` | `trades-history` | `trades=1` | SPA default |
| `/?trade=<id>` | `trade-detail` | `params.has('trade')` | SPA default |
| `/?profile=<handle>` | `profile` | `params.has('profile')` (after settings/community/trades/trade-detail) | SPA default |
| `/u/<handle>` | `profile` | `/^\/u\//.test(pathname)` | `vercel.json` rewrite → `/?profile=<handle>` |
| `/u/<handle>/<tab>` | `profile` | (same) | `vercel.json` rewrite → `/?profile=<handle>&tab=<tab>` |
| `/?settings=1` | `settings` | `settings=1` | SPA default |
| `/?settings=1&tab=X` | `settings` | (same) | SPA default |
| `/?community=1[&guild=X]` | `community` | `community=1` | SPA default |
| `/s/<code>` | `session` | `/^\/s\//.test(pathname)` | `vercel.json` rewrite → `/` |
| `/?view=list&w=...&a=...` | `list` | explicit or implicit w/a | SPA default |
| `/?propose=<handle>` | `trade` | trade-intent key | SPA default |
| `/?counter=<tradeId>` | `trade` | trade-intent key | SPA default |
| `/?edit=<tradeId>` | `trade` | trade-intent key | SPA default |
| `/?view=trade&from=<handle>[&autoBalance=1]` | `trade` | trade-intent key | SPA default |

The full rewrite list lives in [`j-infra.md`](./j-infra.md); the ones above are the routing-critical ones. The smoke spec's `routes` array at `e2e/routes-smoke.auth.spec.ts:33` mirrors this table — when a new rewrite lands, both get extended together.

### Why session ids go in the pathname, not the query

Sessions use `/s/<code>` because:
- It's shorter and QR-friendly ("scan this code, go to /s/XYZ123") — pasteable into Discord without URL-param baggage.
- Shared-link trade URLs already use query params (`?w=...&a=...`) and mixing concerns would muddy "which param is a session vs which is a shared list."
- The `vercel.json` rewrite `{ source: "/s/:id", destination: "/" }` is trivial; no destination params needed because `SessionView` reads the pathname directly at `src/App.tsx:484`.
- `toSession` does a full-page navigation (not pushState) — there's no need for the pathname to be SPA-writable.

### Why profile supports both `?profile=<handle>` AND `/u/<handle>`

Both forms exist deliberately:
- `?profile=<handle>` is what the SPA writes internally via `nav.toProfile(handle)` — it's a cheap pushState, no reload.
- `/u/<handle>` is the shareable URL shape — cleaner in Discord messages, SEO-friendly. Vercel rewrites it to `/?profile=<handle>` so the SPA sees exactly one form internally (see the "pathname form" pattern in `readProfileHandle()` at `src/App.tsx:52`).

The `detectViewMode` rule order matters: the `/u/` pathname check is FIRST (`src/routing/config.ts:128`) and the `?profile=` query check is AFTER settings/community/trades/trade-detail — that's so hand-crafted combos like `?profile=x&settings=1` still route to Settings (matches pre-refactor behavior).

### Why `STANDALONE` views skip URL-codec stripping

`useTradeUrl`'s merge-write strips trade-codec keys (`y`/`t`/`pct`/`pm`) and re-writes them on every trade mutation. On a non-trade view (profile, settings, community, etc.) those keys don't exist, but its OWN keys (`guild`, `tab`, `members`, `user`, `profile`) do — naively running the merge would blow them away. The `isStandaloneView()` check at `src/routing/config.ts:239` is useTradeUrl's bail condition: if the current URL matches a standalone view, don't touch the URL at all. (`home` and `list` are considered "trade-adjacent" — the former is a dashboard that shares the same app chrome, the latter transitions into the composer, so their URLs are safe for trade-codec writes.)

## UI/UX patterns

### AppHeader layout

```
[Logo SWUTRADE] [←Back]  [Home › Settings › Servers]  [NavMenu] [AccountMenu]
                                                   ↑
                                         Mobile: collapses to just
                                         the current page label;
                                         Back button carries the
                                         "go up one level" semantic
                                         on both mobile + desktop.
```

- Fixed-ish, `z-40` stacking context so drawers (`ListsDrawer` at `z-50`) overlay cleanly.
- Space-900/80 background + backdrop-blur — the view scrolls under it but stays legible.
- No contextual-action slot. View-specific CTAs (Share, Clear, Invite someone, Done on settings) live in a per-view action strip BELOW the header. This was a 2026-04-19 refactor — pre-refactor the header had a mix of identity + action chrome and couldn't scale to breadcrumb-heavy views without the CTAs getting starved of width.

### 3-module dashboard (`HomeView.tsx`)

Desktop:
```
┌────────────────── NeedsResponseCallout (full width) ───┐
├──────────────────────────┬──────────────────────────────┤
│ My Trades (action)       │ Your binder (resource)       │
│ Your wishlist (action)   │                              │
├──────────────────────────┴──────────────────────────────┤
│ My Stores (placeholder, full width, dashed border)      │
└─────────────────────────────────────────────────────────┘
```

Mobile collapses to a single column in priority order: Trades, Wishlist, Binder, Stores.

Visual language:
- `ModuleSection` is the shared chrome — rounded-xl, `bg-space-800/20` wash, uppercase tracked-label header with icon, optional right-aligned action link.
- `NeedsResponseCallout` uses gold: `border-gold/40 bg-gold/8`. The callout reads as "attention required" without being alarming. Single-row expanded at a time — tapping a new row collapses the previous peek.
- Gold column-left border is reserved for the callout ONLY — the module panels use neutral space-700 borders so the callout visually dominates.

The split from one ListsModule into two first-class modules (WishlistModule + BinderModule) was the UX-A1 audit change. Rationale: "these are my cards" is load-bearing for the trading loop, not a sidebar affordance. Priorities still pin to the top via the `isPriority` boolean sort.

`CommunitiesModule` occupies the top-right quadrant alongside `TradesModule`. Short history: deleted entirely in UX-A4 (2026-04-21) on the theory it competed with the trading loop, then reinstated the same day — removing it left a blank quadrant and buried enrolled servers behind the hamburger menu. The reinstated version is a peer module (not a sidebar widget): icon + "My Communities" label, enrolled-guild count + total trader count header stats, up to 5 rows of guild name + member count sorted by traders descending, "Browse all →" action that routes to `/?community=1`. Each row deep-links to `/?community=1&guildId=<id>` so clicking a server lands on that server's page directly, not the general community hub.

### State badge palette (the canonical trade-state language)

From `src/components/HomeView.tsx:517`:

| Tone | Trade states | CSS |
|---|---|---|
| cyan | `shared`, `shared-waiting` | `bg-cyan-900/40 border-cyan-500/40 text-cyan-200` |
| gold | `awaiting`, `pitched` | `bg-gold/15 border-gold/40 text-gold` |
| emerald | `settled` | `bg-emerald-900/40 border-emerald-500/40 text-emerald-300` |
| red | `declined` | `bg-red-900/40 border-red-500/40 text-red-300` |
| neutral | `cancelled`, `expired` | `bg-space-700/60 border-space-600 text-gray-400` |
| purple | `countered` | `bg-purple-900/40 border-purple-500/40 text-purple-300` |

Semantic mapping: cyan = active/in-flight (session), gold = attention-pending (proposal awaiting), emerald = terminal-positive, red = terminal-negative, neutral = terminal-nonevent, purple = terminal-with-followup.

This respects the SWU palette invariants: emerald + blue are side colors, gold is primary chrome, and the non-side tones (cyan / purple / red / neutral) carry state orthogonal to the side-identity dimension. `StatusBadge.tsx` (the history/detail equivalent) uses a parallel mapping over the `TradeStatus` union — they're not unified because the state unions diverge (proposals don't have a `shared` state; sessions don't have a `countered` state).

### Ghost home

Intentionally minimal. The gold-bordered greeting card uses the same chrome as the Needs-Response callout on the real HomeView — ghost users recognize "gold-bordered card at the top = attention-worthy" even if the semantics are different (sign-in CTA vs respond to proposals). Below it: a simple `<ul>` of active sessions, each row being an anchor tag (not a button) so middle-click / cmd-click / right-click open-in-new-tab work. No state badges, no expand peek — ghosts only have in-flight sessions, the richer chrome would be noise.

### AccountMenu vs NavMenu

Deliberately two menus:
- **NavMenu** is "where do I want to go" — Home / My Wishlist / My Binder / My Trades / My Communities. Hamburger icon.
- **AccountMenu** is "who am I and how do I manage it" — Profile / Settings / Sign out, OR Sign in with Discord for signed-out.

Beta feedback drove the split — users read a "My Lists" entry inside the account menu as "account data" (like settings) rather than "my content." Two affordances match the two mental models. On mobile the two buttons sit side-by-side in a 1.5-gap cluster at the right edge of the header.

### Version indicator (footer)

The App.tsx footer at line 825 shows:
- `beta` or `v` prefix based on `isBetaChannel()` (`src/version.ts:11`)
- `APP_COMMIT` (7-char short hash)
- If beta: `· built <Xm/h/d ago>` to surface build freshness at a glance

Build metadata flows in via Vite's `define` plugin at `vite.config.ts:21` — `__APP_COMMIT__` comes from `VERCEL_GIT_COMMIT_SHA` (set by Vercel at build) or local `git rev-parse HEAD` as a fallback; `__APP_BUILD_TIME__` is `new Date().toISOString()` at build time. `isBetaChannel()` returns true on `beta.*` hostnames, Vercel's `-git-beta-` preview URLs, and `localhost` (dev builds are beta-channel territory).

## Tech debt + known gaps

- **~~4-bar mutex on trade-builder~~ — shipped UX-A2 (2026-04-20)**. `EditBar`, `CounterBar`, `ProposeBar`, and `AutoBalanceBanner` still render via a ternary chain, but each composer bar's primary action (Send/Save) now registers via `usePrimaryAction` and lands in a shared `<PrimaryActionBar>` below TradeBalance. The four-mutex bars themselves are now informational-only.
- **~~Communities module competes with trading loop~~ — shipped UX-A4 then walked back (2026-04-21)**. `CommunitiesModule` was removed from HomeView and then reinstated within hours. Removal over-corrected: the theory was that Communities competed with the trading loop on Home, but deleting it left a blank quadrant in the grid and buried enrolled servers behind a hamburger menu. The walk-back promoted Communities into the top-right quadrant as a peer module next to Trades and simultaneously deleted the `StoresModule` Phase-4 placeholder (reserving real estate for an unshipped feature wasn't worth the visual noise). The new 2×2 grid is: row 1 = Trades / Communities (active surfaces), row 2 = Wishlist / Binder (inventory).
- **~~Ghost → real-user merge banner~~ — shipped UX-A5 (2026-04-21)**. OAuth callback flags `pendingMergeBanner: { carriedCount }` on the new session cookie when ghost→real merge moved ≥1 session; `<MergeReassuranceBanner>` renders a one-shot toast + clears on dismiss via `/api/auth/dismiss-merge-banner`.
- **Profile-nav inconsistencies (UX-A6)** — two forms (`?profile=` + `/u/`) is deliberate but uneven UX in practice: the AccountMenu's "Public profile" link uses `/u/`, while the NavMenu and in-view CTAs use `?profile=` or `/u/` inconsistently. Not broken; could be tidier.
- **`NavigationProvider` mounts inside App, not main.tsx** — intentional (nav needs closure access to app setters), but it means any future "page shell" extraction that tries to mount a header/footer outside `<App>` would break nav. Not a near-term concern; documented here so the constraint is visible.
- **`isSignedInRef` live-ref pattern is subtle** — the popstate effect at `src/App.tsx:180` depends on `[]` (runs once on mount) and reads `isSignedInRef.current`. If someone future-refactors this effect to depend on `[isSignedIn]`, the re-adding of the listener on every auth change would work but add churn. The ref pattern is slightly more efficient and matches the "listener outlives closure" shape.
- **`PriceDataProvider.loadAllSets()` fires unconditionally on mount** — every page load downloads the full catalog, even on lightweight views (ghost home, profile). Acceptable today (catalog is small-ish), but a per-view lazy-load would scale better as the card pool grows.
- **`isBetaChannel()` returns true on localhost** — dev builds always render the beta badge + "built X ago" hint. Harmless but occasionally confusing during demos where the host is a local tunnel.
- **Error boundary is root-only** — a crash inside one view takes down the whole app shell. The `fallback` prop on `ErrorBoundary` is designed for per-view boundaries (`label="TradeDetailView"`, scoped fallback) but none are mounted yet. When a view is unstable enough to warrant one, wrap it in its own boundary at the view's mount point.
- **No client error reporter** — `ErrorBoundary.componentDidCatch` currently console.errors only. The hook point is documented in the file comment (`src/components/ui/ErrorBoundary.tsx:29`). Crosses into the NEXT.md "Later" queue.
- **Trade-builder page owns too much** — `src/App.tsx` is >1000 lines and mixes view routing, the `nav` memo, and the trade builder body itself. The view switch + `nav` are this area's concern; the trade-builder body belongs to [`c-trade-builder.md`](./c-trade-builder.md) but shares the file. A future split is plausible; mentioned here so the next reader knows where the seam should fall.

## Decisions worth remembering

- **One `NavigationApi` over per-view nav closures** — before commit `aeb0aa2` every view had its own inline closure that wrote URL + called `setViewMode` but forgot (variously) to clear stale intent or sync `useTradeIntent`. The class of bug was "URL says propose, composer shows empty because intent state is stale." The `nav.toX()` shape enforces the triad (URL + state + viewMode) by construction. Every in-app nav now goes through this seam — no exceptions — and the cost of adding a new destination is a single method on the interface + one entry in `renderBody()`.
- **Query-param routing over client-side router library** — no React Router. `detectViewMode` is pure and testable; rewrites handle the pathname shapes that can't be query-only (`/s/<code>` because it's shared publicly; `/u/<handle>` because it's shareable). Adding React Router would require every view's URL to become a Route config and would fight the "intent params override view params" rule that the fall-through chain naturally expresses.
- **Split NavMenu + AccountMenu** — beta feedback; matches user mental model of "content nav" vs "identity nav." See "UI/UX patterns" above. A single menu is simpler but the friction was real.
- **AppHeader has NO action slot** — per-view action strips (the trade-builder's toggle + share + clear row at `src/App.tsx:534`) own their own CTAs. Rationale: breadcrumbs can be long, CTAs benefit from per-view design (hero on profile, tight strip on settings), and centralizing would force a shared compromise none of the views want. Header is identity + orientation + global nav only.
- **Two menus rather than one mega-menu** — related to the split above; also, keeping NavMenu's content-nav entries in a dedicated popover means it can be hidden entirely on the slim-header variant (shared-link views) without also hiding identity affordances.
- **Signed-in hint is a localStorage flag, not a full auth cache** — we pre-seed routing with a bit, not a user object. Server remains the trust surface for every actual call; the hint's only job is to steer the first render. Writing the full user blob to localStorage would create a subtle "who am I" source-of-truth split.
- **Session nav is a full-page navigation, not pushState** — `nav.toSession` at `src/App.tsx:334` uses `window.location.href = /s/<id>`. Session state is server-authoritative; there's no composer-in-progress worth preserving across session boundaries, and SessionView's mount needs a clean URL read. pushState would add a popstate-handling burden for no benefit.
- **`renderBody` branches, not a component map** — `src/App.tsx:421` is a series of `if (viewMode === X)` returns. A lookup table `{ home: HomeView, settings: SettingsView, ... }` would be terser but would lose the per-branch wiring (different props, different breadcrumbs, ghost-variant swap). The branches also make the view → behavior coupling explicit for readers.
- **Order of `VIEW_ROUTES.matches()` predicates is load-bearing** — documented at `src/routing/config.ts:94`. Reordering would change which view wins for hand-crafted URL combos (e.g., `?profile=x&settings=1` → Settings because settings is matched earlier). Tests in `e2e/routes-smoke.auth.spec.ts` exercise the most common URL shapes; hand-crafted combos are covered implicitly by the "view owns its keys" rule.
- **`CardIndexContext` over prop drilling / per-view rebuilds** — before the R1 foundation refactor each view rebuilt its own `byFamily` / `byProductId` maps from `cards`. The "ListsDrawer rendered familyId slugs" regression was caused by a drift between two different rebuilds. One source, many readers.

## Cross-references

- [`a-sessions.md`](./a-sessions.md) — session view, `/s/:id` canvas, QR handoff; consumes this area's `nav.toSession`.
- [`b-proposals.md`](./b-proposals.md) — proposal lifecycle; `useMyTrades` (consumed by HomeView) merges proposal rows into the unified TradeRow stream.
- [`c-trade-builder.md`](./c-trade-builder.md) — trade composer body, URL codec, the four-bar chain. Shares `src/App.tsx` with this area.
- [`d-lists.md`](./d-lists.md) — wants + available shapes that WishlistModule / BinderModule render, and the ListsDrawer that `DrawerContext` controls.
- [`f-community-profile.md`](./f-community-profile.md) — the content of `CommunityView`, `ProfileView`, and `SettingsView`. This page documents the *routes* into those views; that page documents what they render.
- [`g-auth.md`](./g-auth.md) — `useAuth`, Discord OAuth, ghost → real user merge. `AuthContext` is a thin wrapper around that hook.
- [`h-cards-pricing.md`](./h-cards-pricing.md) — price catalog + pricing pipeline that `PriceDataContext` + `PricingContext` surface.
- [`i-discord-bot.md`](./i-discord-bot.md) — bot interactions; no direct coupling to routing, but `botInstallUrl` from `AuthApi` is passed through.
- [`j-infra.md`](./j-infra.md) — full `vercel.json` rewrite list, CI pipeline, function topology. The table above quotes the routing-critical rewrites.
