import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * Single-source-of-truth for the trade builder's primary action CTA.
 *
 * Before this, four separate "bar" components (`ProposeBar`,
 * `CounterBar`, `EditBar`, `AutoBalanceBanner`) each rendered their
 * own Send / Save / Apply button inline, and all four stacked above
 * the panels as a mutex (`App.tsx:575-624`). Four shapes, four
 * locations, same conceptual role. UX-A2 from the audit.
 *
 * This context lets the active composer bar **register** its primary
 * action shape (label, onClick, sending/disabled state, error) on
 * mount and clear it on unmount. A single `<PrimaryActionBar />`
 * rendered at the bottom of the trade-builder body reads from the
 * context and renders one consistent button. Because the source bars
 * are a mutex, only one registration is ever live; no conflicts.
 *
 * Desktop and mobile both read this context — placement is the same
 * everywhere (below TradeBalance, full-width gold). Consistency is
 * more important than a subtle layout adaptation here.
 */

export interface PrimaryActionSpec {
  /** Visible label on the button. */
  label: string;
  /** Fired when the user taps. May open a confirm modal (Propose) or
   *  directly submit (Counter / Edit / AutoBalance). */
  onClick: () => void;
  /** True → button greyed + click no-ops. Typically empty-trade or
   *  missing-counterpart states. */
  disabled?: boolean;
  /** True → shows a "…ing" label (sending, saving, applying) and is
   *  implicitly disabled. */
  loading?: boolean;
  /** Alt label shown during `loading` — defaults to the base label
   *  suffixed with "…". Callers override for precise copy ("Sending…"
   *  vs "Saving…"). */
  loadingLabel?: string;
  /** When true → button renders as success (emerald bg, checkmark).
   *  Cleared on re-register. */
  sent?: boolean;
  /** Optional hint rendered below the button — e.g.
   *  "Add at least one card to either side to enable". */
  hint?: string;
  /** Error text from the last submit attempt. Rendered below the
   *  button with a red tint so the user sees it near the retry target. */
  error?: string;
  /** `data-testid` for e2e selectors. Preserves existing selectors
   *  like `propose-open-confirm` while the button's DOM position
   *  moves to the shared bar. */
  testId?: string;
}

interface PrimaryActionContextValue {
  /** The currently-registered action, or null if none. `<PrimaryActionBar />`
   *  renders null when this is null. */
  action: PrimaryActionSpec | null;
  /** Register / update the primary action. Stable reference across
   *  renders so callers can wire into `useEffect` dep arrays without
   *  re-registering on every render. */
  setPrimaryAction: (action: PrimaryActionSpec | null) => void;
}

const PrimaryActionContext = createContext<PrimaryActionContextValue | null>(null);

export function PrimaryActionProvider({ children }: { children: React.ReactNode }) {
  const [action, setActionState] = useState<PrimaryActionSpec | null>(null);
  // Refs keep setPrimaryAction stable even though the setter itself
  // would be stable from useState — we layer a no-op filter on top so
  // a re-register with the same shape doesn't cause a pointless
  // re-render of the bar component.
  const currentRef = useRef<PrimaryActionSpec | null>(null);

  const setPrimaryAction = useCallback((next: PrimaryActionSpec | null) => {
    // Shallow-compare the shape — if nothing changed, skip the state
    // update. Composer bars call this from useEffect with every state
    // transition; de-duping here keeps the bottom bar from re-rendering
    // on every keystroke in the composer's message textarea.
    if (shallowEqualSpec(currentRef.current, next)) return;
    currentRef.current = next;
    setActionState(next);
  }, []);

  const value = useMemo<PrimaryActionContextValue>(
    () => ({ action, setPrimaryAction }),
    [action, setPrimaryAction],
  );
  return <PrimaryActionContext.Provider value={value}>{children}</PrimaryActionContext.Provider>;
}

export function usePrimaryActionContext(): PrimaryActionContextValue {
  const ctx = useContext(PrimaryActionContext);
  if (!ctx) throw new Error('usePrimaryActionContext must be used inside PrimaryActionProvider');
  return ctx;
}

function shallowEqualSpec(a: PrimaryActionSpec | null, b: PrimaryActionSpec | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.label === b.label
    && a.onClick === b.onClick
    && !!a.disabled === !!b.disabled
    && !!a.loading === !!b.loading
    && a.loadingLabel === b.loadingLabel
    && !!a.sent === !!b.sent
    && a.hint === b.hint
    && a.error === b.error
    && a.testId === b.testId
  );
}
