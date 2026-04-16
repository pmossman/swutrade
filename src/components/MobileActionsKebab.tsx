import { useState, useCallback } from 'react';
import { KebabMenu } from './KebabMenu';
import type { KebabMenuItem } from './KebabMenu';
import { TradeImageModal } from './TradeImageModal';
import { useAuthContext } from '../contexts/AuthContext';

interface MobileActionsKebabProps {
  /** Clear-all callback. Omit in contexts where the destructive
   *  action doesn't belong (e.g. the Trade Summary modal). */
  onClear?: () => void;
}

/**
 * Mobile-only overflow menu for top-bar actions. Consolidates Link /
 * Image / Clear All into a single ⋮ so the header doesn't wrap into
 * three rows on a narrow viewport. Desktop still shows the pills.
 */
export function MobileActionsKebab({ onClear }: MobileActionsKebabProps) {
  const { user } = useAuthContext();
  const [showImage, setShowImage] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const handleCopyLink = useCallback(async () => {
    // Stamp outgoing share URLs with the sender's handle when signed
    // in. Mirrors ShareButtons so mobile and desktop share the same
    // Phase-3b recipient experience.
    const url = new URL(window.location.href);
    if (user) url.searchParams.set('from', user.handle);
    else url.searchParams.delete('from');
    const href = url.toString();
    try {
      await navigator.clipboard.writeText(href);
    } catch {
      // Fall back to execCommand if needed; silent if both fail
      const input = document.createElement('input');
      input.value = href;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [user]);

  const handleClear = useCallback(() => {
    if (!onClear) return;
    // Destructive; confirm so an accidental tap in the menu doesn't
    // wipe a trade in progress.
    if (window.confirm('Clear all cards from both sides?')) {
      onClear();
    }
  }, [onClear]);

  const imageUrl = `/api/og${typeof window !== 'undefined' ? (window.location.search || '?y=&t=') : ''}`;

  const items: KebabMenuItem[] = [
    {
      label: linkCopied ? 'Link copied!' : 'Copy link',
      onClick: handleCopyLink,
      // Keep the menu open briefly so the label flips to "Link
      // copied!" visibly before the menu dismisses.
      holdBeforeCloseMs: 700,
      icon: linkCopied ? (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      ),
    },
    {
      label: 'Trade image',
      onClick: () => setShowImage(true),
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
  ];
  if (onClear) {
    items.push({
      label: 'Clear all',
      onClick: handleClear,
      icon: (
        <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      ),
    });
  }

  return (
    <>
      <KebabMenu items={items} size="md" ariaLabel="Trade actions" />
      {showImage && (
        <TradeImageModal imageUrl={imageUrl} onClose={() => setShowImage(false)} />
      )}
    </>
  );
}
