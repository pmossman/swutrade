import { Popover } from './Popover';

export interface KebabMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  /** If set, renders the item as an anchor that opens in a new tab. */
  href?: string;
  /** Disables the item (grayed out, no action). */
  disabled?: boolean;
  /** Delay (ms) before closing the menu after click. Useful when the
   *  item's onClick triggers a visible state change (e.g. a "Copied!"
   *  flash) that the user should see before the menu dismisses. */
  holdBeforeCloseMs?: number;
}

interface KebabMenuProps {
  items: KebabMenuItem[];
  /** Visual size of the trigger button — pick to match sibling
   *  controls in the row (qty +/−, collapse chevron, etc.). */
  size?: 'xs' | 'sm' | 'md';
  /** aria-label for the trigger button. */
  ariaLabel?: string;
}

/**
 * Three-dot overflow menu. Each item closes the menu on click.
 * Consumers pass `items`; we handle the popover, click-outside,
 * and keyboard dismissal.
 */
export function KebabMenu({ items, size = 'sm', ariaLabel = 'More actions' }: KebabMenuProps) {
  // Fixed box sized to match the sibling +/− / collapse buttons in
  // the row so the kebab doesn't read as the biggest thing.
  const triggerSize = size === 'xs' ? 'w-5 h-5' : size === 'sm' ? 'w-6 h-6' : 'w-7 h-7';
  const dotSize = size === 'xs' ? 'w-3 h-3' : size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';

  return (
    <Popover
      align="right"
      panelClassName="min-w-[160px] py-1"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            toggle();
          }}
          className={`${triggerSize} flex items-center justify-center rounded-md bg-space-700 text-gray-300 hover:text-gray-100 hover:bg-space-600 transition-colors`}
          aria-label={ariaLabel}
        >
          <svg className={dotSize} fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="5" r="2.2" />
            <circle cx="12" cy="12" r="2.2" />
            <circle cx="12" cy="19" r="2.2" />
          </svg>
        </button>
      )}
    >
      {({ close }) => (
        <ul role="menu" className="text-xs text-gray-200">
          {items.map((item, i) => {
            const onActivate = () => {
              if (item.disabled) return;
              item.onClick?.();
              if (item.holdBeforeCloseMs && item.holdBeforeCloseMs > 0) {
                setTimeout(close, item.holdBeforeCloseMs);
              } else {
                close();
              }
            };
            const base = `flex items-center gap-2 px-3 py-2 w-full text-left transition-colors ${item.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-space-700'}`;
            if (item.href && !item.disabled) {
              return (
                <li key={i} role="none">
                  <a
                    role="menuitem"
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={close}
                    className={base}
                  >
                    {item.icon && <span className="w-4 h-4 text-gray-400 shrink-0">{item.icon}</span>}
                    <span>{item.label}</span>
                  </a>
                </li>
              );
            }
            return (
              <li key={i} role="none">
                <button
                  role="menuitem"
                  type="button"
                  onClick={onActivate}
                  disabled={item.disabled}
                  className={base}
                >
                  {item.icon && <span className="w-4 h-4 text-gray-400 shrink-0">{item.icon}</span>}
                  <span>{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Popover>
  );
}
