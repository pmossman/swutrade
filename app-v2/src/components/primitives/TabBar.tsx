import { NavLink } from 'react-router';
import type { ReactNode } from 'react';

/*
 * Bottom tab bar — four destinations, always visible on mobile.
 * Keyboard operable: the surrounding <nav role="tablist"> pairs with
 * each tab's role="tab" so arrow-keys move between them on desktop.
 *
 * 56px baseline height + safe-area-bottom inset; FAB reserves 16px
 * above this strip via its own offset.
 */

interface Tab {
  to: string;
  label: string;
  icon: ReactNode;
}

const TABS: Tab[] = [
  { to: '/', label: 'Trades', icon: <IconTrades /> },
  { to: '/cards', label: 'Cards', icon: <IconCards /> },
  { to: '/community', label: 'Community', icon: <IconCommunity /> },
  { to: '/me', label: 'Me', icon: <IconMe /> },
];

export function TabBar() {
  return (
    <nav
      role="tablist"
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex h-14 max-w-xl items-stretch">
        {TABS.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.to === '/'}
              role="tab"
              className={({ isActive }) =>
                [
                  'flex h-full min-h-11 flex-col items-center justify-center gap-0.5',
                  'text-[length:var(--text-caption)] leading-[length:var(--text-caption--line-height)] font-semibold tracking-wide',
                  isActive ? 'text-accent' : 'text-fg-muted',
                ].join(' ')
              }
            >
              <span aria-hidden="true">{tab.icon}</span>
              <span>{tab.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function IconTrades() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h11l-3-3" />
      <path d="M17 13H6l3 3" />
    </svg>
  );
}

function IconCards() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="10" height="13" rx="1.5" />
      <rect x="7" y="2" width="10" height="13" rx="1.5" />
    </svg>
  );
}

function IconCommunity() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="8" r="3" />
      <circle cx="14" cy="6" r="2.5" />
      <path d="M2 17c0-2.8 2.2-5 5-5s5 2.2 5 5" />
      <path d="M12 17c0-2 1.5-4 3.5-4s3.5 2 3.5 4" />
    </svg>
  );
}

function IconMe() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="7" r="3" />
      <path d="M3 18c0-3.3 3.1-6 7-6s7 2.7 7 6" />
    </svg>
  );
}
