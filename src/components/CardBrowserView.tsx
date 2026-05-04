import { useState } from 'react';
import type { AuthApi } from '../hooks/useAuth';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import type { CardVariant, PriceMode } from '../types';
import { extractVariantLabel, cardFamilyId, type CanonicalVariant } from '../variants';
import { AppHeader } from './ui/AppHeader';
import { ListCardPicker } from './ListCardPicker';
import { CardActionsDialog } from './CardActionsDialog';

interface CardBrowserViewProps {
  auth: AuthApi;
  allCards: CardVariant[];
  wants: WantsApi;
  available: AvailableApi;
  priceMode: PriceMode;
  /** Seeds the trade builder's offering side with this card and routes
   *  to the composer. Owned by App because the trade-builder state
   *  lives there; the browser just hands the card off. */
  onStartTradeWithCard: (card: CardVariant) => void;
}

/**
 * Top-level "Browse cards" view — discovery surface for searching the
 * catalogue and looking at prices without committing to a destination.
 *
 * Reuses ListCardPicker in `specific` mode (one tile per printing) so
 * every variant carries its own price. Tile click opens the
 * CardActionsDialog so the user can pivot into wishlist / binder /
 * trade flows. Peer to the per-view pickers — those are the
 * already-in-context fast paths; this is the "I'm thinking about
 * cards" entry point.
 *
 * Note: `savedEntries` is intentionally `[]`. Every wishlist/binder
 * entry would otherwise display its qty badge, but this surface has
 * three peer destinations (no implicit one), so badges would lie
 * about which list a tap will land in. The dialog itself shows the
 * current state by routing through the same add helpers as the
 * dedicated views.
 */
export function CardBrowserView({
  auth,
  allCards,
  wants,
  available,
  priceMode,
  onStartTradeWithCard,
}: CardBrowserViewProps) {
  const [actionCard, setActionCard] = useState<CardVariant | null>(null);

  const handleAddToWishlist = (card: CardVariant) => {
    // Specific-mode tiles map 1:1 to a variant — pin the wants entry
    // to that variant so the user's intent ("this exact printing")
    // round-trips. Matches the per-tile semantics of the wishlist
    // edit picker when the user pre-selects a variant chip.
    const variant = extractVariantLabel(card.name) as CanonicalVariant;
    wants.add({
      familyId: cardFamilyId(card),
      qty: 1,
      restriction: { mode: 'restricted', variants: [variant] },
    });
  };

  const handleAddToBinder = (card: CardVariant) => {
    // Catalog rows missing productId can't enter the binder — binder
    // entries are productId-keyed. The picker shouldn't surface such
    // rows in the first place (search results carry productId), but
    // guard so we don't crash on corrupted data.
    if (!card.productId) return;
    available.add({ productId: card.productId, qty: 1 });
  };

  return (
    <div className="h-[100dvh] overflow-hidden bg-space-900 text-gray-100 flex flex-col">
      <AppHeader
        auth={auth}
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Browse cards' },
        ]}
      />

      <main className="flex-1 min-h-0 flex flex-col max-w-5xl mx-auto w-full px-3 sm:px-6 pb-6 pt-3">
        <header className="flex items-baseline justify-between gap-3 pb-3 border-b border-space-800 mb-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-100">Browse cards</h1>
            <p className="text-[11px] text-gray-500 leading-relaxed mt-0.5">
              Search the catalogue and check prices. Tap any card to add it to your wishlist, binder, or a new trade.
            </p>
          </div>
        </header>

        <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-space-800 bg-space-900 overflow-hidden">
          <ListCardPicker
            selectionMode={{ kind: 'specific' }}
            allCards={allCards}
            priceMode={priceMode}
            savedEntries={[]}
            onPick={(card) => setActionCard(card)}
            onClose={() => { /* no-op — browser is the destination */ }}
            accent="gold"
            actionTarget="wishlist, binder, or trade"
            // Suppress the picker's default top bar (Back chevron + Done
            // pill). The browser is a top-level view, not a transient
            // overlay — AppHeader already owns navigation chrome.
            header={<></>}
          />
        </div>
      </main>

      <CardActionsDialog
        card={actionCard}
        onClose={() => setActionCard(null)}
        onAddToWishlist={handleAddToWishlist}
        onAddToBinder={handleAddToBinder}
        onStartTrade={onStartTradeWithCard}
      />
    </div>
  );
}
