import { useState, useCallback } from 'react';
import { TradeImageModal } from './TradeImageModal';
import { useAuthContext } from '../contexts/AuthContext';

interface ShareButtonsProps {
  size?: 'sm' | 'md';
  /** Optional onClick handler called when the user is interacting (e.g. to prevent overlay open) */
  onInteract?: (e: React.MouseEvent) => void;
}

export function ShareButtons({ size = 'md', onInteract }: ShareButtonsProps) {
  const { user } = useAuthContext();
  const [linkCopied, setLinkCopied] = useState(false);
  const [showImageModal, setShowImageModal] = useState(false);

  // Rebuild the share URL from current location so we can stamp
  // ?from=<handle> on outgoing links when the user is signed in.
  // Falls back to the raw href when not signed in (keeps anonymous
  // share behavior unchanged).
  const buildShareHref = useCallback((): string => {
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    if (user) url.searchParams.set('from', user.handle);
    else url.searchParams.delete('from');
    return url.toString();
  }, [user]);

  const handleCopyLink = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    onInteract?.(e);
    const href = buildShareHref();
    try {
      await navigator.clipboard.writeText(href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      const input = document.createElement('input');
      input.value = href;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  }, [onInteract, buildShareHref]);

  const handleOpenImage = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onInteract?.(e);
    setShowImageModal(true);
  }, [onInteract]);

  const sizeClasses = size === 'sm'
    ? 'px-2 py-1 text-[11px] gap-1'
    : 'px-2.5 py-1 text-xs gap-1';
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';

  const imageUrl = `/api/og${typeof window !== 'undefined' ? (window.location.search || '?y=&t=') : ''}`;

  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleCopyLink}
          className={`flex items-center rounded-lg font-semibold bg-space-700 text-gray-300 hover:bg-space-600 transition-colors ${sizeClasses}`}
        >
          {linkCopied ? (
            <svg className={`${iconSize} text-emerald-400`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className={iconSize} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          )}
          {linkCopied ? 'Copied!' : 'Link'}
        </button>
        <button
          onClick={handleOpenImage}
          className={`flex items-center rounded-lg font-semibold bg-gold/20 text-gold hover:bg-gold/30 transition-colors ${sizeClasses}`}
        >
          <svg className={iconSize} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Image
        </button>
      </div>
      {showImageModal && (
        <TradeImageModal imageUrl={imageUrl} onClose={() => setShowImageModal(false)} />
      )}
    </>
  );
}
