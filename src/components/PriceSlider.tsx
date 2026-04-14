import { Popover } from './Popover';

interface PriceSliderProps {
  value: number;
  onChange: (value: number) => void;
}

const PRESETS = [50, 60, 70, 80, 90, 100] as const;

/**
 * Collapsed-by-default TCG % picker. Shows the current value as a small
 * pill; tap to expand a popover with the preset buttons. The big preset
 * strip was visually noisy for a setting most users only adjust once.
 */
export function PriceSlider({ value, onChange }: PriceSliderProps) {
  return (
    <Popover
      align="right"
      panelClassName="p-1.5"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); toggle(); }}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors ${
            open
              ? 'bg-gold/25 text-gold-bright border border-gold/50'
              : 'bg-gold/15 text-gold border border-gold/30 hover:bg-gold/20'
          }`}
          aria-label={`TCG percentage: ${value}%`}
          aria-expanded={open}
        >
          <span className="text-[10px] text-gold/70 font-normal">TCG</span>
          <span className="tabular-nums">{value}%</span>
          <svg className="w-3 h-3 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
    >
      {({ close }) => (
        // 3-col grid keeps the panel narrow enough to sit inside a
        // small mobile viewport. On sm+ we have room for a single row.
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 min-w-[180px]">
          {PRESETS.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => { onChange(p); close(); }}
              className={`px-1 py-1 rounded-md text-xs font-semibold text-center tabular-nums transition-colors ${
                value === p
                  ? 'bg-gold/20 text-gold border border-gold/40'
                  : 'bg-space-700 text-gray-400 border border-space-600 hover:border-gray-500'
              }`}
            >
              {p}%
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
