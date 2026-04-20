import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sheet } from './primitives/Sheet';
import { fetchSet, type SetCard } from '../lib/cards';

interface CardPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Per-tile tap callback. Receives the specific SetCard the user
   * picked (productId, variant, etc.) — the parent route decides
   * whether to add to binder (productId-keyed) or wishlist
   * (familyId-keyed, derived from set + name).
   */
  onPick: (card: SetCard) => void;
  title?: string;
}

/*
 * Phase 1c picker — a single-set search surface. We load Jump to
 * Lightspeed's JSON as the search pool; the full multi-set catalog
 * loader lands later with proper chip-scoped filtering. The user
 * types a substring, tiles render with leader/base/unit types
 * visible, tapping a tile calls onPick.
 *
 * Design §4.4 — bottom sheet, full-height on mobile.
 */

const DEFAULT_SET = 'jump-to-lightspeed';

export function CardPicker({ open, onOpenChange, onPick, title = 'Add card' }: CardPickerProps) {
  const [query, setQuery] = useState('');

  const setQ = useQuery({
    queryKey: ['cards', 'set', DEFAULT_SET],
    queryFn: () => fetchSet(DEFAULT_SET),
    staleTime: Infinity,
    enabled: open,
  });

  const results = useMemo(() => {
    const cards = setQ.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return cards.slice(0, 40);
    return cards.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 80);
  }, [setQ.data, query]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} snap="full">
      <div className="flex flex-col gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search cards"
          autoFocus
          className="h-11 rounded-xl border border-border bg-bg px-4 text-[length:var(--text-body)] text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          aria-label="Search cards"
        />

        {setQ.status === 'pending' ? (
          <p className="px-1 text-[length:var(--text-meta)] text-fg-muted">Loading cards…</p>
        ) : null}
        {setQ.status === 'error' ? (
          <p className="px-1 text-[length:var(--text-meta)] text-danger">
            Couldn't load the card catalog. Refresh and try again.
          </p>
        ) : null}

        {results.length === 0 && setQ.status === 'success' ? (
          <p className="px-1 text-[length:var(--text-meta)] text-fg-muted">
            No matches for "{query}".
          </p>
        ) : null}

        <ul className="flex flex-col gap-1">
          {results.map((card) => (
            <li key={card.productId}>
              <button
                type="button"
                onClick={() => onPick(card)}
                className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-accent/50 active:bg-border/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[length:var(--text-body)] font-semibold">
                    {card.name}
                  </span>
                  <span className="block truncate text-[length:var(--text-meta)] text-fg-muted">
                    {card.setName} · {card.variant}
                  </span>
                </span>
                {card.marketPrice != null ? (
                  <span className="tabular-nums text-[length:var(--text-meta)] text-fg-muted">
                    ${card.marketPrice.toFixed(2)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
