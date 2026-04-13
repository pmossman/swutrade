import type { PriceMode } from '../types';

interface PriceModeToggleProps {
  value: PriceMode;
  onChange: (mode: PriceMode) => void;
}

export function PriceModeToggle({ value, onChange }: PriceModeToggleProps) {
  return (
    <div className="flex items-center bg-space-700 border border-space-600 rounded-lg overflow-hidden">
      <button
        onClick={() => onChange('market')}
        className={`px-2 py-1.5 text-xs font-semibold transition-colors ${
          value === 'market'
            ? 'bg-gold/20 text-gold'
            : 'text-gray-400 hover:text-gray-300'
        }`}
      >
        Market
      </button>
      <button
        onClick={() => onChange('low')}
        className={`px-2 py-1.5 text-xs font-semibold transition-colors ${
          value === 'low'
            ? 'bg-gold/20 text-gold'
            : 'text-gray-400 hover:text-gray-300'
        }`}
      >
        Low
      </button>
    </div>
  );
}
