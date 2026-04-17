import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { PageHeader } from './ui/PageHeader';
import { useAuthContext } from '../contexts/AuthContext';

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
  byFamilyAll: Map<string, CardVariant[]>;
  byProductId: Map<string, CardVariant>;
  percentage: number;
  priceMode: PriceMode;
  isAnyLoading: boolean;
  onStartTrade: (fromHandle?: string, autoBalance?: boolean) => void;
}

export function ProfileView({
  handle,
  byFamilyAll,
  byProductId,
  percentage,
  priceMode,
  isAnyLoading,
  onStartTrade,
}: ProfileViewProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const auth = useAuthContext();

  // ProfileView is typically reached via a row click in /?community=1
  // or a link from elsewhere in the app. Without a Back affordance
  // users lose the thread (browser Back works but isn't obvious).
  // Prefer history.back() when the referrer is same-origin, otherwise
  // fall through to the home route — covers direct-URL visits where
  // there's no previous SWU page to return to.
  const handleProfileBack = useCallback(() => {
    try {
      const ref = document.referrer;
      if (ref && new URL(ref).origin === window.location.origin) {
        window.history.back();
        return;
      }
    } catch {
      // Malformed referrer — fall through.
    }
    window.location.href = '/';
  }, []);

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

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <header className="px-3 sm:px-6 pt-3 pb-2 max-w-5xl mx-auto w-full">
        <PageHeader
          onBack={handleProfileBack}
          kicker={
            <div className="flex items-center gap-3">
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
          }
        >
          {auth.user && auth.user.handle !== profile.user.handle ? (
            // Signed-in, viewing someone else: single primary CTA that
            // lands in the propose composer. Specific label "Trade with
            // @alice" is unambiguous — the prior "Propose a trade" +
            // "Just balance" pair was confusing (both auto-filled the
            // editor; the only real difference was whether the Send
            // button rendered).
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
            // Own profile or signed-out visitor: "Start a trade" still
            // maps to the local balance flow — no Discord send, just
            // the editor pre-seeded with this profile's context.
            <button
              type="button"
              onClick={() => onStartTrade(profile.user.handle, true)}
              className="flex items-center gap-1.5 px-3 sm:px-4 h-9 rounded-lg border bg-gold/15 border-gold/40 hover:bg-gold/25 hover:border-gold/60 text-gold text-xs sm:text-sm font-bold tracking-wide uppercase transition-colors"
            >
              Start a trade
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </button>
          )}
        </PageHeader>
      </header>

      <main className="flex-1 px-3 sm:px-6 pb-8 pt-4 max-w-5xl mx-auto w-full">
        {wantsRows.length === 0 && availableRows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-center text-gray-500 py-20">
            {profile.wants === null && profile.available === null
              ? 'This user\'s lists are private.'
              : 'No items in this user\'s public lists.'}
          </div>
        ) : (
          <div className="space-y-6">
            {wantsRows.length > 0 && (
              <section>
                <div className="flex items-baseline gap-2 pb-2 mb-3 border-b text-blue-300 border-blue-500/30">
                  <span className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase">Wants</span>
                  <span className="text-[11px] text-gray-600">{wantsRows.length}</span>
                </div>
                <ul className="flex flex-col divide-y divide-space-800">
                  {wantsRows.map(row => (
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
              </section>
            )}
            {availableRows.length > 0 && (
              <section>
                <div className="flex items-baseline gap-2 pb-2 mb-3 border-b text-emerald-300 border-emerald-500/30">
                  <span className="text-xs sm:text-sm font-bold tracking-[0.18em] uppercase">Available</span>
                  <span className="text-[11px] text-gray-600">{availableRows.length}</span>
                </div>
                <ul className="flex flex-col divide-y divide-space-800">
                  {availableRows.map(row => (
                    <ProfileRow
                      key={row.key}
                      card={row.card}
                      qty={row.qty}
                      percentage={percentage}
                      priceMode={priceMode}
                    />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
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
