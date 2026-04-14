import { Popover } from './Popover';
import { PriceModeToggle } from './PriceModeToggle';
import type { PriceMode } from '../types';

interface PriceSliderProps {
  value: number;
  onChange: (value: number) => void;
  /** When provided, the popover also exposes the Market/Low toggle —
   *  used on narrow viewports where there's no room for an inline one
   *  in the header pill. The inline toggle can hide on mobile and users
   *  still get to the setting through this popover. */
  priceMode?: PriceMode;
  onPriceModeChange?: (mode: PriceMode) => void;
}

const PRESETS = [50, 60, 70, 80, 90, 100] as const;

/**
 * Collapsed-by-default TCG % picker. Shows the current value as a small
 * pill; tap to expand a popover with the preset buttons. On mobile the
 * popover also carries the Market/Low toggle so the inline toggle can
 * drop out of the header.
 */
export function PriceSlider({ value, onChange, priceMode, onPriceModeChange }: PriceSliderProps) {
  const includeModeToggle = priceMode && onPriceModeChange;

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
          aria-label={
            priceMode
              ? `TCG ${priceMode === 'low' ? 'Low' : 'Market'} ${value}%`
              : `TCG percentage: ${value}%`
          }
          aria-expanded={open}
        >
          <span className="text-[10px] text-gold/70 font-normal">TCG</span>
          {/* Show mode inline when this pill carries both controls
              (mobile case). Keeps the "what is currently in effect"
              visible without an extra tap. */}
          {priceMode && (
            <span className="text-[10px] text-gold/70 font-normal">
              {priceMode === 'low' ? 'Low' : 'Mkt'}
            </span>
          )}
          <span className="tabular-nums">{value}%</span>
          <svg className="w-3 h-3 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
    >
      {({ close }) => (
        <div className="flex flex-col gap-2 min-w-[180px]">
          {/* Market/Low toggle — rendered inside the popover so the
              header pill can shed its inline Market/Low on mobile.
              Hidden on desktop where the inline one is already visible. */}
          {includeModeToggle && (
            <div className="flex justify-center md:hidden">
              <PriceModeToggle value={priceMode!} onChange={onPriceModeChange!} />
            </div>
          )}
          {/* 3-col on mobile, 6-col on sm+ matches the original layout. */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1">
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
        </div>
      )}
    </Popover>
  );
}
