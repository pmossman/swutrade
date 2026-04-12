import { SETS } from '../types';

interface SetFilterProps {
  value: string | null;
  onChange: (slug: string | null) => void;
}

const mainSets = SETS.filter(s => s.category === 'main');
const promoSets = SETS.filter(s => s.category === 'promo');

export function SetFilter({ value, onChange }: SetFilterProps) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value || null)}
      className="bg-space-700 text-gray-200 border border-space-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-gold transition-colors cursor-pointer"
    >
      <option value="">All Sets</option>
      <optgroup label="Main Sets">
        {mainSets.map(set => (
          <option key={set.slug} value={set.slug}>
            {set.code} — {set.name}
          </option>
        ))}
      </optgroup>
      <optgroup label="Promo & Special">
        {promoSets.map(set => (
          <option key={set.slug} value={set.slug}>
            {set.code} — {set.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
