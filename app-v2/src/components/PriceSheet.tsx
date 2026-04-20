import { Sheet } from './primitives/Sheet';
import { Segmented } from './primitives/Segmented';
import { usePricingStore, type PriceMode } from '../lib/stores/pricing';
import type { TradeCardSnapshot } from '../lib/trade';

interface PriceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  yourCards: ReadonlyArray<TradeCardSnapshot>;
  theirCards: ReadonlyArray<TradeCardSnapshot>;
  yourTotal: number;
  theirTotal: number;
}

const PRESETS = [50, 60, 70, 80, 90, 100] as const;

/*
 * Design §4.3.1 pricing surface. Balance-strip tap opens this sheet;
 * user adjusts the percentage preset + market/low mode; per-card
 * breakdown displays under each side's total.
 *
 * Phase-1d scope: pct affects the displayed totals in this sheet
 * only (the canvas/balance strip still show raw snapshot prices).
 * Phase 2 wires the pct into the canvas totals + the API payload
 * when pitching a proposal. Mode toggle persists but currently only
 * affects new-card snapshots when the picker reads product-index
 * (design §4.3.1 note: "affects new-card prices only" until v1's
 * URL-codec override semantics land in 2a).
 */
export function PriceSheet({
  open,
  onOpenChange,
  yourCards,
  theirCards,
  yourTotal,
  theirTotal,
}: PriceSheetProps) {
  const pct = usePricingStore((s) => s.pct);
  const setPct = usePricingStore((s) => s.setPct);
  const mode = usePricingStore((s) => s.mode);
  const setMode = usePricingStore((s) => s.setMode);

  const adjust = (v: number) => Math.round(v * pct) / 100;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Pricing" snap="full">
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <span className="text-[length:var(--text-meta)] font-semibold uppercase tracking-wide text-fg-muted">
            Price source
          </span>
          <Segmented<PriceMode>
            ariaLabel="Price source"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'market', label: 'Market' },
              { value: 'low', label: 'Low' },
            ]}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[length:var(--text-meta)] font-semibold uppercase tracking-wide text-fg-muted">
            Take at
          </span>
          <div className="grid grid-cols-6 gap-1.5">
            {PRESETS.map((p) => {
              const active = p === pct;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPct(p)}
                  aria-pressed={active}
                  className={[
                    'h-11 rounded-xl border text-[length:var(--text-meta)] font-semibold tabular-nums transition-colors',
                    active
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-border bg-surface text-fg-muted hover:text-fg',
                  ].join(' ')}
                >
                  {p}%
                </button>
              );
            })}
          </div>
          <p className="text-[length:var(--text-caption)] text-fg-muted">
            Applied to both sides of the trade when totaling.
          </p>
        </div>

        <SideBreakdown label="You offer" cards={yourCards} total={adjust(yourTotal)} pct={pct} />
        <SideBreakdown label="They offer" cards={theirCards} total={adjust(theirTotal)} pct={pct} />
      </div>
    </Sheet>
  );
}

interface SideBreakdownProps {
  label: string;
  cards: ReadonlyArray<TradeCardSnapshot>;
  total: number;
  pct: number;
}

function SideBreakdown({ label, cards, total, pct }: SideBreakdownProps) {
  if (cards.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface px-3 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[length:var(--text-body)] font-semibold">{label}</span>
          <span className="tabular-nums text-fg-muted">$0.00</span>
        </div>
        <p className="mt-1 text-[length:var(--text-meta)] text-fg-muted">No cards yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <span className="text-[length:var(--text-body)] font-semibold">{label}</span>
        <span className="tabular-nums font-semibold">${total.toFixed(2)}</span>
      </div>
      <ul className="divide-y divide-border">
        {cards.map((c) => (
          <li
            key={`${c.productId}-${c.variant}`}
            className="flex items-center gap-3 px-3 py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[length:var(--text-meta)] font-semibold">
                {c.name}
              </span>
              <span className="block truncate text-[length:var(--text-caption)] text-fg-muted">
                {c.variant} · {c.qty} ×{' '}
                {c.unitPrice != null
                  ? `$${(Math.round(c.unitPrice * pct) / 100).toFixed(2)}`
                  : '—'}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-[length:var(--text-meta)]">
              {c.unitPrice != null ? (
                `$${(Math.round(c.unitPrice * c.qty * pct) / 100).toFixed(2)}`
              ) : (
                <span className="text-danger">no price</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
