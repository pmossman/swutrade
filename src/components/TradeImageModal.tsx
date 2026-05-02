import { useState, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

interface TradeImageModalProps {
  imageUrl: string;
  onClose: () => void;
}

/**
 * Hero-image preview for shared trade images. Migrated from a
 * hand-rolled `role="dialog"` shell to Radix's `Dialog.Root` to gain
 * focus-trap, focus-restore, scroll-lock, and ESC handling for free.
 * Audit 10-ux-primitives.md #3.
 *
 * Parent mounts/unmounts conditionally; the Dialog is always `open`
 * while mounted, and Radix's `onOpenChange` (via overlay click or
 * ESC) calls `onClose` to drive the unmount.
 */
export function TradeImageModal({ imageUrl, onClose }: TradeImageModalProps) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  const canShare =
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function';

  // Clipboard Image API is desktop-leaning; Safari and some contexts
  // won't support it. Feature-detect so the button doesn't render
  // where it'd just fail silently.
  const canCopyImage =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof window !== 'undefined' &&
    typeof (window as unknown as { ClipboardItem?: unknown }).ClipboardItem !== 'undefined';

  const handleShare = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (sharing) return;
    setSharing(true);
    try {
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], 'swu-trade.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'SWU Trade' });
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        console.warn('Share image failed:', err);
      }
    } finally {
      setSharing(false);
    }
  }, [imageUrl, sharing]);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (copying) return;
    setCopying(true);
    try {
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('Copy image failed:', err);
    } finally {
      setCopying(false);
    }
  }, [imageUrl, copying]);

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[60] modal-vignette animate-fade-in"
          onClick={onClose}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center p-4 pointer-events-none"
        >
        <Dialog.Title className="sr-only">Trade image</Dialog.Title>
        <Dialog.Close asChild>
          <button
            type="button"
            className="absolute top-3 right-3 text-gray-400 hover:text-gray-200 transition-colors p-2 z-10 pointer-events-auto"
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </Dialog.Close>

        <div className="relative max-w-5xl w-full flex flex-col items-center gap-4 pointer-events-auto" onClick={e => e.stopPropagation()}>
        {/* Image — gold-framed hero */}
        <div className="relative w-full">
          {!loaded && !errored && (
            <div className="aspect-[1200/630] flex items-center justify-center">
              <svg className="w-10 h-10 animate-spin text-gold" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          )}
          {errored && (
            <div className="aspect-[1200/630] flex items-center justify-center text-red-400 text-sm">
              Failed to load image.
            </div>
          )}
          <img
            src={imageUrl}
            alt="SWU Trade"
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
            className={`w-full h-auto rounded-lg shadow-frame-gold ${loaded ? '' : 'hidden'}`}
          />
        </div>

        {/* Toolbar — pill-style buttons matching the rest of the app,
            plus a touch-only long-press hint. */}
        {loaded && (
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <a
              href={imageUrl}
              download="swu-trade.png"
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gold/20 text-gold hover:bg-gold/30 border border-gold/30 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" />
              </svg>
              Download
            </a>
            {canCopyImage && (
              <button
                onClick={handleCopy}
                disabled={copying}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${
                  copied
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-space-700 text-gray-200 hover:bg-space-600 border-space-600'
                }`}
              >
                {copying ? (
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : copied ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
                {copied ? 'Copied!' : 'Copy'}
              </button>
            )}
            {canShare && (
              <button
                onClick={handleShare}
                disabled={sharing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-space-700 text-gray-200 hover:bg-space-600 border border-space-600 transition-colors disabled:opacity-50"
              >
                {sharing ? (
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4m0 0L8 6m4-4v13" />
                  </svg>
                )}
                Share
              </button>
            )}
            <span className="touch-only text-[11px] text-gray-500 ml-1">
              or long-press the image
            </span>
          </div>
        )}
      </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
