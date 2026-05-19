import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardVariant, PriceMode } from '../types';
import {
  cardImageUrl,
  formatPrice,
  getCardPrice,
} from '../services/priceService';
import {
  CANONICAL_VARIANTS,
  cardFamilyId,
  extractVariantLabel,
  variantChipLabel,
} from '../variants';
import { VariantBadge } from './VariantBadge';
import { bestMatchForWant, matchesRestriction } from '../listMatching';
import type { VariantRestriction, WantsItem, AvailableItem } from '../persistence';
import { AppHeader } from './ui/AppHeader';
import { useAuthContext } from '../contexts/AuthContext';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { usePriceDataContext } from '../contexts/PriceDataContext';
import { useFavorites } from '../hooks/useFavorites';
import { LoadingState } from './ui/states';
import { apiGet } from '../services/apiClient';
import { ListToolbar, FilterAwareEmptyBody } from './lists/ListToolbar';
import {
  applyListToolbar,
  variantTagFromCard,
  type ListFilters,
  type ListSortMode,
} from './lists/applyListToolbar';
import { loadToolbarState, saveToolbarState } from './lists/toolbarPersistence';

interface ProfileUser {
  username: string;
  handle: string;
  avatarUrl: string | null;
}

interface ProfileWant {
  familyId: string;
  qty: number;
  restriction: VariantRestriction;
  isPriority?: boolean;
  addedAt: number;
}

interface ProfileAvailable {
  productId: string;
  qty: number;
  addedAt: number;
}

interface ProfileData {
  user: ProfileUser;
  wants: ProfileWant[] | null;
  available: ProfileAvailable[] | null;
}

interface ProfileViewProps {
  handle: string;
  percentage: number;
  priceMode: PriceMode;
  onStartTrade: (fromHandle?: string, autoBalance?: boolean) => void;
  /** Viewer's own wants — feeds the per-row `isMatch` flag on the
   *  profile's Available tab ("do I want this card?"). Empty array
   *  when the viewer is signed out or has no wants. */
  viewerWants: readonly WantsItem[];
  /** Viewer's own available — feeds the per-row `isMatch` flag on
   *  the profile's Wants tab ("do I have a card that satisfies this
   *  want?"). */
  viewerAvailable: readonly AvailableItem[];
}

/**
 * UX-A6: derive an origin-aware "parent" breadcrumb from the
 * referrer. The profile view has many entry points (Community member
 * list, activity-feed @mentions, shared-list sender link, Settings
 * "Public profile" copy-URL, AccountMenu, HomeView avatar click, and
 * direct /u/<handle> URLs). Flat "Home →" as the only back target
 * drops the user one level too far in every case except a direct
 * load — they wanted to return to wherever they were looking at lists
 * or members, not the dashboard.
 *
 * Reads `document.referrer` once on mount (not reactive; breadcrumbs
 * don't churn). Same-origin referrers map onto known routes by
 * pathname + query shape:
 *   - `/?community=1…`   → "Community"  (back to directory)
 *   - `/?trades=1`       → "My trades"
 *   - `/?trade=<id>`     → "Trade"
 *   - `/s/<code>`        → "Shared trade"
 *   - `/u/<other>`       → "@other"     (profile-to-profile walk)
 *   - anything else      → "Home" / `/`
 *
 * pushState-only nav (e.g., HomeView greeting-row avatar click)
 * doesn't update `document.referrer`, so those cases fall through to
 * the Home fallback — safe default, no wrong breadcrumb. The common
 * case for profile arrivals is full-page `<a href>` navigation where
 * the referrer is reliable.
 */
function deriveProfileParent(): { label: string; href: string } {
  const fallback = { label: 'Home', href: '/' };
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return fallback;
  }
  const referrer = document.referrer;
  if (!referrer) return fallback;
  let ref: URL;
  try {
    ref = new URL(referrer);
  } catch {
    return fallback;
  }
  if (ref.origin !== window.location.origin) return fallback;
  const path = ref.pathname;
  const params = ref.searchParams;
  // Other profile → /u/<handle>
  const profileMatch = /^\/u\/([^/]+)$/.exec(path);
  if (profileMatch) {
    const otherHandle = decodeURIComponent(profileMatch[1]);
    return { label: `@${otherHandle}`, href: `${ref.pathname}${ref.search}` };
  }
  // Shared trade → /s/<code>
  if (/^\/s\//.test(path)) {
    return { label: 'Shared trade', href: `${ref.pathname}${ref.search}` };
  }
  // Query-shape routes (all served by `/`)
  if (path === '/' || path === '') {
    if (params.has('community')) {
      return { label: 'Community', href: `/${ref.search}` };
    }
    if (params.has('trades')) {
      return { label: 'My trades', href: '/?trades=1' };
    }
    if (params.has('trade')) {
      return { label: 'Trade', href: `/${ref.search}` };
    }
    if (params.has('settings')) {
      return { label: 'Settings', href: `/${ref.search}` };
    }
  }
  return fallback;
}

export function ProfileView({
  handle,
  percentage,
  priceMode,
  onStartTrade,
  viewerWants,
  viewerAvailable,
}: ProfileViewProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const auth = useAuthContext();
  // Favorites are signed-in only; gate the hook so ghosts + signed-out
  // viewers don't 401 against /api/me/favorites on every profile
  // visit. The toggle UI is also gated on signed-in-and-not-self below.
  const favorites = useFavorites(!!auth.user && !auth.user.isAnonymous);
  // Captured once at mount — breadcrumbs don't change while the user
  // is reading the profile. If they navigate away and come back,
  // component re-mounts and re-reads.
  const [parentCrumb] = useState(() => deriveProfileParent());
  const { byFamilyAll, byProductId } = useCardIndexContext();
  const { isAnyLoading } = usePriceDataContext();

  useEffect(() => {
    setLoading(true);
    setError(null);
    let cancelled = false;
    (async () => {
      const result = await apiGet<ProfileData>(
        `/api/user/${encodeURIComponent(handle)}`,
      );
      if (cancelled) return;
      if (!result.ok) {
        setError(result.reason === 'not-found'
          ? 'User not found'
          : (result.detail ?? 'Failed to load profile'));
      } else {
        setProfile(result.data);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [handle]);

  // Materialize the viewer's own lists into match-lookup shapes once,
  // shared by both tabs' decoration paths. Uses the same canonical
  // `matchesRestriction` predicate the community-overlap chip uses
  // (CommunityView.tsx::enrichMember) so all three surfaces agree.
  const viewerAvailableByFamily = useMemo(() => {
    const m = new Map<string, CardVariant[]>();
    for (const item of viewerAvailable) {
      const card = byProductId.get(item.productId);
      if (!card) continue;
      const fid = cardFamilyId(card);
      const arr = m.get(fid) ?? [];
      arr.push(card);
      m.set(fid, arr);
    }
    return m;
  }, [viewerAvailable, byProductId]);

  const viewerWantsByFamily = useMemo(() => {
    const m = new Map<string, VariantRestriction[]>();
    for (const w of viewerWants) {
      const arr = m.get(w.familyId) ?? [];
      arr.push(w.restriction);
      m.set(w.familyId, arr);
    }
    return m;
  }, [viewerWants]);

  const wantsRows = useMemo(() => {
    if (!profile?.wants) return [];
    type WantRow = {
      key: string;
      card: CardVariant;
      qty: number;
      restriction: VariantRestriction;
      isPriority?: boolean;
      addedAt: number;
      isMatch: boolean;
      variantTags: readonly string[];
    };
    const rows: Array<WantRow | null> = profile.wants
      .map((w, i) => {
        const candidates = byFamilyAll.get(w.familyId) ?? [];
        if (candidates.length === 0) return null;
        const card = bestMatchForWant({ restriction: w.restriction }, candidates, priceMode);
        if (!card) return null;
        // isMatch = does the viewer have any available card whose
        // variant satisfies this want's restriction?
        const viewerCards = viewerAvailableByFamily.get(w.familyId) ?? [];
        const isMatch = viewerCards.some(c => matchesRestriction(c, w.restriction));
        const variantTags = w.restriction.mode === 'restricted'
          ? w.restriction.variants
          : [...CANONICAL_VARIANTS];
        return {
          key: 'w-' + i,
          card,
          qty: w.qty,
          restriction: w.restriction,
          isPriority: w.isPriority,
          addedAt: w.addedAt,
          isMatch,
          variantTags,
        };
      });
    return rows.filter((r): r is WantRow => r !== null);
  }, [profile?.wants, byFamilyAll, priceMode, viewerAvailableByFamily]);

  const availableRows = useMemo(() => {
    if (!profile?.available) return [];
    type AvailRow = {
      key: string;
      card: CardVariant;
      qty: number;
      addedAt: number;
      isMatch: boolean;
      variantTags: readonly string[];
    };
    const rows: Array<AvailRow | null> = profile.available
      .map((a, i) => {
        const card = byProductId.get(a.productId);
        if (!card) return null;
        // isMatch = does the viewer have a want whose restriction
        // this card's variant satisfies?
        const fid = cardFamilyId(card);
        const restrictions = viewerWantsByFamily.get(fid) ?? [];
        const isMatch = restrictions.some(r => matchesRestriction(card, r));
        return {
          key: 'a-' + i,
          card,
          qty: a.qty,
          addedAt: a.addedAt,
          isMatch,
          variantTags: [variantTagFromCard(card)],
        };
      });
    return rows.filter((r): r is AvailRow => r !== null);
  }, [profile?.available, byProductId, viewerWantsByFamily]);

  if (loading || isAnyLoading) {
    return (
      <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex">
        <LoadingState centered label="Loading profile…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col items-center justify-center gap-2">
        <span className="text-gray-400">{error}</span>
        <a href="/" className="text-gold hover:text-gold-bright text-sm underline">Back to SWUTrade</a>
      </div>
    );
  }

  if (!profile) return null;

  // Slim variant for signed-out viewers on a shared /u/<handle> URL —
  // NavMenu + AccountMenu are hidden so we don't push sign-up chrome at
  // someone who just clicked a link to see a list. Signed-in viewers
  // (looking at their own profile or someone else's) get the normal
  // chrome. Breadcrumb first entry is origin-aware (derived from
  // document.referrer via `deriveProfileParent`) so "Back" returns
  // the user to where they came from — Community, My trades, a trade
  // detail — instead of dumping them to Home every time. UX-A6.
  const tradeCta = auth.user && auth.user.handle !== profile.user.handle ? (
    // Signed-in, viewing someone else: single primary CTA that lands
    // in the propose composer. Specific label "Trade with @alice" is
    // unambiguous — the prior "Propose a trade" + "Just balance" pair
    // was confusing (both auto-filled the editor; the only real
    // difference was whether the Send button rendered).
    <a
      href={`/?propose=${encodeURIComponent(profile.user.handle)}`}
      className="flex items-center gap-1.5 px-3 sm:px-4 h-9 rounded-lg bg-gold/15 border border-gold/40 hover:bg-gold/25 hover:border-gold/60 text-gold text-xs sm:text-sm font-bold tracking-wide uppercase transition-colors"
    >
      Trade with @{profile.user.handle}
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 8h10M9 4l4 4-4 4" />
      </svg>
    </a>
  ) : (
    // Own profile or signed-out visitor — the local balance flow
    // (editor pre-seeded with this profile's context, no Discord send).
    // Label splits by case to avoid conflating with the "Trade with
    // @handle" CTA shown to other viewers:
    //   - own profile: "Open trade editor" (no counterpart)
    //   - signed-out other: "Start a trade" (auto-balance flow)
    <button
      type="button"
      onClick={() => onStartTrade(profile.user.handle, true)}
      className="flex items-center gap-1.5 px-3 sm:px-4 h-9 rounded-lg border bg-gold/15 border-gold/40 hover:bg-gold/25 hover:border-gold/60 text-gold text-xs sm:text-sm font-bold tracking-wide uppercase transition-colors"
    >
      {auth.user?.handle === profile.user.handle ? 'Open trade editor' : 'Start a trade'}
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 8h10M9 4l4 4-4 4" />
      </svg>
    </button>
  );

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        slim={!auth.user}
        breadcrumbs={[
          parentCrumb,
          { label: `@${profile.user.handle}` },
        ]}
      />

      <main className="flex-1 px-3 sm:px-6 pb-8 pt-4 max-w-5xl mx-auto w-full">
        {/* Profile hero — avatar + display name + primary CTA. The CTA
            (Trade with @X / Start a trade / Open trade editor) sits
            alongside the identity so it reads as the page's primary
            action rather than getting squished next to breadcrumbs in
            the chrome row. On narrow viewports the CTA wraps onto a
            second row so it doesn't fight the handle text. */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {profile.user.avatarUrl && (
            <img
              src={profile.user.avatarUrl}
              alt=""
              className="w-10 h-10 rounded-full border-2 border-space-700"
            />
          )}
          <div className="min-w-0 mr-auto">
            <div className="text-sm font-bold text-gray-100 truncate">{profile.user.username}</div>
            <div className="text-[11px] text-gray-500 truncate">@{profile.user.handle}</div>
          </div>
          {/* Favorite toggle — only shown to signed-in viewers on
              someone else's profile (no self-favorite, no ghost
              support). Sits adjacent to the Trade CTA so the two
              related actions ("trade with this person" / "remember
              this person for later") read as peers. */}
          {auth.user && !auth.user.isAnonymous && auth.user.handle !== profile.user.handle && (
            <FavoriteToggle
              profileHandle={profile.user.handle}
              isFavorite={favorites.isFavorite(profile.user.handle)}
              onAdd={() => favorites.add(profile.user.handle)}
              onRemove={() => favorites.remove(profile.user.handle)}
            />
          )}
          {/* Own-profile shareable invite link — generates a
              `/?propose=<self-handle>` URL the viewer can paste in
              Discord (DM, group chat, community server) for friends
              who aren't in any bot-enabled guild with them. The
              recipient clicks the link → lands in a propose-to-this-
              handle composer → sends a proposal back. Complements
              HandlePickerDialog for the outbound direction. */}
          {auth.user && auth.user.handle === profile.user.handle && (
            <CopyInviteLinkButton handle={profile.user.handle} />
          )}
          {tradeCta}
        </div>

        <ProfileLists
          profile={profile}
          wantsRows={wantsRows}
          availableRows={availableRows}
          percentage={percentage}
          priceMode={priceMode}
          isSelf={!!auth.user && auth.user.handle === profile.user.handle}
        />
      </main>

      <footer className="shrink-0 px-3 sm:px-6 pb-4 text-center text-[10px] text-gray-600 max-w-5xl mx-auto w-full">
        <span>@{profile.user.handle}'s public list on SWUTrade · </span>
        <button
          type="button"
          onClick={() => onStartTrade(profile.user.handle)}
          className="text-gold/80 hover:text-gold underline transition-colors"
        >
          Start a trade
        </button>
      </footer>
    </div>
  );
}

type ListTab = 'wants' | 'available';

interface ProfileListRow {
  key: string;
  card: CardVariant;
  qty: number;
  restriction?: VariantRestriction;
  isPriority?: boolean;
  addedAt: number;
  isMatch: boolean;
  variantTags: readonly string[];
}

/**
 * Tabbed view of a profile's wants + available lists. Previously the
 * two sections stacked vertically — if a user was there to check what
 * someone had *available*, they had to scroll past the entire wants
 * list to get there. Tabs put both one click away and make the fact
 * that both lists exist visible at a glance via the tab labels.
 *
 * Default active tab: the first tab with items. If both are empty or
 * both are private, falls back to Wants — either way the tab body
 * renders the relevant empty-state explainer.
 */
function ProfileLists({
  profile,
  wantsRows,
  availableRows,
  percentage,
  priceMode,
  isSelf,
}: {
  profile: ProfileData;
  wantsRows: ProfileListRow[];
  availableRows: ProfileListRow[];
  percentage: number;
  priceMode: PriceMode;
  isSelf: boolean;
}) {
  const [tab, setTab] = useState<ListTab>(() => {
    if (wantsRows.length > 0) return 'wants';
    if (availableRows.length > 0) return 'available';
    return 'wants';
  });

  const wantsPrivate = profile.wants === null;
  const availPrivate = profile.available === null;
  const activeRows = tab === 'wants' ? wantsRows : availableRows;
  const activeIsPrivate = tab === 'wants' ? wantsPrivate : availPrivate;
  const activeLabel = tab === 'wants' ? 'wants' : 'available';

  return (
    <div>
      {/* Tab bar — the accent on the active tab carries the same
          blue/emerald identity the sections used previously, so the
          visual language for "wants vs available" stays consistent
          with the trade editor's side coloring (from the profile
          owner's perspective: wants = their receiving = blue,
          available = their offering = emerald). */}
      <div
        role="tablist"
        aria-label="Profile lists"
        className="flex gap-6 border-b border-space-800 mb-4"
      >
        <ProfileListTab
          tab="wants"
          active={tab === 'wants'}
          count={wantsRows.length}
          isPrivate={wantsPrivate}
          onSelect={setTab}
        />
        <ProfileListTab
          tab="available"
          active={tab === 'available'}
          count={availableRows.length}
          isPrivate={availPrivate}
          onSelect={setTab}
        />
      </div>

      <div role="tabpanel" aria-label={`${activeLabel} list`}>
        {activeIsPrivate ? (
          <div className="text-center text-gray-500 py-16 text-sm">
            This user's {activeLabel} list is private.
          </div>
        ) : activeRows.length === 0 ? (
          <div className="text-center text-gray-500 py-16 text-sm">
            No items in this user's public {activeLabel} list.
          </div>
        ) : (
          <ProfileListTabBody
            tab={tab}
            rows={activeRows}
            profileHandle={profile.user.handle}
            percentage={percentage}
            priceMode={priceMode}
            isSelf={isSelf}
          />
        )}
      </div>
    </div>
  );
}

/** Tab body — toolbar + filtered rows. Split out so the toolbar state
 *  resets cleanly when the user switches tabs (the toolbar persists
 *  per-tab via separate storage keys, but mounting/unmounting also
 *  keeps the search input from sticking visually across the swap). */
function ProfileListTabBody({
  tab,
  rows,
  profileHandle,
  percentage,
  priceMode,
  isSelf,
}: {
  tab: ListTab;
  rows: ProfileListRow[];
  profileHandle: string;
  percentage: number;
  priceMode: PriceMode;
  isSelf: boolean;
}) {
  const surfaceKey = `profile.${profileHandle}.${tab}`;
  const initial = useMemo(
    () => loadToolbarState(surfaceKey, 'default'),
    [surfaceKey],
  );

  const anyOverlap = useMemo(() => rows.some(r => r.isMatch), [rows]);

  // Default-on matchMode when there's actual overlap AND we're looking
  // at someone else's profile. Skip the match toggle entirely on own-
  // profile views (it's always trivially-on).
  const [filters, setFilters] = useState<ListFilters>(() => ({
    ...initial.filters,
    matchOnly: !isSelf && (initial.filters.matchOnly || anyOverlap),
  }));
  const [sort, setSort] = useState<ListSortMode>(initial.sort);

  useEffect(() => {
    saveToolbarState(surfaceKey, filters, sort);
  }, [surfaceKey, filters, sort]);

  const visible = useMemo(() => {
    const sorted = applyListToolbar(rows, filters, sort, priceMode);
    // Match-grouping: when the matchMode filter is OFF on someone
    // else's profile, partition matches to the top so the viewer
    // sees the actionable rows without scanning the whole list. The
    // selected sort applies *within* each group, so a user who
    // chose "Price: high to low" still sees their matches in price
    // order at the top. Skipped on own-profile (matchMode is hidden
    // there — self-match is trivially true and not useful as a
    // grouping axis) and when matchMode is already filtering to
    // matches-only (nothing to partition).
    if (filters.matchOnly || isSelf) return sorted;
    const matches: typeof sorted = [];
    const others: typeof sorted = [];
    for (const r of sorted) (r.isMatch ? matches : others).push(r);
    if (matches.length === 0 || others.length === 0) return sorted;
    return [...matches, ...others];
  }, [rows, filters, sort, priceMode, isSelf]);

  const matchCount = useMemo(
    () => visible.filter(r => r.isMatch).length,
    [visible],
  );
  const matchTone: 'emerald' | 'blue' = tab === 'wants' ? 'emerald' : 'blue';
  // Show the match-group label only when there's a meaningful split:
  // both groups present, and the user isn't already filtering to
  // matches-only (the label would say "Matches" above a list that
  // is entirely matches — redundant). Hidden on own profile too.
  const showMatchGroupLabel =
    !isSelf
    && !filters.matchOnly
    && matchCount > 0
    && matchCount < visible.length;
  const matchGroupLabel = tab === 'wants'
    ? 'Cards you can offer'
    : 'Matches with your wants';

  const activeFilterAxisCount = useMemo(() => {
    let n = 0;
    if (filters.query.trim().length > 0) n++;
    if (filters.selectedSets.length > 0) n++;
    if (filters.selectedVariants.length > 0) n++;
    if (filters.matchOnly) n++;
    return n;
  }, [filters]);

  const handleClearFilters = useCallback(() => {
    setFilters({
      query: '',
      selectedSets: [],
      selectedVariants: [],
      priorityOnly: false,
      matchOnly: false,
    });
  }, []);

  const matchToggleLabel = tab === 'wants'
    ? 'Only cards you can offer'
    : 'Only matches with your wants';

  return (
    <>
      <ListToolbar
        mode={isSelf ? 'profile-self' : 'profile-other'}
        filters={filters}
        onChangeFilters={setFilters}
        sort={sort}
        onChangeSort={setSort}
        totalCount={rows.length}
        filteredCount={visible.length}
        matchToggleLabel={matchToggleLabel}
      />
      {visible.length === 0 ? (
        <div className="text-center text-gray-500 py-12 text-sm">
          <FilterAwareEmptyBody
            activeCount={activeFilterAxisCount}
            onClear={handleClearFilters}
          />
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-space-800">
          {visible.map((row, i) => {
            // Mid-list "Other" label appears once, between the
            // tinted match group and the rest. Cheap heuristic — at
            // index `matchCount` the run of matches ends — but only
            // emit when we know there's a real split.
            const showOtherLabel =
              showMatchGroupLabel && i === matchCount;
            return (
              <ProfileMatchRowFragment
                key={row.key}
                row={row}
                first={i === 0}
                showMatchHeader={i === 0 && showMatchGroupLabel}
                matchHeaderLabel={matchGroupLabel}
                matchHeaderTone={matchTone}
                showOtherHeader={showOtherLabel}
                otherHeaderLabel={tab === 'wants' ? 'Other wants' : 'Other available'}
                percentage={percentage}
                priceMode={priceMode}
                matchTone={matchTone}
              />
            );
          })}
        </ul>
      )}
    </>
  );
}

function ProfileListTab({
  tab,
  active,
  count,
  isPrivate,
  onSelect,
}: {
  tab: ListTab;
  active: boolean;
  count: number;
  isPrivate: boolean;
  onSelect: (t: ListTab) => void;
}) {
  const label = tab === 'wants' ? 'Wants' : 'Available';
  // Active tab gets a thicker underline, accent-colored badge pill,
  // AND bolder label — multiple simultaneous affordances so "which
  // tab am I on" never requires pixel-peeping on a 2px underline.
  const activeAccent = tab === 'wants'
    ? 'text-blue-300 border-blue-400'
    : 'text-emerald-300 border-emerald-400';
  const activeBadge = tab === 'wants'
    ? 'bg-blue-500/15 text-blue-200 border-blue-400/40'
    : 'bg-emerald-500/15 text-emerald-200 border-emerald-400/40';
  const inactive = 'text-gray-500 border-transparent hover:text-gray-300';
  const inactiveBadge = 'bg-space-800/60 text-gray-400 border-space-700';
  // Show "private" instead of a count when the list is gated — count
  // would be 0 and misleading. The tab itself stays clickable so
  // users can still land on the panel and read the explainer.
  const badge = isPrivate ? 'private' : String(count);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(tab)}
      className={`flex items-baseline gap-2 pb-2 -mb-[3px] border-b-[3px] transition-colors ${
        active ? activeAccent : inactive
      }`}
    >
      <span className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase">{label}</span>
      <span className={`text-[10px] px-1.5 py-px rounded-full border font-semibold ${isPrivate ? 'italic' : ''} ${active ? activeBadge : inactiveBadge}`}>
        {badge}
      </span>
    </button>
  );
}

/**
 * Wraps a `<ProfileRow>` with the optional section labels — "Cards
 * you can offer" / "Matches with your wants" above the first row of
 * the match group, "Other wants" / "Other available" above the
 * first row of the non-match group. Lives in this file because the
 * label semantics are tightly coupled to the tab tone + match-grouping
 * logic in `ProfileListTabBody`; not worth extracting until a
 * second consumer surfaces.
 */
function ProfileMatchRowFragment({
  row,
  first: _first,
  showMatchHeader,
  matchHeaderLabel,
  matchHeaderTone,
  showOtherHeader,
  otherHeaderLabel,
  percentage,
  priceMode,
  matchTone,
}: {
  row: ProfileListRow;
  first: boolean;
  showMatchHeader: boolean;
  matchHeaderLabel: string;
  matchHeaderTone: 'emerald' | 'blue';
  showOtherHeader: boolean;
  otherHeaderLabel: string;
  percentage: number;
  priceMode: PriceMode;
  matchTone: 'emerald' | 'blue';
}) {
  const headerToneClass = matchHeaderTone === 'emerald'
    ? 'text-emerald-300'
    : 'text-blue-300';
  return (
    <>
      {showMatchHeader && (
        <li className="list-none pt-2 pb-1 -mb-px">
          <span className={`text-[10px] tracking-[0.15em] uppercase font-bold ${headerToneClass}`}>
            {matchHeaderLabel}
          </span>
        </li>
      )}
      {showOtherHeader && (
        <li className="list-none pt-3 pb-1 -mb-px">
          <span className="text-[10px] tracking-[0.15em] uppercase font-bold text-gray-500">
            {otherHeaderLabel}
          </span>
        </li>
      )}
      <ProfileRow
        card={row.card}
        qty={row.qty}
        restriction={row.restriction}
        isPriority={row.isPriority}
        percentage={percentage}
        priceMode={priceMode}
        isMatch={row.isMatch}
        matchTone={matchTone}
      />
    </>
  );
}

function ProfileRow({
  card,
  qty,
  restriction,
  isPriority,
  priceMode,
  isMatch,
  matchTone,
}: {
  card: CardVariant;
  qty: number;
  restriction?: VariantRestriction;
  isPriority?: boolean;
  /** Accepted but ignored — profile list rows render at raw 100%
   *  TCGPlayer prices, same contract as the wishlist / binder rows.
   *  See ListRows.AvailableRow for the rationale. */
  percentage?: number;
  priceMode: PriceMode;
  /** This row is a cross-side match — the viewer has a card that
   *  satisfies this want (wants tab), or the viewer wants this card
   *  (available tab). Same predicate the matchMode filter uses. */
  isMatch?: boolean;
  /** Tint color for the match treatment. Emerald on the wants tab
   *  ("you can offer this"); blue on the available tab ("you want
   *  this"). Both flow from the viewer's perspective, deliberately
   *  inverted vs the tab header tone (which encodes the profile
   *  owner's perspective). */
  matchTone?: 'emerald' | 'blue';
}) {
  const variant = extractVariantLabel(card.name);
  const price = getCardPrice(card, priceMode);
  const imgUrl = cardImageUrl(card.productId, 'sm');
  const display = card.displayName ?? card.name.replace(/\s*\([^)]*\)\s*$/, '');

  const restrictionLabel = restriction && restriction.mode === 'restricted' && restriction.variants.length > 1
    ? restriction.variants.map(variantChipLabel).join(' / ')
    : null;

  const matchClasses = isMatch
    ? matchTone === 'emerald'
      ? 'bg-emerald-500/[0.06] border-l-2 border-emerald-500/50 pl-2 -ml-2'
      : 'bg-blue-500/[0.06] border-l-2 border-blue-500/50 pl-2 -ml-2'
    : '';

  return (
    <li className={`flex items-center gap-3 py-1.5 ${matchClasses}`}>
      <div className="w-8 h-11 shrink-0 rounded bg-space-900 border border-space-800 overflow-hidden">
        {imgUrl ? (
          <img src={imgUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {isPriority && (
            <span className="text-gold-bright shrink-0 text-[12px] leading-none" aria-label="Priority">
              ★
            </span>
          )}
          <span className="text-sm text-gray-100 truncate">{display}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {restrictionLabel ? (
            <span className="text-[9px] leading-none px-1 py-0.5 rounded font-bold uppercase tracking-wide bg-gold/15 text-gold border border-gold/30">
              {restrictionLabel}
            </span>
          ) : (
            <VariantBadge variant={variant} />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 text-right">
        {qty > 1 && (
          <span className="text-xs font-bold tabular-nums text-blue-200">×{qty}</span>
        )}
        {price !== null && (
          <span className="text-xs text-gold font-semibold tabular-nums w-14 text-right">
            {formatPrice(price)}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * "Copy invite link" — generates an absolute `/?propose=<self-handle>`
 * URL that lands recipients in a propose-to-me composer. Meant for
 * pasting into any Discord channel / DM where a friend who isn't in
 * a shared bot-enabled server can click through. Copy-to-clipboard
 * with a transient "Copied" confirmation; falls through to a
 * selectable-input fallback on browsers blocking the clipboard API
 * (Safari private mode, insecure contexts).
 */
function CopyInviteLinkButton({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false);

  const inviteUrl = `${window.location.origin}/?propose=${encodeURIComponent(handle)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      const input = document.createElement('input');
      input.value = inviteUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy a URL to share on Discord — anyone who clicks it lands in a propose-to-you composer"
      className="flex items-center gap-1.5 px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-semibold text-gray-300 hover:text-gold transition-colors"
    >
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6.5 8.5l3-3M5 7l-1.5 1.5a2.5 2.5 0 003.5 3.5L8.5 10.5M11 9l1.5-1.5a2.5 2.5 0 00-3.5-3.5L7.5 5.5" />
      </svg>
      {copied ? 'Copied ✓' : 'Copy invite link'}
    </button>
  );
}

/**
 * Bookmark toggle — single button that flips between "add to trading
 * partners" and "remove from trading partners" based on the current
 * favorite state. Optimistic via `useFavorites`; the hook updates the
 * local list before the POST / DELETE resolves, so the toggle feels
 * instant even on a slow network.
 */
function FavoriteToggle({
  profileHandle,
  isFavorite,
  onAdd,
  onRemove,
}: {
  profileHandle: string;
  isFavorite: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => (isFavorite ? onRemove() : onAdd())}
      aria-pressed={isFavorite}
      aria-label={
        isFavorite
          ? `Remove @${profileHandle} from your trading partners`
          : `Add @${profileHandle} to your trading partners`
      }
      title={
        isFavorite
          ? 'Remove from your trading partners'
          : 'Add to your trading partners'
      }
      className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-colors ${
        isFavorite
          ? 'bg-gold/20 border-gold/50 text-gold hover:bg-gold/10'
          : 'bg-space-800/60 border-space-700 text-gray-400 hover:border-gold/40 hover:bg-space-800 hover:text-gold'
      }`}
    >
      {/* Bookmark icon — filled when favorited, outline when not. The
          visual state mirrors the aria-pressed semantic so screen-
          reader users and sighted users see the same signal. */}
      <svg
        viewBox="0 0 16 16"
        className="w-4 h-4"
        fill={isFavorite ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3.5 2.5h9v12l-4.5-3-4.5 3z" />
      </svg>
    </button>
  );
}
