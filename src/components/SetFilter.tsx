import { SETS } from '../types';
import { Popover } from './Popover';

interface SetFilterProps {
  value: string | null;
  onChange: (slug: string | null) => void;
}

const mainSets = SETS.filter(s => s.category === 'main');
const promoSets = SETS.filter(s => s.category === 'promo');

// Custom listbox built on Popover so the expanded state follows the
// app's theming. Native <select> dropdowns hand rendering to the OS and
// can't be styled, which clashed with every other control in the bar.
export function SetFilter({ value, onChange }: SetFilterProps) {
  const currentSet = value ? SETS.find(s => s.slug === value) : null;
  const currentLabel = currentSet ? currentSet.code : 'All Sets';
  const currentName = currentSet ? currentSet.name : null;

  return (
    <Popover
      align="left"
      panelClassName="min-w-[220px] max-h-[60vh] overflow-y-auto py-1"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); toggle(); }}
          aria-expanded={open}
          aria-label={`Set filter: ${currentLabel}`}
          // Accented border so the scope selector reads as higher-order
          // than the pricing tuners to its right.
          className={`flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            open
              ? 'bg-space-800 border border-gold/50 text-gold-bright'
              : value
                ? 'bg-space-800/80 border border-gold/30 text-gold hover:border-gold/50'
                : 'bg-space-800/60 border border-space-600 text-gray-200 hover:border-gray-500'
          }`}
        >
          <span className="truncate max-w-[180px]">
            {currentSet ? (
              <>
                <span className="text-gold-bright">{currentLabel}</span>
                <span className="text-gray-500 font-normal ml-1">·</span>
                <span className="text-gray-400 font-normal ml-1">{currentName}</span>
              </>
            ) : (
              <span>All Sets</span>
            )}
          </span>
          <svg className={`w-3 h-3 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
    >
      {({ close }) => (
        <ul role="listbox" className="text-xs text-gray-200">
          <SetOption
            label="All Sets"
            code={null}
            active={value === null}
            onSelect={() => { onChange(null); close(); }}
          />
          <GroupLabel first>Main Sets</GroupLabel>
          {mainSets.map(set => (
            <SetOption
              key={set.slug}
              label={set.name}
              code={set.code}
              active={value === set.slug}
              onSelect={() => { onChange(set.slug); close(); }}
            />
          ))}
          <GroupLabel>Promo &amp; Special</GroupLabel>
          {promoSets.map(set => (
            <SetOption
              key={set.slug}
              label={set.name}
              code={set.code}
              active={value === set.slug}
              onSelect={() => { onChange(set.slug); close(); }}
            />
          ))}
        </ul>
      )}
    </Popover>
  );
}

function GroupLabel({ children, first = false }: { children: React.ReactNode; first?: boolean }) {
  // Gold-accented section kicker. The top divider with a gold tint
  // separates the "Main Sets" / "Promo & Special" clusters clearly.
  return (
    <li className={`sticky top-0 bg-space-800 px-3 pt-2 pb-1.5 ${first ? 'border-t border-space-700 mt-1' : 'border-t border-gold/20 mt-2 pt-2.5'}`}>
      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-gradient-to-r from-gold/40 to-transparent" aria-hidden />
        <span className="text-[10px] uppercase tracking-[0.2em] text-gold/70 font-bold">
          {children}
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-gold/40 to-transparent" aria-hidden />
      </div>
    </li>
  );
}

function SetOption({
  label,
  code,
  active,
  onSelect,
}: {
  label: string;
  code: string | null;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full text-left flex items-center gap-2 px-3 py-1.5 transition-colors ${
          active ? 'bg-gold/10 text-gold-bright' : 'hover:bg-space-700 text-gray-200'
        }`}
      >
        {code !== null && (
          <span className={`text-[10px] font-bold tabular-nums min-w-[32px] ${active ? 'text-gold' : 'text-gray-500'}`}>
            {code}
          </span>
        )}
        <span className="flex-1">{label}</span>
        {active && (
          <svg className="w-3.5 h-3.5 text-gold shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>
    </li>
  );
}
