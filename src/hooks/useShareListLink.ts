import { useCallback, useState } from 'react';
import type { WantsApi } from './useWants';
import type { AvailableApi } from './useAvailable';
import { encodeWants, encodeAvailable } from '../urlCodec';
import { useAuthContext } from '../contexts/AuthContext';

/**
 * Shared share-link logic for the viewer's wishlist or trade binder.
 * Originally duplicated between WishlistView's `ShareWishlistButton`
 * and BinderView's `ShareBinderButton`; lifted into a hook so the
 * home-page WishlistModule + BinderModule can grow their own compact
 * share affordances without re-implementing URL construction,
 * clipboard fallback, or the 2s "Copied" timer.
 *
 * Returns a stable callback + ephemeral feedback state. The URL is
 * built from `window.location.href` so any active page-level params
 * (e.g. `pct=80`, `pm=l`) ride along — the recipient sees the
 * sender's price-mode + percentage intent, not their own persisted
 * defaults.
 */
export interface ShareListLinkApi {
  /** Compute the absolute share URL for the requested list. Pure
   *  read — does not mutate. */
  shareUrl: () => URL;
  /** Copy `shareUrl().toString()` to the clipboard. Falls back to a
   *  hidden-input + execCommand path for browsers without the async
   *  clipboard API (Safari private mode, insecure contexts). Sets
   *  `copied` true for 2s on success. */
  handleCopy: () => Promise<void>;
  /** Transient flag — flips to true the moment a copy succeeds,
   *  auto-clears 2s later. Drives the button's "Copied ✓" label. */
  copied: boolean;
}

export type ShareListKind = 'wants' | 'available';

export function useShareListLink(
  kind: ShareListKind,
  items: WantsApi['items'] | AvailableApi['items'],
): ShareListLinkApi {
  const { user } = useAuthContext();
  const [copied, setCopied] = useState(false);

  const shareUrl = useCallback((): URL => {
    const url = new URL(window.location.href);
    if (kind === 'wants') {
      const wants = items as WantsApi['items'];
      if (wants.length > 0) url.searchParams.set('w', encodeWants(wants));
      else url.searchParams.delete('w');
      url.searchParams.delete('a');
    } else {
      const available = items as AvailableApi['items'];
      if (available.length > 0) url.searchParams.set('a', encodeAvailable(available));
      else url.searchParams.delete('a');
      url.searchParams.delete('w');
    }
    // Recipient lands on the list view (the home-page heuristic
    // picks `view=list` for `?w=`/`?a=` URLs without an explicit
    // `view=`). Strip `view=` so it doesn't carry over from a
    // dedicated wishlist/binder edit context.
    url.searchParams.delete('view');
    if (user) url.searchParams.set('from', user.handle);
    else url.searchParams.delete('from');
    return url;
  }, [kind, items, user]);

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

  return { shareUrl, handleCopy, copied };
}
