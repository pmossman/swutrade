import { useEffect, useMemo, useState } from 'react';
import type { CardVariant, PriceMode } from '../types';
import {
  cardImageUrl,
  adjustPrice,
  getCardPrice,
} from '../services/priceService';
import {
  extractVariantLabel,
  variantChipLabel,
} from '../variants';
import { VariantBadge } from './VariantBadge';
import { bestMatchForWant } from '../listMatching';
import type { VariantRestriction } from '../persistence';
import { AppHeader } from './ui/AppHeader';
import { useAuthContext } from '../contexts/AuthContext';
import { useCardIndexContext } from '../contexts/CardIndexContext';
import { usePriceDataContext } from '../contexts/PriceDataContext';

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
}

interface ProfileAvailable {
  productId: string;
  qty: number;
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
}

export function ProfileView({
  handle,
  percentage,
  priceMode,
  onStartTrade,
}: ProfileViewProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const auth = useAuthContext();
  const { byFamilyAll, byProductId } = useCardIndexContext();
  const { isAnyLoading } = usePriceDataContext();

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/user/${encodeURIComponent(handle)}`)
      .then(r => {
        if (r.status === 404) throw new Error('User not found');
        if (!r.ok) throw new Error(`Failed to load profile`);
        return r.json();
      })
      .then(data => setProfile(data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [handle]);

  const wantsRows = useMemo(() => {
    if (!profile?.wants) return [];
    return profile.wants
      .map((w, i) => {
        const candidates = byFamilyAll.get(w.familyId) ?? [];
        if (candidates.length === 0) return null;
        const synth = { ...w, id: '_', addedAt: 0 };
        const card = bestMatchForWant(synth as any, candidates, priceMode);
        if (!card) return null;
        return { key: 'w-' + i, card, qty: w.qty, restriction: w.restriction, isPriority: w.isPriority };
      })
      .filter(Boolean) as Array<{ key: string; card: CardVariant; qty: number; restriction: VariantRestriction; isPriority?: boolean }>;
  }, [profile?.wants, byFamilyAll, priceMode]);

  const availableRows = useMemo(() => {
    if (!profile?.available) return [];
    return profile.available
      .map((a, i) => {
        const card = byProductId.get(a.productId);
        if (!card) return null;
        return { key: 'a-' + i, card, qty: a.qty };
      })
      .filter(Boolean) as Array<{ key: string; card: CardVariant; qty: number }>;
  }, [profile?.available, byProductId]);

  if (loading || isAnyLoading) {
    return (
      <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex items-center justify-center">
        <span className="text-gray-500 animate-pulse">Loading profile…</span>
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
  // chrome. Breadcrumb stays minimal — [Home, @handle] — because
  // viewers arrive via several paths (Community, trade detail, direct
  // link) and we have no reliable referrer to disambiguate.
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
          { label: 'Home', href: '/' },
          { label: `@${profile.user.handle}` },
        ]}
        actions={tradeCta}
      />

      <main className="flex-1 px-3 sm:px-6 pb-8 pt-4 max-w-5xl mx-auto w-full">
        {/* Identity strip — avatar + display name now that the breadcrumb
            carries the @handle. Kept in main so it scrolls with the
            list rather than pinning to the header chrome. */}
        <div className="flex items-center gap-3 mb-4">
          {profile.user.avatarUrl && (
            <img
              src={profile.user.avatarUrl}
              alt=""
              className="w-10 h-10 rounded-full border-2 border-space-700"
            />
          )}
          <div>
            <div className="text-sm font-bold text-gray-100">{profile.user.username}</div>
            <div className="text-[11px] text-gray-500">@{profile.user.handle}</div>
          </div>
        </div>

        <ProfileLists
          profile={profile}
          wantsRows={wantsRows}
          availableRows={availableRows}
          percentage={percentage}
          priceMode={priceMode}
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
}: {
  profile: ProfileData;
  wantsRows: ProfileListRow[];
  availableRows: ProfileListRow[];
  percentage: number;
  priceMode: PriceMode;
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
          <ul className="flex flex-col divide-y divide-space-800">
            {activeRows.map(row => (
              <ProfileRow
                key={row.key}
                card={row.card}
                qty={row.qty}
                restriction={row.restriction}
                isPriority={row.isPriority}
                percentage={percentage}
                priceMode={priceMode}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
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

function ProfileRow({
  card,
  qty,
  restriction,
  isPriority,
  percentage,
  priceMode,
}: {
  card: CardVariant;
  qty: number;
  restriction?: VariantRestriction;
  isPriority?: boolean;
  percentage: number;
  priceMode: PriceMode;
}) {
  const variant = extractVariantLabel(card.name);
  const price = adjustPrice(getCardPrice(card, priceMode), percentage);
  const imgUrl = cardImageUrl(card.productId, 'sm');
  const display = card.displayName ?? card.name.replace(/\s*\([^)]*\)\s*$/, '');

  const restrictionLabel = restriction && restriction.mode === 'restricted' && restriction.variants.length > 1
    ? restriction.variants.map(variantChipLabel).join(' / ')
    : null;

  return (
    <li className="flex items-center gap-3 py-1.5">
      <div className="w-8 h-11 shrink-0 rounded bg-space-900 border border-space-800 overflow-hidden">
        {imgUrl ? (
          <img src={imgUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {isPriority && (
            <span className="text-gold-bright shrink-0" aria-label="Priority" style={{ fontSize: 12, lineHeight: 1 }}>
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
            ${price.toFixed(2)}
          </span>
        )}
      </div>
    </li>
  );
}
