import { useEffect, useState } from 'react';

/**
 * Reactive CSS media-query hook. Returns true when the query currently
 * matches and updates when the viewport crosses the breakpoint.
 *
 * SSR-safe: defaults to `false` on the server (no window).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    // In case the state is stale relative to the media state
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export function useIsMobile() {
  return useMediaQuery('(max-width: 767px)');
}
