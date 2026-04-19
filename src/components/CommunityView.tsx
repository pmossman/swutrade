import { useMemo, useState } from 'react';
import { PageHeader } from './ui/PageHeader';
import { LoadingState, ErrorState, EmptyState } from './ui/states';
import {
  useCommunityMembers,
  type CommunityMember,
} from '../hooks/useCommunityMembers';
import type { CardVariant } from '../types';
import { cardFamilyId } from '../variants';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';

interface CommunityViewProps {
  byProductId: Map<string, CardVariant>;
  wants: WantsApi;
  available: AvailableApi;
  onClose: () => void;
}

type SortMode = 'overlap' | 'offer' | 'receive' | 'alpha';

interface MemberWithOverlap extends CommunityMember {
  iCanOfferThem: number;
  theyCanOfferMe: number;
  totalOverlap: number;
}

/**
 * /?community=1 — directory of members in the viewer's mutually-
 * enrolled guilds. Complements the aggregated community rollup
 * (`handleCommunity`) with per-user visibility — "who has what"
 * instead of "what exists in the community."
 *
 * Overlap is computed client-side: the server returns each member's
 * wantFamilyIds + availableProductIds, and we intersect those with
 * the viewer's own lists using the productId → familyId lookup
 * (already materialized up in App.tsx as part of cardIndex).
 *
 * Sort modes:
 *   - overlap (default): total overlap desc — actionable trades up top
 *   - offer: cards I could give them, desc
 *   - receive: cards they could give me, desc
 *   - alpha: handle A-Z — for when you're scanning a specific user
 */
export function CommunityView({ byProductId, wants, available, onClose }: CommunityViewProps) {
  const community = useCommunityMembers();
  const { members, status } = community;
  const [sort, setSort] = useState<SortMode>('overlap');

  // Viewer's available converted to familyIds (one card can exist
  // as multiple variants; the family is the trade-unit we match on).
  // Memoized so re-renders from sort changes don't re-scan the
  // available list.
  const viewerAvailableFamilies = useMemo(() => {
    const s = new Set<string>();
    for (const item of available.items) {
      const card = byProductId.get(item.productId);
      if (card) s.add(cardFamilyId(card));
    }
    return s;
  }, [available.items, byProductId]);

  const viewerWantFamilies = useMemo(() => {
    const s = new Set<string>();
    for (const w of wants.items) s.add(w.familyId);
    return s;
  }, [wants.items]);

  const enriched = useMemo<MemberWithOverlap[]>(() => {
    return members.map(m => {
      let iCanOfferThem = 0;
      for (const fid of m.wantFamilyIds) {
        if (viewerAvailableFamilies.has(fid)) iCanOfferThem++;
      }
      let theyCanOfferMe = 0;
      const theirAvailableFamilies = new Set<string>();
      for (const pid of m.availableProductIds) {
        const card = byProductId.get(pid);
        if (card) theirAvailableFamilies.add(cardFamilyId(card));
      }
      for (const fid of theirAvailableFamilies) {
        if (viewerWantFamilies.has(fid)) theyCanOfferMe++;
      }
      return {
        ...m,
        iCanOfferThem,
        theyCanOfferMe,
        totalOverlap: iCanOfferThem + theyCanOfferMe,
      };
    });
  }, [members, viewerAvailableFamilies, viewerWantFamilies, byProductId]);

  const sorted = useMemo(() => {
    const copy = [...enriched];
    copy.sort((a, b) => {
      switch (sort) {
        case 'offer': return b.iCanOfferThem - a.iCanOfferThem || b.totalOverlap - a.totalOverlap;
        case 'receive': return b.theyCanOfferMe - a.theyCanOfferMe || b.totalOverlap - a.totalOverlap;
        case 'alpha': return a.handle.localeCompare(b.handle);
        case 'overlap':
        default:
          return b.totalOverlap - a.totalOverlap || a.handle.localeCompare(b.handle);
      }
    });
    return copy;
  }, [enriched, sort]);

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <div className="px-3 sm:px-6 pt-3 pb-2 max-w-3xl mx-auto w-full">
        <PageHeader onBack={onClose} kicker="Community" />
      </div>

      <main className="flex-1 px-3 sm:px-6 pb-12 pt-2 max-w-3xl mx-auto w-full">
        <section className="mt-6" aria-labelledby="community-heading">
          <h2 id="community-heading" className="sr-only">Community members</h2>

          {status === 'loading' && <LoadingState label="Loading community…" />}
          {status === 'error' && (
            <ErrorState>Couldn't load the community directory. Try refreshing.</ErrorState>
          )}

          {status === 'ready' && members.length === 0 && (
            <EmptyState title="No one to trade with yet.">
              Enroll in a Discord server on the Settings page and turn on
              "Appear in who-has queries" — you'll see members of that
              server who've done the same here.
            </EmptyState>
          )}

          {status === 'ready' && members.length > 0 && (
            <>
              <SortTabs sort={sort} onChange={setSort} />
              <ul className="flex flex-col gap-3">
                {sorted.map(m => (
                  <MemberRow key={m.userId} member={m} />
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function SortTabs({ sort, onChange }: { sort: SortMode; onChange: (s: SortMode) => void }) {
  const tabs: Array<{ id: SortMode; label: string }> = [
    { id: 'overlap', label: 'Best overlap' },
    { id: 'offer', label: 'I can offer' },
    { id: 'receive', label: 'They have' },
    { id: 'alpha', label: 'A–Z' },
  ];
  return (
    <div className="flex gap-1.5 mb-4 overflow-x-auto -mx-1 px-1" role="tablist" aria-label="Sort members">
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={sort === t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 h-7 rounded-full text-[11px] font-semibold tracking-wide uppercase shrink-0 transition-colors ${
            sort === t.id
              ? 'bg-gold/20 border border-gold/50 text-gold'
              : 'bg-space-800/60 border border-space-700 text-gray-400 hover:text-gold hover:border-gold/30'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function MemberRow({ member }: { member: MemberWithOverlap }) {
  const { handle, username, avatarUrl, mutualGuildNames, mutualGuildIds, iCanOfferThem, theyCanOfferMe, wantsTotal, availableTotal } = member;
  const profileHref = `/u/${encodeURIComponent(handle)}`;
  const hasOverlap = iCanOfferThem + theyCanOfferMe > 0;
  const hasOverride = hasAnyPeerOverride(member);
  // Deep-link to the Settings member-prefs detail, scoped to the
  // first mutual guild — that's the most relevant "community context"
  // for the viewer landing on this member. Overrides apply globally,
  // so the choice of guild is cosmetic.
  const prefsHref = mutualGuildIds.length > 0
    ? `/?settings=1&tab=servers&guild=${encodeURIComponent(mutualGuildIds[0])}&members=1&user=${encodeURIComponent(member.userId)}`
    : null;

  return (
    <li
      className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
        hasOverlap
          ? 'bg-emerald-500/5 border-emerald-500/30 hover:border-emerald-400/60'
          : 'bg-space-800/40 border-space-700 hover:border-gold/30'
      }`}
    >
      <a href={profileHref} className="flex items-start gap-3 flex-1 min-w-0">
        <Avatar avatarUrl={avatarUrl} username={username} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-100 truncate">@{handle}</span>
            {username !== handle && (
              <span className="text-[11px] text-gray-500 truncate">{username}</span>
            )}
            {hasOverride && (
              <span className="text-[10px] tracking-wide uppercase text-gold font-bold">
                Prefs set
              </span>
            )}
          </div>
          {mutualGuildNames.length > 0 && (
            <div className="text-[11px] text-gray-500 mt-0.5 truncate">
              {mutualGuildNames.join(' · ')}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            <OverlapChip
              label="You can offer"
              count={iCanOfferThem}
              total={wantsTotal}
              tone="emerald"
            />
            <OverlapChip
              label="They have for you"
              count={theyCanOfferMe}
              total={availableTotal}
              tone="blue"
            />
          </div>
        </div>
      </a>
      {prefsHref && (
        <a
          href={prefsHref}
          className="shrink-0 self-start text-[10px] tracking-wide uppercase text-gray-500 hover:text-gold font-semibold py-1 px-2 rounded-md border border-space-700 hover:border-gold/40 transition-colors"
          title="Manage per-trader preferences in Settings"
        >
          Prefs
        </a>
      )}
    </li>
  );
}

function hasAnyPeerOverride(m: CommunityMember): boolean {
  return Object.values(m.peerPrefs.override).some(v => v !== null);
}

function OverlapChip({ label, count, total, tone }: {
  label: string;
  count: number;
  total: number;
  tone: 'emerald' | 'blue';
}) {
  const active = count > 0;
  const activeTone = tone === 'emerald'
    ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
    : 'bg-blue-500/15 border-blue-400/40 text-blue-200';
  const dimTone = 'bg-space-800/60 border-space-700 text-gray-500';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] ${active ? activeTone : dimTone}`}>
      <span className="font-semibold">{count}</span>
      <span className="font-normal opacity-80">of {total}</span>
      <span className="opacity-60">· {label}</span>
    </span>
  );
}

function Avatar({ avatarUrl, username }: { avatarUrl: string | null; username: string }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="w-10 h-10 rounded-full shrink-0" />;
  }
  const initial = username.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="w-10 h-10 rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0 text-sm"
    >
      {initial}
    </span>
  );
}

