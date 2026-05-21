import type { SessionView } from '../hooks/useSession';

/**
 * Client-side projection of `lib/sessionLifecycle.ts::sessionCapabilities`.
 *
 * The server module computes capabilities from a raw `trade_sessions`
 * row; this module computes them from the wire-shape `SessionView`
 * that `useSession` exposes. The two must stay in lockstep — a contract
 * test in the API integration suite asserts that for every (status,
 * action) pair, "client says canX" iff "server mutator accepts the
 * action."
 *
 * Replaces the four-way unpack (`settled / cancelled / expired /
 * active`) and the per-CTA `session.status !== 'active'` guards in
 * SessionView. Adding a future terminal state (e.g. `rejected`) now
 * means flipping a single row here, not eight inlined guards.
 */
export interface SessionCapabilities {
  /** Viewer may edit their side of the trade. */
  canEdit: boolean;
  /** Viewer may add their confirmation (i.e. not yet confirmed). */
  canConfirm: boolean;
  /** Viewer may withdraw their confirmation (i.e. already confirmed). */
  canUnconfirm: boolean;
  /** Viewer may cancel the session (always allowed on active). */
  canCancel: boolean;
  /** Viewer may decline the offer — only meaningful when there's a
   *  counterpart on the other side. An open-slot session has nothing
   *  to decline. */
  canDecline: boolean;
  /** Viewer may suggest edits to the counterpart — open slot disables. */
  canSuggest: boolean;
  /** Viewer may send chat — open slot disables. */
  canChat: boolean;
}

const TERMINAL_CAPABILITIES: SessionCapabilities = {
  canEdit: false,
  canConfirm: false,
  canUnconfirm: false,
  canCancel: false,
  canDecline: false,
  canSuggest: false,
  canChat: false,
};

export function sessionCapabilities(session: SessionView): SessionCapabilities {
  if (session.status !== 'active') return TERMINAL_CAPABILITIES;
  const hasCounterpart = !session.openSlot;
  return {
    canEdit: true,
    canConfirm: !session.confirmedByViewer,
    canUnconfirm: session.confirmedByViewer,
    canCancel: true,
    canDecline: hasCounterpart,
    canSuggest: hasCounterpart,
    canChat: hasCounterpart,
  };
}

/** Whether the session is in any terminal state. */
export function isSessionTerminal(session: SessionView): boolean {
  return session.status !== 'active';
}
