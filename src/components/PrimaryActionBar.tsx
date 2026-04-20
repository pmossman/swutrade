import { usePrimaryActionContext } from '../contexts/PrimaryActionContext';

/**
 * Bottom-pinned primary action for the trade builder. Reads from
 * `PrimaryActionContext` — the currently-active composer bar
 * (Propose / Counter / Edit / AutoBalance) registers its action
 * shape; this component renders it.
 *
 * Visual pattern: full-width gold button, thumb-reachable on mobile,
 * sits below the balance strip. Mirrors the pattern we shipped for
 * live trade sessions in `SessionView` (identity → balance →
 * panels → action bar), so the trade-builder and shared-session
 * flows share one consistent "what do I tap next" affordance.
 *
 * Returns null when no action is registered (solo mode without a
 * propose/counter/edit intent, or transient mount states).
 */
export function PrimaryActionBar() {
  const { action } = usePrimaryActionContext();
  if (!action) return null;

  const {
    label,
    onClick,
    disabled = false,
    loading = false,
    loadingLabel,
    sent = false,
    hint,
    error,
    testId,
  } = action;

  const effectiveDisabled = disabled || loading || sent;

  // Success-state button reads as "this already happened" — emerald,
  // checkmark, not interactive. Triggered by e.g. EditBar's "Saved"
  // sticky state. Propose uses this briefly between submit and the
  // confirm modal closing.
  if (sent) {
    return (
      <div className="shrink-0 px-3 pt-2 pb-3 max-w-5xl mx-auto w-full">
        <div
          className="w-full h-12 rounded-lg flex items-center justify-center gap-2 bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 font-bold text-sm"
          data-testid={testId}
          aria-live="polite"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 8l3 3 6-6" />
          </svg>
          {label}
        </div>
        {hint && (
          <div className="mt-1 text-[11px] text-gray-500 text-center leading-relaxed">
            {hint}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="shrink-0 px-3 pt-2 pb-3 max-w-5xl mx-auto w-full">
      <button
        type="button"
        onClick={onClick}
        disabled={effectiveDisabled}
        data-testid={testId}
        className={
          effectiveDisabled
            ? 'w-full h-12 rounded-lg bg-space-800 border border-space-700 text-gray-500 font-bold text-sm cursor-not-allowed'
            : 'w-full h-12 rounded-lg bg-gold text-space-900 font-bold text-sm hover:bg-gold-bright transition-colors'
        }
      >
        {loading ? (loadingLabel ?? `${label}…`) : label}
      </button>
      {error && (
        <div className="mt-1.5 text-[11px] text-red-300 text-center leading-relaxed px-1">
          {error}
        </div>
      )}
      {!error && hint && (
        <div className="mt-1 text-[11px] text-gray-500 text-center leading-relaxed px-1">
          {hint}
        </div>
      )}
    </div>
  );
}
