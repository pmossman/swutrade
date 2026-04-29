import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardVariant } from '../types';
import { SETS } from '../types';
import type { AuthApi } from '../hooks/useAuth';
import type { WantsApi } from '../hooks/useWants';
import { useGuildMemberships } from '../hooks/useGuildMemberships';
import { AppHeader } from './ui/AppHeader';
import { ListCardPicker } from './ListCardPicker';
import { cardFamilyId } from '../variants';
import { apiPost } from '../services/apiClient';

/**
 * Web Signal Builder — replaces the deprecated Discord
 * `/looking-for` and `/offering` slash commands. Lets the user
 * compose a multi-card signal with the shared card picker, per-card
 * variant + qty + max-price, an optional note, a chosen target
 * guild, and a live preview before posting. On submit, calls
 * `/api/signals` which inserts the rows + posts the embed via the
 * bot client.
 */

interface SignalBuilderViewProps {
  auth: AuthApi;
  allCards: CardVariant[];
  /** Wants list — used by the "Use my starred wishlist" empty-state
   *  shortcut to seed the card list with priority-starred wants. */
  wants: WantsApi;
}

type SignalKind = 'wanted' | 'offering';

interface SignalCardEntry {
  /** Family-level id (`<set-slug>::<name-slug>`). The /api/signals
   *  contract is family-keyed; per-printing pinning is the variant
   *  field. */
  familyId: string;
  /** null = "any printing" (default); otherwise a specific variant
   *  label that exists for this family. */
  variant: string | null;
  qty: number;
  /** null = no ceiling. */
  maxPrice: number | null;
}

interface FamilyDisplay {
  /** Display name (variant suffix stripped). */
  name: string;
  /** Set code, e.g. "JTL", "SOR". */
  setCode: string;
  /** Card type (Leader / Unit / Event / etc) — optional, depends on
   *  whether the family was enriched. */
  cardType?: string;
  /** Variants in this family, sorted cheapest-first. */
  variants: Array<{ productId: string; variant: string; market: number | null }>;
}

type PostedResult = {
  groupId: string;
  messageUrl: string;
  matchSummary: Array<{ familyId: string; matchCount: number }>;
};

/** Read intent params off the current URL on initial render. The
 *  Home Wishlist + Binder CTAs deep-link with `?prefill=priorities`
 *  or `?kind=offering` so the builder lands in the right state for
 *  the user's intent. Falls back to safe defaults on SSR / no window. */
function readIntentParams(): { kind: SignalKind; prefillPriorities: boolean } {
  if (typeof window === 'undefined') {
    return { kind: 'wanted', prefillPriorities: false };
  }
  const params = new URLSearchParams(window.location.search);
  const kindParam = params.get('kind');
  return {
    kind: kindParam === 'offering' ? 'offering' : 'wanted',
    prefillPriorities: params.get('prefill') === 'priorities',
  };
}

/** Build a familyId → FamilyDisplay lookup from the catalog. Memoized
 *  on `allCards` reference so the cost is paid once per catalog
 *  reload, not per render. Pulled into the view so per-row rendering
 *  doesn't have to filter the full card array on every paint. */
function buildFamilyMap(allCards: CardVariant[]): Map<string, FamilyDisplay> {
  const groups = new Map<string, CardVariant[]>();
  for (const c of allCards) {
    const fid = cardFamilyId(c);
    const list = groups.get(fid) ?? [];
    list.push(c);
    groups.set(fid, list);
  }
  const setCodeBySlug = new Map(SETS.map(s => [s.slug, s.code]));
  const out = new Map<string, FamilyDisplay>();
  for (const [familyId, cards] of groups) {
    const variants = cards
      .map(c => ({
        productId: c.productId ?? '',
        variant: c.variant || 'Standard',
        market: c.marketPrice ?? null,
      }))
      .filter(v => v.productId.length > 0)
      .sort((a, b) => (a.market ?? Infinity) - (b.market ?? Infinity));
    if (variants.length === 0) continue;
    const primary = cards[0];
    const display = primary.displayName ?? primary.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const setSlug = familyId.split('::')[0];
    out.set(familyId, {
      name: display,
      setCode: setCodeBySlug.get(setSlug) ?? setSlug.slice(0, 4).toUpperCase(),
      cardType: cards.find(c => c.cardType)?.cardType,
      variants,
    });
  }
  return out;
}

export function SignalBuilderView({ auth, allCards, wants }: SignalBuilderViewProps) {
  // Pull intent off the URL once on mount. Capturing in a ref-style
  // useState initializer (vs reading inside a useEffect) means the
  // first render already reflects the chosen kind — no flicker from
  // 'wanted' → 'offering' on the initial paint.
  const intent = useRef(readIntentParams()).current;
  const [kind, setKind] = useState<SignalKind>(intent.kind);
  const [cards, setCards] = useState<SignalCardEntry[]>([]);
  const [note, setNote] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [guildId, setGuildId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [posted, setPosted] = useState<PostedResult | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const familyMap = useMemo(() => buildFamilyMap(allCards), [allCards]);

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
      if (!familyMap.has(w.familyId)) continue;
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
      });
    }
    setCards(seeded.slice(0, 20));
    setKind('wanted');
  }

  // Honour `?prefill=priorities` from the deep-link CTAs. Wants is
  // loaded synchronously from localStorage, but a freshly-signed-in
  // user might have empty local state until server sync runs — so
  // we re-check on `wants.items` change and bail early once the
  // prefill has fired or once the user starts editing manually.
  const prefillRan = useRef(false);
  useEffect(() => {
    if (prefillRan.current) return;
    if (!intent.prefillPriorities) return;
    if (cards.length > 0) return;
    if (!wants.items.some(w => w.isPriority)) return;
    prefillRan.current = true;
    pullFromPriorities();
    // Strip the prefill param from the URL so a refresh doesn't
    // re-seed (which would clobber any cards the user just removed).
    const url = new URL(window.location.href);
    url.searchParams.delete('prefill');
    window.history.replaceState({}, '', url.toString());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wants.items]);

  function handlePick(card: CardVariant, ctx: { acceptedVariants?: string[] }) {
    const familyId = cardFamilyId(card);
    if (!familyMap.has(familyId)) {
      setPickerOpen(false);
      return;
    }
    // The picker's variant filter (acceptedVariants) drives the
    // pinned printing — same wiring WantsPanel uses. Empty filter
    // → 'any'. Single value → that variant. Multiple values left
    // as 'any' since the API only takes one variant pin per card
    // today.
    const accepted = ctx.acceptedVariants ?? [];
    const variant = accepted.length === 1 ? accepted[0] : null;
    setCards(prev => {
      // Skip duplicates by familyId — adding the same card twice is
      // almost always an accident; the user can change variant on
      // the existing entry instead.
      if (prev.some(c => c.familyId === familyId)) return prev;
      return [...prev, { familyId, variant, qty: 1, maxPrice: null }];
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
      <PageChrome auth={auth}>
        <div className="max-w-xl mx-auto p-6 text-gray-300">
          <h1 className="text-xl font-bold text-gold mb-3">Sign in to post</h1>
          <p>Posts go to a Discord server where you've joined SWUTrade. Sign in with Discord to continue.</p>
        </div>
      </PageChrome>
    );
  }

  if (posted) {
    const matchCount = posted.matchSummary.reduce((acc, m) => acc + m.matchCount, 0);
    return (
      <PageChrome auth={auth}>
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
      </PageChrome>
    );
  }

  const canPost = cards.length > 0 && !!guildId && !posting;

  if (pickerOpen) {
    // The picker's listType controls visual cues (saved-qty badges,
    // tap-to-decrement). We deliberately omit `wants` / `available`
    // so the picker stays in pure-search mode — the Signal Builder
    // composes a draft list and only mutates inventory on submit
    // via /api/signals. Mapping kind→listType keeps the variant
    // filter UX consistent with how the user thinks about the side:
    // 'wanted' → wants picker, 'offering' → binder picker.
    // Wrapped in the same max-w-3xl column the form uses so the
    // picker tile grid keeps a sensible thumbnail size on wide
    // screens — matches WishlistView/BinderView's chrome.
    return (
      <PageChrome auth={auth}>
        <div className="flex-1 flex flex-col max-w-3xl mx-auto w-full px-3 sm:px-6 pb-6 pt-3 min-h-0">
          <ListCardPicker
            listType={kind === 'wanted' ? 'wants' : 'available'}
            allCards={allCards}
            priceMode="market"
            onPick={handlePick}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      </PageChrome>
    );
  }

  // Mirror the live embed's palette so the form's left edge / header
  // accent flips colour the moment the user toggles kind. Source of
  // truth: lib/signalMessages.ts COLOR_WANTED / COLOR_OFFERING.
  const accent = kind === 'wanted' ? 'blue' : 'emerald';
  const accentBorder = accent === 'blue' ? 'border-l-blue-500' : 'border-l-emerald-500';
  const accentBg = accent === 'blue' ? 'bg-blue-500/10' : 'bg-emerald-500/10';
  const accentText = accent === 'blue' ? 'text-blue-300' : 'text-emerald-300';
  const verb = kind === 'wanted' ? '🔍 Looking for' : '💱 Offering';
  const titleSuffix = cards.length === 0
    ? <span className="text-gray-500 italic">add a card to start…</span>
    : cards.length === 1
      ? familyMap.get(cards[0].familyId)?.name ?? '—'
      : `${cards.length} cards`;

  return (
    <PageChrome auth={auth}>
      <div className="max-w-3xl mx-auto p-4 sm:p-6 text-gray-100 w-full pb-24">
        <header className="mb-4">
          <h1 className="text-xl font-bold text-gold tracking-wide">Post to your server</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            What you fill out below is what your server will see.
          </p>
        </header>

        {/* Post settings — metadata about the post itself (which side,
            where it goes, when it expires). Lives in a slim strip
            outside the embed-styled body so the body can read 1-to-1
            with the rendered Discord post. */}
        <div className="mb-4 rounded-md border border-space-700 bg-space-800/40 p-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div className="flex items-center gap-1" role="tablist">
            <span className="text-gray-500 font-semibold uppercase tracking-wide pr-1">Kind</span>
            <KindPill active={kind === 'wanted'} accent="blue" onClick={() => setKind('wanted')}>
              🔍 Looking
            </KindPill>
            <KindPill active={kind === 'offering'} accent="emerald" onClick={() => setKind('offering')}>
              💱 Offering
            </KindPill>
          </div>
          <label className="flex items-center gap-2">
            <span className="text-gray-500 font-semibold uppercase tracking-wide">To</span>
            {guildsStatus === 'loading' ? (
              <span className="text-gray-500 italic flex-1">Loading…</span>
            ) : eligibleGuilds.length === 0 ? (
              <span className="text-amber-400 flex-1">No enrolled servers</span>
            ) : (
              <select
                value={guildId ?? ''}
                onChange={e => setGuildId(e.target.value || null)}
                className="flex-1 min-w-0 bg-space-900/70 border border-space-700 rounded px-2 py-1 text-xs focus:border-gold/50 focus:outline-none"
              >
                {eligibleGuilds.map(g => (
                  <option key={g.guildId} value={g.guildId}>{g.guildName}</option>
                ))}
              </select>
            )}
          </label>
          <label className="flex items-center gap-2">
            <span className="text-gray-500 font-semibold uppercase tracking-wide">For</span>
            <select
              value={expiresInDays}
              onChange={e => setExpiresInDays(Number(e.target.value))}
              className="flex-1 bg-space-900/70 border border-space-700 rounded px-2 py-1 text-xs focus:border-gold/50 focus:outline-none"
            >
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
        </div>

        {eligibleGuilds.length === 0 && guildsStatus !== 'loading' && (
          <div className="mb-4 text-xs text-gray-300 px-3 py-2 border border-amber-500/40 bg-amber-500/10 rounded-md">
            You haven't joined SWUTrade in any servers yet. Open the Communities page to join one.
          </div>
        )}

        {/* Embed-styled body — what the user is composing IS the post.
            Colored left edge matches the live Discord embed (blue for
            wanted, emerald for offering). Author + title block reads
            top-to-bottom like the rendered embed. The Preview section
            is gone; this body is the preview. */}
        <article className={`rounded-md border border-space-700 ${accentBg} border-l-4 ${accentBorder} pl-4 pr-3 py-3`}>
          <div className="flex items-center gap-2 mb-2">
            {auth.user?.avatarUrl ? (
              <img src={auth.user.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
            ) : (
              <div className="w-5 h-5 rounded-full bg-space-700" />
            )}
            <span className={`text-xs font-semibold ${accentText}`}>@{auth.user?.handle ?? 'you'}</span>
          </div>

          <h2 className="text-base font-bold text-gold mb-3 leading-tight">
            <span className="mr-1">{verb} ·</span>
            {titleSuffix}
          </h2>

          {cards.length === 0 ? (
            <EmptyState
              kind={kind}
              onAddClick={() => setPickerOpen(true)}
              onPullPriorities={pullFromPriorities}
              hasPriorities={wants.items.some(w => w.isPriority)}
            />
          ) : (
            <ul className="space-y-2">
              {cards.map((card, i) => {
                const family = familyMap.get(card.familyId);
                if (!family) return null;
                return (
                  <CardRow
                    key={card.familyId}
                    card={card}
                    family={family}
                    onChange={patch => updateCard(i, patch)}
                    onRemove={() => removeCard(i)}
                  />
                );
              })}
              {cards.length < 20 && (
                <li>
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className="w-full px-3 py-1.5 rounded border border-dashed border-space-600 text-xs text-gray-400 hover:border-gold/40 hover:text-gold transition-colors"
                  >
                    + Add another card{cards.length >= 1 ? ` (${cards.length} / 20)` : ''}
                  </button>
                </li>
              )}
            </ul>
          )}

          {/* Note rendered as a blockquote-styled inline editor — the
              live embed shows it as `> note` text, so we mirror that
              shape rather than a labelled form field. */}
          <div className="mt-3">
            <textarea
              id="signal-note"
              value={note}
              onChange={e => setNote(e.target.value.slice(0, 500))}
              placeholder="Add a note (optional) — e.g. for Friday's draft @ Mox"
              className="w-full bg-transparent border-l-2 border-gold/30 pl-3 text-xs text-gray-300 placeholder-gray-600 focus:border-gold/60 focus:outline-none resize-y min-h-[40px]"
              rows={1}
            />
            {note.length > 400 && (
              <div className="text-right text-[10px] text-gray-500">{500 - note.length} characters left</div>
            )}
          </div>

          {/* Footer: expiry + match-listing placeholder. Mirrors the
              live embed's `⏱ Expires in N days` line + the `📦 …` line
              that lists matched users when posted. */}
          <div className="mt-3 pt-2 border-t border-space-700/50 text-[11px] text-gray-400 space-y-0.5">
            <div>⏱ Expires in {expiresInDays} {expiresInDays === 1 ? 'day' : 'days'}</div>
            <div className="text-gray-500 italic">📦 People in your server who can help will be listed here when you post.</div>
          </div>
        </article>

        {postError && (
          <div role="alert" className="mt-3 px-3 py-2 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-300">
            {postError}
          </div>
        )}
      </div>

      {/* Sticky bottom Post button — lives outside the scrollable
          content so it stays anchored on long signal drafts. */}
      <div className="sticky bottom-0 bg-space-900/95 backdrop-blur-sm border-t border-space-800">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3">
          <button
            type="button"
            onClick={postSignal}
            disabled={!canPost}
            className="w-full px-4 py-3 rounded-md bg-gold/20 border border-gold/50 text-gold font-bold hover:bg-gold/30 hover:border-gold/70 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {posting ? 'Posting…' : `Post to Discord`}
          </button>
        </div>
      </div>
    </PageChrome>
  );
}

/**
 * Standard page chrome — header + main wrapper. Same shape as
 * BinderView / ProfileView / SettingsView use, so the Signal Builder
 * page reads as a first-class app surface and not a floating dialog.
 */
function PageChrome({ auth, children }: { auth: AuthApi; children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Post to a server' },
        ]}
      />
      <main className="flex-1 flex flex-col w-full">
        {children}
      </main>
    </div>
  );
}

// ---- Subcomponents -------------------------------------------------------

/** Compact pill toggle for the kind row. Picks up the side's accent
 *  colour (blue for wanted, emerald for offering) when active so the
 *  selection state hints at the embed colour the post will carry. */
function KindPill({
  active,
  accent,
  onClick,
  children,
}: {
  active: boolean;
  accent: 'blue' | 'emerald';
  onClick: () => void;
  children: React.ReactNode;
}) {
  const activeCls = accent === 'blue'
    ? 'bg-blue-500/15 border-blue-500/50 text-blue-200'
    : 'bg-emerald-500/15 border-emerald-500/50 text-emerald-200';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors ${
        active ? activeCls : 'bg-space-900/40 border-space-700 text-gray-400 hover:border-gold/30 hover:text-gold/80'
      }`}
    >
      {children}
    </button>
  );
}

/** Empty-state shown inside the embed body when no cards have been
 *  added yet. Sits where the bullet list will eventually go so the
 *  user reads the embed shape from the very first paint. */
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
    <div className="py-4 text-sm">
      <p className="text-gray-400 mb-3">
        • Pick the cards you {kind === 'wanted' ? 'want' : 'have to trade'} (up to 20).
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={onAddClick}
          className="px-3 py-1.5 rounded bg-gold/20 border border-gold/50 text-gold text-xs font-bold hover:bg-gold/30 transition-colors"
        >
          + Add a card
        </button>
        {kind === 'wanted' && hasPriorities && (
          <button
            type="button"
            onClick={onPullPriorities}
            className="px-3 py-1.5 rounded bg-space-900/40 border border-space-700 text-gray-300 hover:border-gold/40 hover:text-gold transition-colors text-xs"
          >
            ★ Use my starred wishlist
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One bullet in the embed body. Reads top-to-bottom like the live
 * Discord embed:
 *
 *   • 2× Luke Skywalker — Hero of Yavin [JTL] (Leader) · any printing
 *
 * The qty / variant / max-price controls render inline as small
 * editable chips so the user is *editing the rendered post*, not
 * filling out a labelled form. A small thumbnail anchors the row
 * (matches the live embed's single-card thumbnail; multi-card posts
 * drop the embed thumbnail but the form keeps a small one as a
 * recognition cue).
 */
function CardRow({
  card,
  family,
  onChange,
  onRemove,
}: {
  card: SignalCardEntry;
  family: FamilyDisplay;
  onChange: (patch: Partial<SignalCardEntry>) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-start gap-2 group">
      <span className="text-gray-500 select-none text-sm leading-6">•</span>
      <img
        src={`https://product-images.tcgplayer.com/fit-in/100x140/${family.variants[0].productId}.jpg`}
        alt=""
        className="w-8 h-11 object-cover rounded shrink-0 mt-0.5"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap text-sm">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={card.qty}
            onChange={e => {
              const digits = e.target.value.replace(/\D/g, '');
              const n = digits === '' ? 1 : parseInt(digits, 10);
              onChange({ qty: Math.max(1, Math.min(99, n)) });
            }}
            aria-label="Quantity"
            className="w-9 text-center bg-space-900/70 border border-space-700 rounded px-1 py-0.5 text-xs font-bold focus:border-gold/50 focus:outline-none"
          />
          <span className="text-gray-500">×</span>
          <span className="font-semibold text-gray-100 truncate">{family.name}</span>
          <code className="text-[11px] text-gray-500">[{family.setCode}]</code>
          {family.cardType === 'Leader' && <span className="text-[11px] text-gray-500">(Leader)</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap text-[11px] text-gray-400">
          <select
            value={card.variant ?? ''}
            onChange={e => onChange({ variant: e.target.value || null })}
            aria-label="Variant"
            className="bg-space-900/70 border border-space-700 rounded px-1 py-0.5 focus:border-gold/50 focus:outline-none"
          >
            <option value="">any printing</option>
            {family.variants.map(v => (
              <option key={v.productId} value={v.variant}>
                {v.variant}{v.market != null ? ` · ~$${v.market.toFixed(2)}` : ''}
              </option>
            ))}
          </select>
          <span className="text-gray-600">·</span>
          <label className="flex items-center gap-1">
            max&nbsp;$
            <input
              type="text"
              inputMode="decimal"
              value={card.maxPrice ?? ''}
              onChange={e => {
                const cleaned = e.target.value.replace(/[^0-9.]/g, '');
                if (cleaned === '') { onChange({ maxPrice: null }); return; }
                const v = Number(cleaned);
                onChange({ maxPrice: !isNaN(v) ? Math.min(10000, Math.max(0, v)) : null });
              }}
              placeholder="—"
              aria-label="Max price"
              className="w-14 bg-space-900/70 border border-space-700 rounded px-1 py-0.5 focus:border-gold/50 focus:outline-none"
            />
          </label>
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove card"
        className="px-1.5 text-gray-600 hover:text-red-400 transition-colors text-base shrink-0"
      >
        ×
      </button>
    </li>
  );
}
