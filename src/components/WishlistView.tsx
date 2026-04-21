import { useCallback, useMemo, useState } from 'react';
import type { AuthApi } from '../hooks/useAuth';
import type { WantsApi } from '../hooks/useWants';
import type { CardVariant, PriceMode } from '../types';
import { cardFamilyId } from '../variants';
import { AppHeader } from './ui/AppHeader';
import { WantsPanel } from './lists/WantsPanel';
import { TradeImageModal } from './TradeImageModal';
import { encodeWants } from '../urlCodec';
import { useAuthContext } from '../contexts/AuthContext';

/**
 * Dedicated Wishlist view — reached from Home ("Edit wishlist →") or
 * NavMenu ("My Wishlist"). Replaces the shared Radix Drawer's Wants
 * tab as the canonical edit surface. The drawer still exists for the
 * in-trade-builder quick-edit sidebar; this view is the primary
 * destination for longer-form list management.
 *
 * Feature parity with the drawer's Wants tab in this slice — no new
 * functionality. Enhancement backlog lives in NEXT.md under
 * "Wishlist / Binder enhancement backlog" and should be picked
 * per-slice from there.
 */
interface WishlistViewProps {
  auth: AuthApi;
  wants: WantsApi;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
}

export function WishlistView({
  auth,
  wants,
  allCards,
  percentage,
  priceMode,
}: WishlistViewProps) {
  // Index the catalog the same way the drawer does so the rows get
  // the restriction-aware thumbnail (e.g. Showcase art for a Showcase
  // want) via `bestMatchForWant`.
  const { byFamily, byFamilyAll } = useMemo(() => {
    const byFamily = new Map<string, CardVariant>();
    const byFamilyAll = new Map<string, CardVariant[]>();
    for (const card of allCards) {
      const fid = cardFamilyId(card);
      const existing = byFamily.get(fid);
      if (!existing || card.variant === 'Standard') byFamily.set(fid, card);
      const bucket = byFamilyAll.get(fid);
      if (bucket) bucket.push(card);
      else byFamilyAll.set(fid, [card]);
    }
    return { byFamily, byFamilyAll };
  }, [allCards]);

  const count = wants.items.length;
  const priorityCount = useMemo(
    () => wants.items.filter(w => w.isPriority).length,
    [wants.items],
  );

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Wishlist' },
        ]}
      />

      <main className="flex-1 flex flex-col max-w-3xl mx-auto w-full px-3 sm:px-6 pb-6 pt-3">
        <header className="flex items-baseline justify-between gap-3 pb-3 border-b border-space-800 mb-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-100">Your wishlist</h1>
            <div className="text-[12px] text-gray-400 tabular-nums mt-0.5">
              <span className="text-gray-200 font-semibold">{count}</span>
              {count === 1 ? ' card' : ' cards'}
              {priorityCount > 0 && (
                <>
                  {' · '}
                  <span className="text-gold font-semibold">{priorityCount}</span>
                  {' priority'}
                </>
              )}
            </div>
          </div>
          <ShareWishlistButton wants={wants.items} />
        </header>

        {/* Card-editing surface. Fills the remaining viewport so the
            list scrolls against a fixed footer (Add Card). Mirrors
            the drawer's layout; only the outer chrome differs. */}
        <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-space-800 bg-space-900 overflow-hidden">
          <WantsPanel
            wants={wants}
            allCards={allCards}
            percentage={percentage}
            priceMode={priceMode}
            byFamily={byFamily}
            byFamilyAll={byFamilyAll}
            emptyState={{
              title: 'Your wishlist is empty',
              body: "Add cards you're hunting for. Matchmaking against other traders' binders will find them.",
            }}
          />
        </div>
      </main>
    </div>
  );
}

/**
 * Share-only-wishlist button — scoped to the viewer's wants list.
 * The drawer's combined share button encodes both ?w= and ?a= so
 * recipients see wants+available side-by-side; a dedicated wishlist
 * share should only carry wants. Split on purpose so a later
 * Binder-specific share can do the same in reverse without shared
 * code having to branch on "which list am I".
 */
function ShareWishlistButton({ wants }: { wants: WantsApi['items'] }) {
  const { user } = useAuthContext();
  const [copied, setCopied] = useState(false);
  const [showImage, setShowImage] = useState(false);

  const shareUrl = useCallback((): URL => {
    const url = new URL(window.location.href);
    if (wants.length > 0) url.searchParams.set('w', encodeWants(wants));
    else url.searchParams.delete('w');
    url.searchParams.delete('a');
    // Recipients land on /list, not the dedicated wishlist view.
    url.searchParams.delete('view');
    if (user) url.searchParams.set('from', user.handle);
    else url.searchParams.delete('from');
    return url;
  }, [wants, user]);

  const handleCopy = useCallback(async () => {
    const url = shareUrl().toString();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard unavailable (insecure context). Fall back to a
      // transient input + execCommand. Matches ListsDrawer's pattern.
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [shareUrl]);

  const imageUrl = useCallback(() => {
    const url = shareUrl();
    const params = new URLSearchParams();
    const w = url.searchParams.get('w');
    if (w) params.set('w', w);
    const pct = url.searchParams.get('pct');
    const pm = url.searchParams.get('pm');
    if (pct) params.set('pct', pct);
    if (pm) params.set('pm', pm);
    return `/api/og?${params.toString()}`;
  }, [shareUrl]);

  if (wants.length === 0) return null;

  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={handleCopy}
        className="px-3 h-8 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-semibold text-gray-300 hover:text-gold transition-colors"
      >
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
      <button
        type="button"
        onClick={() => setShowImage(true)}
        className="px-3 h-8 rounded-md bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-semibold text-gray-300 hover:text-gold transition-colors"
      >
        Share image
      </button>
      {showImage && (
        <TradeImageModal
          imageUrl={imageUrl()}
          onClose={() => setShowImage(false)}
        />
      )}
    </div>
  );
}
