import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardVariant } from '../types';
import type { AuthApi } from '../hooks/useAuth';
import type { WantsApi } from '../hooks/useWants';
import { useGuildMemberships } from '../hooks/useGuildMemberships';
import {
  searchSignalFamilies,
  lookupFamilyClient,
  type SignalSearchResult,
} from '../lib/signalCardSearch';
import { apiPost } from '../services/apiClient';

/**
 * Web Signal Builder — replaces the deprecated Discord
 * `/looking-for` and `/offering` slash commands. Lets the user
 * compose a multi-card signal with autocomplete-driven card
 * picking, per-card variant + qty + max-price, an optional note,
 * a chosen target guild, and a live preview before posting. On
 * submit, calls `/api/signals` which inserts the rows + posts the
 * embed via the bot client.
 */

interface SignalBuilderViewProps {
  auth: AuthApi;
  allCards: CardVariant[];
  /** Wants list — used by the "Pull from priorities" empty-state
   *  shortcut to seed the card list with priority-starred wants. */
  wants: WantsApi;
}

type SignalKind = 'wanted' | 'offering';

interface SignalCardEntry {
  familyId: string;
  /** null = "any printing" (default); otherwise a specific variant
   *  label that exists for this family. */
  variant: string | null;
  qty: number;
  /** null = no ceiling. */
  maxPrice: number | null;
  /** Cached for display; never sent to the server. */
  display: SignalSearchResult;
}

type PostedResult = {
  groupId: string;
  messageUrl: string;
  matchSummary: Array<{ familyId: string; matchCount: number }>;
};

export function SignalBuilderView({ auth, allCards, wants }: SignalBuilderViewProps) {
  const [kind, setKind] = useState<SignalKind>('wanted');
  const [cards, setCards] = useState<SignalCardEntry[]>([]);
  const [note, setNote] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [posted, setPosted] = useState<PostedResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { enrollable, status: guildsStatus } = useGuildMemberships();
  const eligibleGuilds = useMemo(
    () => enrollable.filter(g => g.enrolled),
    [enrollable],
  );
  // Auto-pick the first enrolled guild on initial load — most users
  // only have one. They can change later via the dropdown.
  useEffect(() => {
    if (guildId == null && eligibleGuilds.length > 0) {
      setGuildId(eligibleGuilds[0].guildId);
    }
  }, [guildId, eligibleGuilds]);

  // Pull-from-priorities: fill the card list with priority-starred
  // wants the user hasn't explicitly removed. One-tap shortcut for
  // the common "post my hunt list" use case.
  function pullFromPriorities() {
    const seeded: SignalCardEntry[] = [];
    for (const w of wants.items) {
      if (!w.isPriority) continue;
      const family = lookupFamilyClient(allCards, w.familyId);
      if (!family) continue;
      // Priority wishlist entries map cleanly onto a Looking-for
      // signal — restriction translates to variant pin.
      const variant = w.restriction.mode === 'restricted' && w.restriction.variants.length === 1
        ? w.restriction.variants[0]
        : null;
      seeded.push({
        familyId: w.familyId,
        variant,
        qty: w.qty,
        maxPrice: w.maxUnitPrice ?? null,
        display: family,
      });
    }
    setCards(seeded.slice(0, 20));
    setKind('wanted');
  }

  function addCardFromSearch(result: SignalSearchResult) {
    setCards(prev => {
      // Skip duplicates by familyId — adding the same card twice is
      // almost always an accident.
      if (prev.some(c => c.familyId === result.familyId)) return prev;
      return [...prev, {
        familyId: result.familyId,
        variant: null,
        qty: 1,
        maxPrice: null,
        display: result,
      }];
    });
    setPickerOpen(false);
  }

  function updateCard(index: number, patch: Partial<SignalCardEntry>) {
    setCards(prev => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function removeCard(index: number) {
    setCards(prev => prev.filter((_, i) => i !== index));
  }

  async function postSignal() {
    if (!guildId || cards.length === 0 || posting) return;
    setPosting(true);
    setPostError(null);
    const result = await apiPost<PostedResult>('/api/signals', {
      kind,
      cards: cards.map(c => ({
        familyId: c.familyId,
        variant: c.variant,
        qty: c.qty,
        maxPrice: c.maxPrice,
      })),
      note: note.trim() || null,
      guildId,
      expiresInDays,
    });
    setPosting(false);
    if (!result.ok) {
      setPostError(result.detail ?? 'Couldn\'t post — try again.');
      return;
    }
    setPosted(result.data);
  }

  // Auth gate. The page shouldn't be reachable for ghosts/anon
  // (routing guards), but defensive belt-and-suspenders.
  if (!auth.user) {
    return (
      <div className="max-w-xl mx-auto p-6 text-gray-300">
        <h1 className="text-xl font-bold text-gold mb-3">Sign in to post</h1>
        <p>This posts to a Discord server you've joined SWUTrade in. Sign in with Discord to continue.</p>
      </div>
    );
  }

  if (posted) {
    const matchCount = posted.matchSummary.reduce((acc, m) => acc + m.matchCount, 0);
    return (
      <div className="max-w-xl mx-auto p-6 text-center">
        <h1 className="text-2xl font-bold text-gold mb-3">Posted!</h1>
        <p className="text-gray-300 mb-4">
          Your post is live in Discord.
          {matchCount > 0 && (
            <> {matchCount === 1 ? 'One person' : `${matchCount} people`} in that server can help — they're listed under the post (we don't ping them automatically; reply in the channel if you want to nudge).</>
          )}
        </p>
        <a
          href={posted.messageUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block px-4 py-2 rounded-md bg-gold/20 border border-gold/50 text-gold font-bold hover:bg-gold/30"
        >
          Open in Discord →
        </a>
        <div className="mt-6 text-sm text-gray-500">
          <button
            onClick={() => { setPosted(null); setCards([]); setNote(''); }}
            className="underline hover:text-gray-300"
          >
            Post another
          </button>
        </div>
      </div>
    );
  }

  const canPost = cards.length > 0 && !!guildId && !posting;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 text-gray-100">
      <header className="mb-5">
        <h1 className="text-2xl font-bold text-gold tracking-wide">Post to your server</h1>
        <p className="text-sm text-gray-400 mt-1">
          Tell a Discord server which cards you're looking for or have to trade. SWUTrade lists the people in that server who can help — quietly, no auto-pings.
        </p>
      </header>

      <div className="flex gap-2 mb-5" role="tablist">
        <KindButton active={kind === 'wanted'} onClick={() => setKind('wanted')}>
          🔍 Looking for
        </KindButton>
        <KindButton active={kind === 'offering'} onClick={() => setKind('offering')}>
          💱 Offering
        </KindButton>
      </div>

      <section className="mb-5">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-bold tracking-[0.1em] uppercase text-gray-400">Cards</h2>
          {cards.length > 0 && <span className="text-xs text-gray-500">{cards.length} / 20</span>}
        </div>

        {cards.length === 0 ? (
          <EmptyState
            kind={kind}
            onAddClick={() => setPickerOpen(true)}
            onPullPriorities={pullFromPriorities}
            hasPriorities={wants.items.some(w => w.isPriority)}
          />
        ) : (
          <ul className="space-y-2">
            {cards.map((card, i) => (
              <CardRow
                key={card.familyId}
                card={card}
                onChange={patch => updateCard(i, patch)}
                onRemove={() => removeCard(i)}
              />
            ))}
            {cards.length < 20 && (
              <li>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="w-full px-3 py-2 rounded-md border border-dashed border-space-700 text-sm text-gray-400 hover:border-gold/40 hover:text-gold transition-colors"
                >
                  + Add another card
                </button>
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="mb-5">
        <label htmlFor="signal-note" className="block text-sm font-bold tracking-[0.1em] uppercase text-gray-400 mb-1">
          Note (optional)
        </label>
        <textarea
          id="signal-note"
          value={note}
          onChange={e => setNote(e.target.value.slice(0, 500))}
          placeholder="for Friday's draft @ Mox · DM me to coordinate"
          className="w-full bg-space-800/60 border border-space-700 rounded-md px-3 py-2 text-sm placeholder-gray-500 focus:border-gold/50 focus:outline-none resize-y min-h-[60px]"
          rows={2}
        />
        <div className="text-right text-xs text-gray-500 mt-0.5">
          {500 - note.length} characters left
        </div>
      </section>

      <section className="mb-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="signal-expiry" className="block text-sm font-bold tracking-[0.1em] uppercase text-gray-400 mb-1">
            Expires
          </label>
          <select
            id="signal-expiry"
            value={expiresInDays}
            onChange={e => setExpiresInDays(Number(e.target.value))}
            className="w-full bg-space-800/60 border border-space-700 rounded-md px-3 py-2 text-sm focus:border-gold/50 focus:outline-none"
          >
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>
        <div>
          <label htmlFor="signal-guild" className="block text-sm font-bold tracking-[0.1em] uppercase text-gray-400 mb-1">
            Post to
          </label>
          {guildsStatus === 'loading' ? (
            <div className="text-sm text-gray-500 italic px-3 py-2">Loading your servers…</div>
          ) : eligibleGuilds.length === 0 ? (
            <div className="text-sm text-gray-400 px-3 py-2 border border-amber-500/40 bg-amber-500/10 rounded-md">
              You haven't joined SWUTrade in any servers yet. Open the Communities page to join one.
            </div>
          ) : (
            <select
              id="signal-guild"
              value={guildId ?? ''}
              onChange={e => setGuildId(e.target.value || null)}
              className="w-full bg-space-800/60 border border-space-700 rounded-md px-3 py-2 text-sm focus:border-gold/50 focus:outline-none"
            >
              {eligibleGuilds.map(g => (
                <option key={g.guildId} value={g.guildId}>{g.guildName}</option>
              ))}
            </select>
          )}
        </div>
      </section>

      {cards.length > 0 && (
        <section className="mb-5">
          <h2 className="text-sm font-bold tracking-[0.1em] uppercase text-gray-400 mb-2">Preview</h2>
          <PreviewPane kind={kind} cards={cards} note={note} />
        </section>
      )}

      {postError && (
        <div role="alert" className="mb-3 px-3 py-2 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-300">
          {postError}
        </div>
      )}

      <div className="sticky bottom-0 bg-space-900/95 backdrop-blur-sm pt-3 pb-2 -mx-4 sm:-mx-6 px-4 sm:px-6 border-t border-space-800">
        <button
          type="button"
          onClick={postSignal}
          disabled={!canPost}
          className="w-full px-4 py-3 rounded-md bg-gold/20 border border-gold/50 text-gold font-bold hover:bg-gold/30 hover:border-gold/70 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {posting ? 'Posting…' : `Post to Discord`}
        </button>
      </div>

      {pickerOpen && (
        <CardSearchModal
          allCards={allCards}
          onPick={addCardFromSearch}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

// ---- Subcomponents -------------------------------------------------------

function KindButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 px-4 py-2 rounded-md text-sm font-bold border transition-colors ${
        active
          ? 'bg-gold/15 border-gold/50 text-gold'
          : 'bg-space-800/40 border-space-700 text-gray-400 hover:border-gold/30 hover:text-gold/80'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({
  kind,
  onAddClick,
  onPullPriorities,
  hasPriorities,
}: {
  kind: SignalKind;
  onAddClick: () => void;
  onPullPriorities: () => void;
  hasPriorities: boolean;
}) {
  return (
    <div className="text-center py-8 px-4 border border-dashed border-space-700 rounded-md">
      <p className="text-gray-400 text-sm mb-4">
        Add the cards you {kind === 'wanted' ? 'want' : 'have to trade'}. Up to 20 cards.
      </p>
      <div className="flex flex-col sm:flex-row gap-2 justify-center">
        <button
          type="button"
          onClick={onAddClick}
          className="px-4 py-2 rounded-md bg-gold/20 border border-gold/50 text-gold font-bold hover:bg-gold/30 transition-colors"
        >
          Add a card
        </button>
        {kind === 'wanted' && hasPriorities && (
          <button
            type="button"
            onClick={onPullPriorities}
            className="px-4 py-2 rounded-md bg-space-800/40 border border-space-700 text-gray-300 hover:border-gold/40 hover:text-gold transition-colors text-sm"
          >
            ★ Use my starred wishlist
          </button>
        )}
      </div>
    </div>
  );
}

function CardRow({
  card,
  onChange,
  onRemove,
}: {
  card: SignalCardEntry;
  onChange: (patch: Partial<SignalCardEntry>) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-stretch gap-2 p-2 rounded-md bg-space-800/40 border border-space-700">
      <img
        src={`https://product-images.tcgplayer.com/fit-in/100x140/${card.display.variants[0].productId}.jpg`}
        alt=""
        className="w-12 h-16 object-cover rounded shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate">{card.display.name}</div>
        <div className="text-[11px] text-gray-500">
          [{card.display.setCode}]{card.display.cardType === 'Leader' && ' (Leader)'}
          {card.display.alternateCount > 0 && ` · +${card.display.alternateCount} reprint${card.display.alternateCount === 1 ? '' : 's'}`}
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <label className="text-[11px] text-gray-400">
            Qty
            <input
              type="number"
              min={1}
              max={99}
              value={card.qty}
              onChange={e => onChange({ qty: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
              className="w-14 ml-1 bg-space-900/70 border border-space-700 rounded px-1 py-0.5 text-xs"
            />
          </label>
          <label className="text-[11px] text-gray-400">
            Variant
            <select
              value={card.variant ?? ''}
              onChange={e => onChange({ variant: e.target.value || null })}
              className="ml-1 bg-space-900/70 border border-space-700 rounded px-1 py-0.5 text-xs"
            >
              <option value="">Any printing</option>
              {card.display.variants.map(v => (
                <option key={v.productId} value={v.variant}>
                  {v.variant}{v.market != null ? ` · ~$${v.market.toFixed(2)}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-gray-400">
            Max $
            <input
              type="number"
              min={0}
              step={0.5}
              value={card.maxPrice ?? ''}
              onChange={e => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                onChange({ maxPrice: typeof v === 'number' && !isNaN(v) ? v : null });
              }}
              placeholder="—"
              className="w-16 ml-1 bg-space-900/70 border border-space-700 rounded px-1 py-0.5 text-xs"
            />
          </label>
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove card"
        className="px-2 text-gray-500 hover:text-red-400 transition-colors text-lg shrink-0"
      >
        ×
      </button>
    </li>
  );
}

function PreviewPane({ kind, cards, note }: { kind: SignalKind; cards: SignalCardEntry[]; note: string }) {
  const titleVerb = kind === 'wanted' ? '🔍 Looking for' : '💱 Offering';
  return (
    <div className="rounded-md border border-space-700 bg-space-800/40 p-3 text-sm">
      <div className="font-bold text-gold mb-2">
        {titleVerb} · {cards.length === 1 ? cards[0].display.name : `${cards.length} cards`}
      </div>
      <ul className="space-y-1 text-gray-300">
        {cards.map(c => (
          <li key={c.familyId}>
            • <span className="font-semibold">{c.qty}×</span> {c.display.name} <code className="text-xs text-gray-500">[{c.display.setCode}]</code>
            {c.display.cardType === 'Leader' && <span className="text-xs text-gray-500"> (Leader)</span>}
            {c.variant && <span className="text-xs text-gray-400"> · {c.variant} only</span>}
            {!c.variant && <span className="text-xs text-gray-500"> · any printing</span>}
            {c.maxPrice != null && <span className="text-xs text-gray-400"> · max ${c.maxPrice.toFixed(2)}</span>}
          </li>
        ))}
      </ul>
      {note && (
        <blockquote className="mt-2 pl-3 border-l-2 border-gold/40 text-xs text-gray-300">
          {note}
        </blockquote>
      )}
      <div className="mt-2 text-[10px] text-gray-500 italic">
        People in your server who can help will be listed here when you post.
      </div>
    </div>
  );
}

function CardSearchModal({
  allCards,
  onPick,
  onClose,
}: {
  allCards: CardVariant[];
  onPick: (result: SignalSearchResult) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(
    () => searchSignalFamilies(allCards, query, 25),
    [allCards, query],
  );

  // Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center pt-[10vh] px-4">
      <div className="w-full max-w-md bg-space-900 border border-space-700 rounded-lg shadow-2xl flex flex-col max-h-[80vh]">
        <div className="p-3 border-b border-space-800 flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search for a card by name…"
            className="flex-1 bg-space-800/60 border border-space-700 rounded-md px-3 py-2 text-sm focus:border-gold/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 flex items-center justify-center text-gray-400 hover:text-gray-100"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {query.trim().length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              Start typing a card name. Different printings of the same card are grouped — pick once and you can narrow the printing on the next screen.
            </div>
          ) : results.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              No matches for "{query}".
            </div>
          ) : (
            <ul className="divide-y divide-space-800">
              {results.map(r => (
                <li key={r.familyId}>
                  <button
                    type="button"
                    onClick={() => onPick(r)}
                    className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-space-800/60 transition-colors"
                  >
                    <img
                      src={`https://product-images.tcgplayer.com/fit-in/60x84/${r.variants[0].productId}.jpg`}
                      alt=""
                      className="w-8 h-11 object-cover rounded shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">{r.name}</div>
                      <div className="text-[11px] text-gray-500">
                        [{r.setCode}]{r.cardType === 'Leader' && ' (Leader)'}
                        {r.alternateCount > 0 && ` · +${r.alternateCount} printing${r.alternateCount === 1 ? '' : 's'}`}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
