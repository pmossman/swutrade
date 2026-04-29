import { useEffect, useState } from 'react';

interface NumberStepperProps {
  /** Current value. `null` is valid only when `allowEmpty` is set
   *  (for optional fields like max-price). */
  value: number | null;
  onChange: (next: number | null) => void;
  min?: number;
  max?: number;
  /** Increment per ± click. Defaults to 1. */
  step?: number;
  /** When true, an empty input is treated as `null` and the field
   *  may render with no value. ± clicks still snap into range. */
  allowEmpty?: boolean;
  /** Allow decimal input. Defaults to integer-only. */
  decimal?: boolean;
  ariaLabel?: string;
  /** Tailwind width for the central input. Default `w-10`. */
  inputClassName?: string;
  /** Compact = ~20px square buttons; standard = ~24px (matches the
   *  ListRows display-only stepper). Defaults to `standard`. */
  size?: 'compact' | 'standard';
  /** Placeholder shown when value is null. Only meaningful with
   *  `allowEmpty`. Default `'—'`. */
  placeholder?: string;
}

/**
 * Themed +/− stepper with a typeable central input. Replaces the
 * scattered native `<input type="number">` controls (whose browser
 * spinner chrome clashed with the SWU palette) and the older inline
 * QtyStepper in ListRows. One component covers integer (qty) and
 * decimal (max-price) needs; pass `allowEmpty` for optional fields.
 *
 * Behaviour:
 *  - Buttons clamp to [min, max]; can't push past either boundary.
 *  - Typing accepts only digits (and a `.` when `decimal` is on);
 *    invalid characters are dropped silently.
 *  - On blur, the typed value gets clamped + committed (or set to
 *    null if blank + allowEmpty).
 *  - Arrow Up/Down keys mirror the buttons, so keyboard users get the
 *    same affordance.
 */
export function NumberStepper({
  value,
  onChange,
  min = 0,
  max = 9999,
  step = 1,
  allowEmpty = false,
  decimal = false,
  ariaLabel,
  inputClassName,
  size = 'standard',
  placeholder = '—',
}: NumberStepperProps) {
  // Local draft so the user can transiently type "1." or "" without
  // the parent's clamping erasing in-flight characters. Sync down
  // whenever the parent value changes (from a button click, an API
  // refresh, etc.).
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value));
  useEffect(() => {
    setDraft(value == null ? '' : String(value));
  }, [value]);

  const btnSize = size === 'compact' ? 'w-5 h-5 text-xs' : 'w-6 h-6 text-sm';
  const inputCls = inputClassName ?? (size === 'compact' ? 'w-8' : 'w-10');

  function bump(delta: number) {
    const base = value ?? 0;
    const next = clamp(roundTo(base + delta * step, decimal ? 2 : 0), min, max);
    onChange(next);
  }

  function commit(raw: string) {
    if (raw === '' && allowEmpty) {
      onChange(null);
      return;
    }
    const n = decimal ? parseFloat(raw) : parseInt(raw, 10);
    if (Number.isNaN(n)) {
      // Reject — snap back to the last valid parent value.
      setDraft(value == null ? '' : String(value));
      return;
    }
    onChange(clamp(n, min, max));
  }

  function handleType(input: string) {
    // Filter on the way in so the field never *displays* an invalid
    // character. Decimal mode allows one `.`, integer mode strips it
    // entirely.
    const allowed = decimal ? /[^0-9.]/g : /\D/g;
    let cleaned = input.replace(allowed, '');
    if (decimal) {
      // Collapse multiple `.` to a single one (keep the first).
      const firstDot = cleaned.indexOf('.');
      if (firstDot >= 0) {
        cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
      }
    }
    setDraft(cleaned);
  }

  return (
    <div className="inline-flex items-center gap-1 shrink-0">
      <button
        type="button"
        aria-label={`Decrease${ariaLabel ? ` ${ariaLabel.toLowerCase()}` : ''}`}
        onClick={() => bump(-1)}
        disabled={value != null && value <= min}
        className={`${btnSize} rounded bg-space-800 border border-space-700 text-gray-400 hover:text-gold hover:border-gold/40 disabled:opacity-40 disabled:hover:text-gray-400 disabled:hover:border-space-700 transition-colors flex items-center justify-center font-bold`}
      >
        −
      </button>
      <input
        type="text"
        inputMode={decimal ? 'decimal' : 'numeric'}
        pattern={decimal ? '[0-9]*\\.?[0-9]*' : '[0-9]*'}
        value={draft}
        onChange={e => handleType(e.target.value)}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            bump(1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            bump(-1);
          }
        }}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={`${inputCls} text-center bg-space-900/70 border border-space-700 rounded ${size === 'compact' ? 'px-1 py-0 text-xs' : 'px-1 py-0.5 text-sm'} font-bold text-gray-100 placeholder-gray-600 focus:border-gold/50 focus:outline-none`}
      />
      <button
        type="button"
        aria-label={`Increase${ariaLabel ? ` ${ariaLabel.toLowerCase()}` : ''}`}
        onClick={() => bump(1)}
        disabled={value != null && value >= max}
        className={`${btnSize} rounded bg-space-800 border border-space-700 text-gray-400 hover:text-gold hover:border-gold/40 disabled:opacity-40 disabled:hover:text-gray-400 disabled:hover:border-space-700 transition-colors flex items-center justify-center font-bold`}
      >
        +
      </button>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function roundTo(n: number, decimals: number): number {
  if (decimals <= 0) return Math.round(n);
  const m = Math.pow(10, decimals);
  return Math.round(n * m) / m;
}
