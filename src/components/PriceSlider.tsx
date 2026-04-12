interface PriceSliderProps {
  value: number;
  onChange: (value: number) => void;
}

const PRESETS = [50, 60, 70, 80, 90, 100] as const;

export function PriceSlider({ value, onChange }: PriceSliderProps) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[11px] text-gray-500 mr-0.5">% TCG</span>
      {PRESETS.map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-1.5 py-1 rounded-md text-xs font-semibold transition-colors ${
            value === p
              ? 'bg-gold/20 text-gold border border-gold/40'
              : 'bg-space-700 text-gray-400 border border-space-600 hover:border-gray-500'
          }`}
        >
          {p}%
        </button>
      ))}
    </div>
  );
}
