import { createContext, useContext, type ReactNode } from 'react';

/**
 * Central navigation primitive. Every in-app view change should go
 * through one of these methods so the three things that need to stay
 * in lockstep (URL, `useTradeIntent` state, `viewMode`) can never
 * drift. That drift was the root cause of the Home → Propose bug
 * (aeb0aa2) and the inline `navigateParams` closures it touched.
 *
 * Shape principles:
 *   - Methods are named by DESTINATION ("toTradesHistory", "toSettings")
 *     not by the URL structure. Call sites read as user intent, not as
 *     query-param manipulation.
 *   - Any method that sets an intent param (propose / counter / edit /
 *     from / autoBalance) guarantees the intent state is mirrored. Any
 *     method that navigates AWAY from the trade builder clears stale
 *     intent so a second visit doesn't resume a half-dead composer.
 *   - Options bags are open-shaped — add `tab?` / `guildId?` / etc.
 *     without breaking existing callers.
 *
 * Callers consume via `useNavigation()`; the provider lives inside
 * App.tsx where it has closure access to the app-level setters
 * (setViewMode, intent.setIntent, filters.clearAll). Keeping the
 * provider inside App instead of at root means navigation can always
 * resolve — the bare consumer throws if mounted outside the provider,
 * catching misuse at render time instead of silently no-oping.
 */
export interface NavigationApi {
  /** Home / dashboard. Clears every trade intent; the user is leaving
   *  the composer surface. */
  toHome(): void;

  /** Empty trade builder (no propose / counter / edit context). Used
   *  by the "+ New trade" CTA. Clears trade intents so a stale
   *  in-session propose doesn't resume silently. */
  toBuildTrade(): void;

  /** "Start a trade" from a profile page. Carries sender context via
   *  `?from=` and optionally fires the auto-balance one-shot. */
  toStartTradeFrom(handle?: string, autoBalance?: boolean): void;

  /** Trade detail page (read-only + actions). */
  toTradeDetail(tradeId: string): void;

  /** History of the viewer's trades (incoming / outgoing / history). */
  toTradesHistory(): void;

  /** Dedicated wishlist view — the primary edit surface for wants,
   *  reached from Home's wishlist module and the NavMenu. Replaces
   *  the drawer's wants tab as the "I'm managing my list" destination;
   *  the drawer is now a slim in-trade-builder quick-edit sidebar only. */
  toWishlist(): void;

  /** Dedicated binder view — the primary edit surface for available
   *  cards, reached from Home's binder module and the NavMenu. Same
   *  rationale as toWishlist: drawer is trade-builder-local; this is
   *  the full-page canonical surface. */
  toBinder(): void;

  /** Settings. `tab` drills into a specific section (e.g. `'servers'`
   *  for the guild-management drawer). */
  toSettings(opts?: { tab?: string; guildId?: string; memberHandle?: string }): void;

  /** Community hub. Optionally scoped to a specific guild + tab. */
  toCommunity(opts?: { guildId?: string; tab?: string }): void;

  /** Another user's public profile. */
  toProfile(handle: string): void;

  /** Shared-trade canvas by short-code. Full navigation via
   *  window.location so the App remounts — session state lives on
   *  the server, so there's no SPA state to preserve. */
  toSession(sessionId: string): void;
}

const NavigationContext = createContext<NavigationApi | null>(null);

export function NavigationProvider({
  value,
  children,
}: {
  value: NavigationApi;
  children: ReactNode;
}) {
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationApi {
  const ctx = useContext(NavigationContext);
  if (!ctx) {
    throw new Error('useNavigation must be used inside <NavigationProvider>');
  }
  return ctx;
}
