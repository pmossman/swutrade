import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { QRCodeSVG } from 'qrcode.react';
import type { CardVariant, PriceMode } from '../types';
import type { WantsApi } from '../hooks/useWants';
import type { AvailableApi } from '../hooks/useAvailable';
import { cardFamilyId } from '../variants';
import { encodeWants, encodeAvailable } from '../urlCodec';
import { TradeImageModal } from './TradeImageModal';
import { useAuthContext } from '../contexts/AuthContext';
import { useDrawerContext } from '../contexts/DrawerContext';
import { preventAutoFocus } from '../utils/dialogFocus';
import { WantsPanel } from './lists/WantsPanel';
import { AvailablePanel } from './lists/AvailablePanel';

interface ListsDrawerProps {
  wants: WantsApi;
  available: AvailableApi;
  allCards: CardVariant[];
  percentage: number;
  priceMode: PriceMode;
  /** Controlled `open` state. The drawer no longer renders its own
   *  trigger button — it's opened from the AccountMenu menu item so
   *  the top bar stays uncluttered. Parent (App.tsx) owns the boolean. */
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

type ListTab = 'wants' | 'available';

/**
 * Mobile: bottom sheet sliding up from viewport bottom.
 * Desktop: centered modal.
 */
export function ListsDrawer({
  wants,
  available,
  allCards,
  percentage,
  priceMode,
  open,
  onOpenChange,
}: ListsDrawerProps) {
  const [tab, setTab] = useState<ListTab>('wants');

  // Callers can nominate a tab to open on via DrawerContext's
  // `openLists('wants'|'available')` — Home's split Wishlist / Binder
  // modules do this so tapping "Edit wishlist" lands on the wants tab
  // and "Edit binder" lands on the available tab. Consumed + cleared
  // here so the hint doesn't stick across opens.
  const { requestedTab, clearRequestedTab } = useDrawerContext();
  useEffect(() => {
    if (open && requestedTab) {
      setTab(requestedTab);
      clearRequestedTab();
    }
  }, [open, requestedTab, clearRequestedTab]);

  const wantsCount = wants.items.length;
  const availableCount = available.items.length;
  const totalCount = wantsCount + availableCount;

  // Card indexes — passed into both panels so they don't recompute on
  // every switch. For wants, the row's thumbnail should reflect the
  // restriction (byFamilyAll powers bestMatchForWant); for available,
  // byProductId resolves the exact variant the user picked.
  const { byFamily, byFamilyAll, byProductId } = useMemo(() => {
    const byFamily = new Map<string, CardVariant>();
    const byFamilyAll = new Map<string, CardVariant[]>();
    const byProductId = new Map<string, CardVariant>();
    for (const card of allCards) {
      if (card.productId) byProductId.set(card.productId, card);
      const fid = cardFamilyId(card);
      const existing = byFamily.get(fid);
      if (!existing || card.variant === 'Standard') byFamily.set(fid, card);
      const bucket = byFamilyAll.get(fid);
      if (bucket) bucket.push(card);
      else byFamilyAll.set(fid, [card]);
    }
    return { byFamily, byFamilyAll, byProductId };
  }, [allCards]);

  const handleTabChange = (next: ListTab) => setTab(next);
  const handleOpenChange = (next: boolean) => onOpenChange(next);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={preventAutoFocus}
          className={[
            'drawer-content z-50 bg-space-900 border border-space-700 text-gray-100 shadow-2xl',
            'flex flex-col',
            // Mobile: bottom sheet. The picker-mode size tweak that
            // used to live here is now owned by each panel — they
            // render the picker at natural size and the drawer's own
            // max-h still governs the viewport envelope. Works in
            // practice because the picker's internal scroll region
            // absorbs overflow.
            'max-h-[85dvh] rounded-t-2xl border-b-0',
            // Desktop: fixed modal size.
            'md:w-[min(720px,calc(100vw-2rem))] md:max-h-[85dvh] md:h-auto md:rounded-2xl md:border',
          ].join(' ')}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-space-800">
            <Dialog.Title className="text-sm font-bold tracking-[0.1em] uppercase text-gold">
              My Lists
            </Dialog.Title>
            <div className="flex items-center gap-3">
              {totalCount > 0 && (
                <ShareListsButton
                  wantsItems={wants.items}
                  availableItems={available.items}
                />
              )}
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="hit-area-44 text-gray-500 hover:text-gray-200 transition-colors"
                >
                  <CloseIcon className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>
          </div>

          {/* Wants/Available data is localStorage-backed via useWants /
              useAvailable, so the tabs work identically for ghosts and
              real users. The drawer used to gate-wall ghosts with a
              GhostSignInPanel here while the dedicated WishlistView /
              BinderView rendered the lists directly — inconsistent and
              confusing. Removed the gate; the sign-in pitch lives in
              the always-visible AccountMenu. */}
          <Tabs.Root
            value={tab}
            onValueChange={v => handleTabChange(v as ListTab)}
            className="flex flex-col flex-1 min-h-0"
          >
            <Tabs.List
              className="flex gap-1 px-3 pt-2 border-b border-space-800"
              aria-label="Wishlist and Trade binder lists"
            >
              {/* Color reservation mirrors the trade panels: Wants lines
                  up with Receiving (blue) — cards the user wants to take
                  in — and Available lines up with Offering (emerald) —
                  cards the user has to give. */}
              <TabTrigger value="wants" count={wantsCount} accent="blue">Wishlist</TabTrigger>
              <TabTrigger value="available" count={availableCount} accent="emerald">Trade binder</TabTrigger>
            </Tabs.List>

            <Tabs.Content value="wants" className="flex-1 min-h-0 data-[state=inactive]:hidden flex flex-col">
              <WantsPanel
                wants={wants}
                allCards={allCards}
                percentage={percentage}
                priceMode={priceMode}
                byFamily={byFamily}
                byFamilyAll={byFamilyAll}
              />
            </Tabs.Content>

            <Tabs.Content value="available" className="flex-1 min-h-0 data-[state=inactive]:hidden flex flex-col">
              <AvailablePanel
                available={available}
                allCards={allCards}
                percentage={percentage}
                priceMode={priceMode}
                byProductId={byProductId}
              />
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const TAB_ACCENT: Record<'blue' | 'emerald', { text: string; underline: string; badge: string }> = {
  blue: {
    text: 'data-[state=active]:text-blue-300',
    underline: 'data-[state=active]:after:bg-blue-400',
    badge: 'group-data-[state=active]:bg-blue-500/20 group-data-[state=active]:text-blue-200',
  },
  emerald: {
    text: 'data-[state=active]:text-emerald-300',
    underline: 'data-[state=active]:after:bg-emerald-400',
    badge: 'group-data-[state=active]:bg-emerald-500/20 group-data-[state=active]:text-emerald-200',
  },
};

function TabTrigger({
  value,
  count,
  accent,
  children,
}: {
  value: ListTab;
  count: number;
  accent: 'blue' | 'emerald';
  children: React.ReactNode;
}) {
  const a = TAB_ACCENT[accent];
  return (
    <Tabs.Trigger
      value={value}
      className={[
        'group relative flex items-center gap-1.5 px-3 py-2 text-xs font-bold tracking-[0.08em] uppercase rounded-t-md',
        'text-gray-500 hover:text-gray-300 transition-colors',
        a.text,
        'after:content-[""] after:absolute after:bottom-0 after:inset-x-2 after:h-px after:bg-transparent',
        a.underline,
      ].join(' ')}
    >
      {children}
      {count > 0 && (
        <span className={`px-1.5 py-px rounded-full bg-space-700 text-gray-300 text-[10px] font-bold leading-none transition-colors ${a.badge}`}>
          {count}
        </span>
      )}
    </Tabs.Trigger>
  );
}

function ShareListsButton({
  wantsItems,
  availableItems,
}: {
  wantsItems: WantsApi['items'];
  availableItems: AvailableApi['items'];
}) {
  const { user } = useAuthContext();
  const [linkCopied, setLinkCopied] = useState(false);
  const [showImage, setShowImage] = useState(false);

  // Build the share URL from current location, overlaying ?w=/?a=
  // with the user's lists. Used for both Link copy and Image render.
  const shareUrl = useCallback((): URL => {
    const url = new URL(window.location.href);
    if (wantsItems.length > 0) url.searchParams.set('w', encodeWants(wantsItems));
    else url.searchParams.delete('w');
    if (availableItems.length > 0) url.searchParams.set('a', encodeAvailable(availableItems));
    else url.searchParams.delete('a');
    // List shares default to list-view landing — clear any lingering
    // ?view=trade so the recipient lands on the dedicated /list view.
    url.searchParams.delete('view');
    // Identify the sender when the user is signed in. Recipients see
    // "from @handle" on the shared-list landing and, when signed in
    // themselves, get the matchmaker pre-filled with this handle.
    if (user) url.searchParams.set('from', user.handle);
    else url.searchParams.delete('from');
    return url;
  }, [wantsItems, availableItems, user]);

  const copyLink = useCallback(async () => {
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
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [shareUrl]);

  const imageUrl = useCallback(() => {
    const url = shareUrl();
    const params = new URLSearchParams();
    const w = url.searchParams.get('w');
    const a = url.searchParams.get('a');
    if (w) params.set('w', w);
    if (a) params.set('a', a);
    const pct = url.searchParams.get('pct');
    const pm = url.searchParams.get('pm');
    if (pct) params.set('pct', pct);
    if (pm) params.set('pm', pm);
    return `/api/og?${params.toString()}`;
  }, [shareUrl]);

  const urlString = shareUrl().toString();
  const nativeShareAvailable = typeof navigator !== 'undefined'
    && typeof navigator.share === 'function';

  const nativeShare = useCallback(async () => {
    try {
      await navigator.share({
        title: 'SWU Trade — Shared list',
        url: urlString,
      });
    } catch {
      // User cancelled or API unavailable — no-op.
    }
  }, [urlString]);

  return (
    <>
      {/* Radix Dialog instead of an anchored popover: the popover
          variant got its QR clipped against the viewport bottom on
          mobile when the parent drawer was already near full height.
          A centered modal has its own viewport scroll envelope and
          fits the QR at a comfortably scannable size. */}
      <Dialog.Root>
        <Dialog.Trigger asChild>
          <button
            type="button"
            aria-label="Share lists"
            className="flex items-center gap-1 px-2 h-7 rounded text-[10px] font-bold uppercase tracking-wide bg-gold/10 text-gold hover:bg-gold/20 transition-colors"
          >
            <ShareIcon className="w-3 h-3" />
            Share
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content
            aria-describedby={undefined}
            onOpenAutoFocus={preventAutoFocus}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(320px,calc(100vw-2rem))] max-h-[90dvh] overflow-y-auto bg-space-900 border border-space-700 rounded-2xl shadow-2xl p-4"
          >
            <div className="flex items-center justify-between gap-3 pb-3 border-b border-space-800 mb-3">
              <Dialog.Title className="text-sm font-bold tracking-[0.1em] uppercase text-gold">
                Share list
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="hit-area-44 text-gray-500 hover:text-gray-200 transition-colors"
                >
                  <CloseIcon className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="flex flex-col gap-2">
              <SharePopoverButton
                onClick={() => { copyLink(); }}
                icon={linkCopied ? <CheckIcon className="w-3.5 h-3.5" /> : <LinkIcon className="w-3.5 h-3.5" />}
                label={linkCopied ? 'Copied!' : 'Copy link'}
              />
              {nativeShareAvailable && (
                <Dialog.Close asChild>
                  <SharePopoverButton
                    onClick={nativeShare}
                    icon={<ShareIcon className="w-3.5 h-3.5" />}
                    label="Share via…"
                  />
                </Dialog.Close>
              )}
              <Dialog.Close asChild>
                <SharePopoverButton
                  onClick={() => setShowImage(true)}
                  icon={<ImageIcon className="w-3.5 h-3.5" />}
                  label="Save as image"
                />
              </Dialog.Close>

              {/* In-person QR — recipient scans with any stock camera app.
                  The centered-modal layout guarantees the code is never
                  clipped, so we can render at a comfortable scannable
                  size without having to worry about where the trigger
                  lives on screen. */}
              <div className="flex flex-col items-center gap-1.5 pt-3 mt-1 border-t border-space-700">
                <div className="text-[9px] tracking-widest uppercase text-gray-500 font-bold">
                  Scan to open
                </div>
                <div className="bg-white p-2 rounded">
                  <QRCodeSVG
                    value={urlString}
                    size={200}
                    level="M"
                    marginSize={0}
                  />
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {showImage && (
        <TradeImageModal imageUrl={imageUrl()} onClose={() => setShowImage(false)} />
      )}
    </>
  );
}

function SharePopoverButton({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-semibold text-gray-200 hover:text-gold hover:bg-gold/10 transition-colors"
    >
      <span className="text-gray-400">{icon}</span>
      {label}
    </button>
  );
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="4" cy="8" r="1.5" />
      <circle cx="12" cy="4" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M5.3 7.2l5.4-2.4M5.3 8.8l5.4 2.4" />
    </svg>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6.5 8.5l3-3M5 7l-1.5 1.5a2.5 2.5 0 003.5 3.5L8.5 10.5M11 9l1.5-1.5a2.5 2.5 0 00-3.5-3.5L7.5 5.5" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="7" r="1" />
      <path d="M2 11l3-3 4 4 2-2 3 3" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 4L12 12M4 12L12 4" />
    </svg>
  );
}
