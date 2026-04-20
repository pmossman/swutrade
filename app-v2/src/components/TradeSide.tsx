import { Stepper } from './primitives/Stepper';
import type { TradeCardSnapshot } from '../lib/trade';

interface TradeSideProps {
  side: 'yours' | 'theirs';
  cards: ReadonlyArray<TradeCardSnapshot>;
  total: number;
  /** When editable, the Stepper + Add button render. Counterpart side
   *  is always read-only in the viewer's canvas. Terminal sessions
   *  flip both sides to read-only. */
  editable: boolean;
  onChangeQty?: (productId: string, qty: number) => void;
  onAdd?: () => void;
  emptyLabel?: string;
}

/*
 * One panel of the trade canvas — "You offer" or "They offer". The
 * side-identity tint (emerald/blue) lives only behind the label per
 * design §6.1 ("muted tint behind labels"); the panel body stays on
 * surface so it doesn't fight the balance strip or state badges.
 */
export function TradeSide({
  side,
  cards,
  total,
  editable,
  onChangeQty,
  onAdd,
  emptyLabel,
}: TradeSideProps) {
  const tintClass = side === 'yours' ? 'bg-side-yours' : 'bg-side-theirs';

  return (
    <section
      aria-label={side === 'yours' ? 'Your offer' : 'Their offer'}
      className="flex flex-col gap-2"
    >
      <header className="flex items-center justify-between">
        <span
          className={[
            'inline-flex items-center rounded-full px-2.5 py-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wider text-fg',
            tintClass,
          ].join(' ')}
        >
          {side === 'yours' ? 'You offer' : 'They offer'}
        </span>
        <span className="text-[length:var(--text-meta)] tabular-nums text-fg-muted">
          ${total.toFixed(2)}
        </span>
      </header>

      {cards.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-6 text-center text-[length:var(--text-meta)] text-fg-muted">
          {emptyLabel ?? (side === 'yours' ? 'No cards yet' : 'Waiting on your partner')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {cards.map((card) => (
            <li
              key={`${card.productId}-${card.variant}`}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[length:var(--text-body)] font-semibold">
                  {card.name}
                </span>
                <span className="block truncate text-[length:var(--text-meta)] text-fg-muted">
                  {card.variant}
                  {card.unitPrice != null
                    ? ` · $${card.unitPrice.toFixed(2)} ea`
                    : ' · no price'}
                </span>
              </span>
              {editable && onChangeQty ? (
                <Stepper
                  value={card.qty}
                  min={0}
                  onChange={(q) => onChangeQty(card.productId, q)}
                  ariaLabel={`Quantity of ${card.name}`}
                />
              ) : (
                <span className="text-[length:var(--text-body)] font-semibold tabular-nums">
                  × {card.qty}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && onAdd ? (
        <button
          type="button"
          onClick={onAdd}
          className="flex min-h-11 items-center justify-center rounded-xl border border-dashed border-border bg-surface px-4 py-2 text-[length:var(--text-body)] font-semibold text-fg-muted hover:border-accent/60 hover:text-fg"
        >
          + Add card
        </button>
      ) : null}
    </section>
  );
}
