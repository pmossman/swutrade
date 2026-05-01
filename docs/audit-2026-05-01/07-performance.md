# Performance audit — 2026-05-01

## High-impact findings (top 5)

### 1. `countUnreadEvents` SELECTs every event row instead of `COUNT(*)`
- **What:** The session unread-badge computation pulls *all* rows for a session and filters in JS.
- **Where:** `lib/sessions.ts:361-384` (`countUnreadEvents`), called from `getSessionForViewer` line 274–277. Hit on every `useSession` poll.
- **Why it matters:** `useSession` polls at `POLL_INTERVAL_MS = 2500` (`src/hooks/useSession.ts:193`). For an active session with N timeline events (edits, snapshots, chats, suggestions all live in `session_events`), each tab pulls O(N) rows every 2.5s — 24 round-trips/min per open tab — to derive a small integer. A 1-hour active session with 200 events × 2 participants polling = ~10k rows/min of pure waste, and the row size grows with `payload` JSON (edit-snapshots carry full card lists).
- **Proposed fix:** Replace with `db.select({ n: count() }).from(sessionEvents).where(and(eq(sessionId, X), eq(type, 'chat'), ne(actorUserId, viewer), gt(createdAt, lastReadAt)))`. Add a partial index on `(session_id, type) WHERE type = 'chat'` if EXPLAIN warrants. Same `Promise.all` shape with `listEventsForSession` already exists at line 274.
- **Risk:** low / **Effort:** XS / **Confidence:** very high

### 2. N+1 in signal embed assembly: 2 queries per row, same row
- **What:** `resolveFamily` and `resolveVariantSpec` each issue a SELECT against `wants_items`/`available_items` keyed by the *same* row id. Both run sequentially per signal row inside `Promise.all(map)`.
- **Where:** `api/signals.ts:577-628` (helpers), `api/signals.ts:462-480` (cancel), `api/signals.ts:539-555` (listMine), `api/bot.ts:705-722` and `api/bot.ts:1021-1040`.
- **Why it matters:** `handleListMine` runs on every Signals view mount. For a user with 8 active signals across 3 groups, that's 16 SELECTs where 2 (one wants, one available batched by `inArray(id, [...])`) would do. The bot endpoints fan out 2× the signal count on every cancel/refresh interaction — each one a Discord-blocking round-trip.
- **Proposed fix:** Batch upstream — collect distinct `wantsItemId`s and `availableItemId`s, two `inArray()` SELECTs to build lookup maps, then resolve family + variantSpec from the maps synchronously. Drop `resolveFamily`/`resolveVariantSpec` per-row helpers in favor of a `resolveSignalCardsBatch(rows)`.
- **Risk:** low / **Effort:** S / **Confidence:** very high

### 3. Context Provider values are not memoized — entire trees re-render on every parent re-render
- **What:** `AuthProvider`, `PriceDataProvider`, `PrimaryActionProvider` build a fresh `value={...}` object literal on each render with no `useMemo`.
- **Where:** `src/contexts/AuthContext.tsx:8` (`<AuthContext.Provider value={auth}>` — `useAuth` itself returns a fresh object each render at `src/hooks/useAuth.ts:123-132`), `src/contexts/PriceDataContext.tsx:23-33`, `src/contexts/PrimaryActionContext.tsx:67-89`. App-wide consumers: every view reads `useAuthContext()` (≥15 component files), `usePriceDataContext()` from `App.tsx:153`.
- **Why it matters:** The 60-second tick at `App.tsx:408-412` (`setMinuteTick`) re-renders App, which re-runs `useAuth` → fresh `auth` object → every `useAuthContext()` consumer re-renders, even when no auth state changed. Compounded with `usePriceDataContext` consumers. Effect is most visible during session polling: every `useSession` setState bubbles new context values to dozens of components.
- **Proposed fix:** Wrap each provider value in `useMemo` keyed on the underlying primitives. For `useAuth`, return `useMemo(() => ({ user, isLoading, ... }), [user, isLoading, botInstallUrl, pendingMergeBanner, ...])`.
- **Risk:** low / **Effort:** S / **Confidence:** high

### 4. Zero route-level code splitting; ~9k LOC of view code in the entry bundle
- **What:** Every view (HomeView 1206, SessionView 1327, SettingsView 1103, CommunityView 952, SignalBuilderView 817, TradesHistoryView 694, ProfileView 638, BinderView, WishlistView, TradeDetailView) is statically imported in `src/App.tsx:34-58`. No `React.lazy` anywhere in `src/`.
- **Why it matters:** A first-paint visitor on the trade-builder route still ships SettingsView, CommunityView, and SignalBuilderView in the initial JS even though they're never reached. `qrcode.react` (`SessionView`, `ListsDrawer`) and `@tanstack/react-virtual` (only used by `CardResultsGrid`) ride along too.
- **Proposed fix:** `const SessionView = React.lazy(() => import('./components/SessionView'))` for the half-dozen non-trade-builder routes, wrap `renderBody()` in `<Suspense fallback={<LoadingState />}>`. Keeps the trade-builder hot path lean. Likely 30–40% initial JS reduction.
- **Risk:** low / **Effort:** S / **Confidence:** high

### 5. Redundant fetches: `useFavorites`, `useRecentPartners`, `useCommunityCards`, `useMutualBotGuilds` lack the module-scoped cache the other hooks share
- **What:** Hooks that use `createSingletonCache` / `createKeyedCache` deduplicate cross-component fetches; these four don't.
- **Where:** `src/hooks/useFavorites.ts` (no cache; mounted by both `HomeView.tsx:94` and `HandlePickerDialog.tsx:44`), `src/hooks/useRecentPartners.ts`, `src/hooks/useCommunityCards.ts`, `src/hooks/useMutualBotGuilds.ts`. Compare to `useTradesList.ts`, `useGuildMemberships.ts`, `useMyTrades.ts`, which import from `sharedCache.ts`.
- **Why it matters:** Opening HandlePickerDialog from Home triggers a redundant `/api/me/favorites` GET; navigating between views that each call `useGuildMemberships` would too without the existing cache. Each is one round-trip but they stack — a Home → Settings → Community sweep of a signed-in user pays for ~6 redundant requests.
- **Proposed fix:** Adopt `createSingletonCache<T>()` per hook; seed initial state from the cache, write on success. Existing pattern is two ~3-line additions per file.
- **Risk:** low / **Effort:** XS each / **Confidence:** high

## Lower-priority debt

- `api/me.ts:188-198` — `handlePrefsPeerGet` awaits `resolvePref` sequentially in a `for (def of peerDefs)` loop; should be `Promise.all`. Today peerDefs has one entry so impact is nil, but it's a footgun for the next peer pref.
- `api/me.ts:711-721` — `handleCommunityMembers` SELECTs `(userId, familyId)` and `(userId, productId)` rows for ALL visible members just to compute a `Set.size` "total" per user. Should be `SELECT user_id, COUNT(DISTINCT family_id) GROUP BY user_id`. Payload + memory grows linearly with community size.
- `api/trades.ts:188-197` and `:255-259` — `handlePropose` does two SELECTs against `users` for the proposer (handle, username, then discordId). One projection covers both.
- `lib/sessions.ts:223-264` — `getSessionForViewer` issues session row → counterpart user → events+unread as 1+1+(2 parallel) round trips. Counterpart could be a `LEFT JOIN` on the session SELECT, dropping a serial RTT from every 2.5s poll.
- `api/trades.ts:228-246` — `resolveTradeGuild()` and the proposer SELECT could run in `Promise.all` with the recipient resolution.
- `src/components/TradeRow.tsx` — not wrapped in `React.memo`. With 20-card trade sides typing one character anywhere in the parent tree re-renders every row + thumbnail. `useMemo` on `TradeSide`'s row map plus `memo(TradeRow)` would cut wasted work materially.
- `src/components/CardResultsGrid.tsx:92` — virtualization is in place; good. No action.
- No `React.memo` anywhere in `src/components/` (`grep -l 'React.memo' src/components/` is empty). At minimum, `TradeRow`, `CardTile`, `FamilyRow`, `CommunityMember` row components are leaf components rendered in lists and would benefit.
- `src/App.tsx:408-412` 60s `setMinuteTick` re-renders the entire App tree just to update "X ago" footer labels. Either lift the footer into its own component that tracks the tick, or make the timestamp display a self-updating leaf.
- `qrcode.react` is imported eagerly in `ListsDrawer.tsx:4` and `SessionView.tsx:2`; both surfaces show the QR conditionally — candidate for dynamic import.

## Anti-recommendations

- **Don't drop the 2.5s session poll cadence.** It's deliberate (`useSession.ts:187-192` documents the trade-off) and gated on `document.visibilityState === 'visible'` plus a `latestRef.current.status !== 'active'` skip. The right fix is making each poll cheaper (#1), not slower.
- **Don't add `React.memo` blanket-wide.** `TradeRow` and other leaf components in lists benefit; container components like `TradeSide` whose props mostly change every render would just pay the equality-check cost. Apply selectively.
- **Don't lazy-load the trade builder itself.** It's the default route for ghosts and signed-out users; lazy-loading would add a network hop to first paint for the most-used surface. Lazy-load *non-builder* views.
- **`lucide-react` is fine.** Both call sites (`HomeView.tsx:2-9`, `ProposeBar.tsx:3`) use named imports against the v1 ESM build, which Vite tree-shakes per-icon. No conversion to per-icon imports needed.
- **`useServerSync` debounce + `useCardSearch` 150ms debounce are both correct as-is.** Leave them.
- **The 60s `setMinuteTick` is cheap by absolute measure** (one re-render/min). It only graduates to a real concern *because* the context providers above don't memoize — fix those first and this becomes invisible.
