import { useCallback, useMemo, useState } from 'react';
import type { AuthApi } from '../hooks/useAuth';
import type { AvailableApi } from '../hooks/useAvailable';
import type { CardVariant, PriceMode } from '../types';
import { AppHeader } from './ui/AppHeader';
import { AvailablePanel } from './lists/AvailablePanel';
import { TradeImageModal } from './TradeImageModal';
import { encodeAvailable } from '../urlCodec';
import { useAuthContext } from '../contexts/AuthContext';

/**
 * Dedicated Binder view — reached from Home ("Edit binder →") or
 * NavMenu ("My Binder"). Replaces the shared Radix Drawer's
 * Available tab as the canonical edit surface. The drawer still
 * exists for the in-trade-builder quick-edit sidebar; this view is
 * the primary destination for longer-form inventory management.
 *
 * Feature parity with the drawer's Available tab in this slice —
 * no new functionality. Enhancement backlog (value headline,
 * set-completion progress, condition field, bulk import, …) lives
 * in NEXT.md under "Wishlist / Binder enhancement backlog" and
 * should be picked per-slice from there.
 */
interface BinderViewProps {
  auth: AuthApi;
  available: AvailableApi;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
}

export function BinderView({
  auth,
  available,
  allCards,
  percentage,
  priceMode,
}: BinderViewProps) {
  // byProductId drives the per-row card resolution + popular-wants
  // aggregation. Same shape the drawer constructs; built per view
  // so we don't have to thread the map through from App.
  const byProductId = useMemo(() => {
    const map = new Map<string, CardVariant>();
    for (const card of allCards) {
      if (card.productId) map.set(card.productId, card);
    }
    return map;
  }, [allCards]);

  const count = available.items.length;

  return (
    <div className="min-h-[100dvh] bg-space-900 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Binder' },
        ]}
      />

      <main className="flex-1 flex flex-col max-w-3xl mx-auto w-full px-3 sm:px-6 pb-6 pt-3">
        <header className="flex items-baseline justify-between gap-3 pb-3 border-b border-space-800 mb-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-100">Your binder</h1>
            <div className="text-[12px] text-gray-400 tabular-nums mt-0.5">
              <span className="text-gray-200 font-semibold">{count}</span>
              {count === 1 ? ' card available' : ' cards available'}
            </div>
          </div>
          <ShareBinderButton available={available.items} />
        </header>

        <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-space-800 bg-space-900 overflow-hidden">
          <AvailablePanel
            available={available}
            allCards={allCards}
            percentage={percentage}
            priceMode={priceMode}
            byProductId={byProductId}
            emptyState={{
              title: 'Your binder is empty',
              body: 'Add cards you have available to trade. Matchmaking will surface them to other traders looking for matches.',
            }}
          />
        </div>
      </main>
    </div>
  );
}

/**
 * Share-only-binder button — scoped to the viewer's binder list.
 * The drawer's combined share button encodes both ?w= and ?a=; this
 * button only carries ?a= so recipients land on a binder-scoped
 * shared list. Parallel to WishlistView's `ShareWishlistButton`;
 * kept separate so future changes (e.g. binder-specific value
 * summary on the image) don't have to branch on mode.
 */
function ShareBinderButton({ available }: { available: AvailableApi['items'] }) {
  const { user } = useAuthContext();
  const [copied, setCopied] = useState(false);
  const [showImage, setShowImage] = useState(false);

  const shareUrl = useCallback((): URL => {
    const url = new URL(window.location.href);
    if (available.length > 0) url.searchParams.set('a', encodeAvailable(available));
    else url.searchParams.delete('a');
    url.searchParams.delete('w');
    url.searchParams.delete('view');
    if (user) url.searchParams.set('from', user.handle);
    else url.searchParams.delete('from');
    return url;
  }, [available, user]);

  const handleCopy = useCallback(async () => {
    const url = shareUrl().toString();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
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
    const a = url.searchParams.get('a');
    if (a) params.set('a', a);
    const pct = url.searchParams.get('pct');
    const pm = url.searchParams.get('pm');
    if (pct) params.set('pct', pct);
    if (pm) params.set('pm', pm);
    return `/api/og?${params.toString()}`;
  }, [shareUrl]);

  if (available.length === 0) return null;

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
