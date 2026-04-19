/**
 * Central view-mode routing config.
 *
 * Two concerns live here:
 *
 * 1. `detectViewMode` — which view the current URL should render.
 *    Extracted from App.tsx so the detection rules and the "what params
 *    does this view own" rules live in one place. Previously the two
 *    were coupled but split across App.tsx + useTradeUrl.ts with
 *    neither referencing the other.
 *
 * 2. `VIEW_ROUTES` — per-view `matches()` predicates + `paramKeys`.
 *    `useTradeUrl` consults this to decide whether to rewrite the URL
 *    on trade-state changes (it must bail when a non-trade-builder
 *    view owns the current URL, otherwise its merge-write strips
 *    profile/settings/community/etc. params on every card add).
 *
 * No behavior change vs the old hand-rolled switch + strip-guard. This
 * is a pure refactor — the `matches()` predicates replicate the exact
 * `detectViewMode` logic, including the /u/<handle> pathname check,
 * the trade-intent-keys fallback, and the bare-URL signed-in → home
 * vs signed-out → trade fallback.
 */

export type ViewMode =
  | 'home'
  | 'list'
  | 'trade'
  | 'profile'
  | 'settings'
  | 'community'
  | 'trade-detail'
  | 'trades-history';

/** Params that a trade-composer URL carries. Any of them → trade view. */
const TRADE_INTENT_KEYS = ['propose', 'counter', 'edit', 'from', 'autoBalance'] as const;

/** Trade-codec keys — owned by useTradeUrl's merge-write, NOT by a view's `paramKeys`. */
const TRADE_CODEC_KEYS = ['y', 't', 'pct', 'pm'] as const;

export interface RouteParts {
  pathname: string;
  params: URLSearchParams;
  isSignedIn: boolean;
}

export interface ViewRoute {
  /** Canonical view name (matches the ViewMode union in App.tsx). */
  mode: ViewMode;
  /** True when this URL matches this view. Given the current URL parts. */
  matches: (parts: RouteParts) => boolean;
  /** Param keys this route OWNS. useTradeUrl's merge-write preserves
   *  everything EXCEPT the trade-codec keys (y/t/pct/pm), so declare
   *  here which params belong to this view so other views' writes
   *  don't step on them. */
  paramKeys: readonly string[];
}

/**
 * Match predicates replicated from App.tsx::detectViewMode (pre-refactor).
 * The ORDER matters: the matchers are evaluated in declaration order and
 * the first match wins, mirroring the original if/return chain exactly.
 *
 * Order of precedence (do not reorder without updating tests):
 *   1. /u/<handle> pathname       → profile
 *   2. settings=1                 → settings
 *   3. community=1                → community
 *   4. trades=1                   → trades-history
 *   5. trade param present        → trade-detail
 *   6. profile param present      → profile (via ?profile=<handle>)
 *   7. view=list                  → list
 *   8. view=trade                 → trade
 *   9. view=home                  → home
 *  10. w/a present, no y/t        → list (implicit)
 *  11. y/t present                → trade (implicit)
 *  12. trade-intent keys present  → trade (matchmaker / propose / edit / counter)
 *  13. fallback                   → home (signed-in) | trade (signed-out)
 */
export const VIEW_ROUTES: readonly ViewRoute[] = [
  {
    mode: 'profile',
    // `/u/<handle>` pathname — highest-priority profile signal. The
    // `?profile=` query form is checked AFTER settings/community/trades/
    // trade-detail (see the second profile rule below) to match the
    // original detectViewMode fall-through order exactly.
    matches: ({ pathname }) => /^\/u\//.test(pathname),
    paramKeys: ['profile'],
  },
  {
    mode: 'settings',
    matches: ({ params }) => params.get('settings') === '1',
    // Settings owns its tab/guild/members/user drill-down params —
    // CommunityView also uses `guild` + `tab`, but never concurrently
    // with `settings=1`, so it's safe to list them both here.
    paramKeys: ['settings', 'tab', 'guild', 'members', 'user'],
  },
  {
    mode: 'community',
    matches: ({ params }) => params.get('community') === '1',
    paramKeys: ['community', 'guild', 'tab'],
  },
  {
    mode: 'trades-history',
    matches: ({ params }) => params.get('trades') === '1',
    paramKeys: ['trades'],
  },
  {
    mode: 'trade-detail',
    matches: ({ params }) => params.has('trade'),
    paramKeys: ['trade'],
  },
  {
    mode: 'profile',
    // `?profile=<handle>` query form — matched AFTER the settings /
    // community / trades / trade-detail rules so hand-crafted combos
    // like `?profile=x&settings=1` still route to settings (matches
    // pre-refactor behavior).
    matches: ({ params }) => params.has('profile'),
    paramKeys: ['profile'],
  },
  {
    mode: 'list',
    matches: ({ params }) => {
      // Explicit `view=list` takes precedence over implicit `w`/`a`
      // detection — same as the original detectViewMode switch.
      if (params.get('view') === 'list') return true;
      // Implicit: shared-list URL (`?w=` or `?a=`) without any trade
      // codec params (`y` / `t`). If a trade is also present, the
      // user's already in the composer and we defer to the trade view.
      const hasListParams = params.has('w') || params.has('a');
      const hasTradeParams = params.has('y') || params.has('t');
      return hasListParams && !hasTradeParams;
    },
    paramKeys: ['view', 'w', 'a'],
  },
  {
    mode: 'trade',
    matches: ({ params }) => {
      if (params.get('view') === 'trade') return true;
      // Implicit: trade-codec params signal a trade in progress.
      const hasTradeParams = params.has('y') || params.has('t');
      if (hasTradeParams) return true;
      // Trade-composer intent params (matchmaker `?from=`, edit/counter,
      // propose from a profile CTA, autoBalance one-shot). Without this,
      // clicking "Trade with @handle" from a profile would land on Home
      // with the propose intent silently dropped.
      if (TRADE_INTENT_KEYS.some(k => params.has(k))) return true;
      return false;
    },
    paramKeys: ['view', ...TRADE_INTENT_KEYS],
  },
  {
    mode: 'home',
    matches: ({ params, isSignedIn }) => {
      if (params.get('view') === 'home') return true;
      // Bare URL fallback — signed-in users land on Home; signed-out
      // users land in the trade builder so the public share URL
      // experience is unchanged. The trade-rule above already claimed
      // every non-bare URL, so reaching here means "no routing params".
      return isSignedIn;
    },
    paramKeys: ['view'],
  },
];

/**
 * Detects the active ViewMode from the current browser URL. Returns
 * 'trade' when SSR / no window (safe default — matches the original).
 */
export function detectViewMode(isSignedIn: boolean): ViewMode {
  if (typeof window === 'undefined') return 'trade';
  const parts: RouteParts = {
    pathname: window.location.pathname,
    params: new URLSearchParams(window.location.search),
    isSignedIn,
  };
  for (const route of VIEW_ROUTES) {
    if (route.matches(parts)) return route.mode;
  }
  // Unreachable under normal URLs: the `home` + `trade` rules together
  // cover every URL via the fallthrough chain. Keep the explicit return
  // so TS is happy and so future rule reshuffles have a floor.
  return isSignedIn ? 'home' : 'trade';
}

/**
 * Returns true when the current URL belongs to a view OTHER than the
 * trade builder. `useTradeUrl`'s merge-write consults this to skip
 * URL rewrites on stand-alone views (profile, settings, community,
 * trade-detail, trades-history) whose params it doesn't understand.
 *
 * `home` and `list` are considered "trade-adjacent" — the former is a
 * dashboard that shares the same app chrome + bare URL, and the latter
 * transitions into the composer via the "Start a trade" CTA, so the
 * trade-codec keys are expected to be safe to write there.
 */
export function isStandaloneView(parts: RouteParts): boolean {
  const STANDALONE: ReadonlySet<ViewMode> = new Set([
    'profile',
    'settings',
    'community',
    'trade-detail',
    'trades-history',
  ]);
  for (const route of VIEW_ROUTES) {
    if (!STANDALONE.has(route.mode)) continue;
    if (route.matches(parts)) return true;
  }
  return false;
}

export { TRADE_CODEC_KEYS, TRADE_INTENT_KEYS };
