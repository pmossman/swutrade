import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../services/apiClient';
import { DECLINE_ERRORS } from '../services/sessionErrors';
import { createKeyedCache } from './sharedCache';
import type {
  TradeCardSnapshot as SchemaTradeCardSnapshot,
  SessionStatus as SchemaSessionStatus,
  SessionEventType as SchemaSessionEventType,
} from '../../lib/schema';

// Re-export the canonical shapes from lib/schema.ts. The hook's
// public API surface stays identical; the schema is now the single
// source of truth instead of having parallel hand-rolled copies
// here (audit 08-types-deadcode #1).
export type TradeCardSnapshot = SchemaTradeCardSnapshot;
export type SessionStatus = SchemaSessionStatus;
export type SessionEventType = SchemaSessionEventType;

/**
 * Cross-side suggestion as projected to the viewer. `targetIsViewer`
 * means the viewer is the one expected to accept/dismiss; otherwise
 * it's their pending suggestion to the counterpart.
 */
export interface PendingSuggestionView {
  id: string;
  suggestedByUserId: string;
  suggestedByViewer: boolean;
  targetSide: 'a' | 'b' | 'both';
  targetIsViewer: boolean;
  cardsToAdd: TradeCardSnapshot[];
  cardsToRemove: TradeCardSnapshot[];
  bothSidesSnapshot?: { yourCards: TradeCardSnapshot[]; theirCards: TradeCardSnapshot[] };
  /** What's still missing on the target side to satisfy this
   *  suggestion. Empty residual = effectively satisfied (the next
   *  edit will auto-dismiss). */
  residualAdd: TradeCardSnapshot[];
  residualRemove: TradeCardSnapshot[];
  createdAt: string;
}

export interface SessionEvent {
  id: string;
  type: SessionEventType;
  actorUserId: string | null;
  actorIsViewer: boolean;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface SessionCounterpart {
  userId: string;
  handle: string;
  username: string;
  avatarUrl: string | null;
  isAnonymous: boolean;
}

/**
 * Viewer-centric shape returned by `GET /api/sessions/<id>` — the
 * server flips the canonical a/b storage into `yourCards`/`theirCards`
 * so the client never has to know about the physical ordering.
 * Mirrors `lib/sessions.ts::SessionView`.
 */
export interface SessionView {
  id: string;
  status: SessionStatus;
  viewer: { userId: string; side: 'a' | 'b' };
  counterpart: SessionCounterpart | null;
  openSlot: boolean;
  yourCards: TradeCardSnapshot[];
  theirCards: TradeCardSnapshot[];
  confirmedByViewer: boolean;
  confirmedByCounterpart: boolean;
  lastEditedByViewer: boolean;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  expiresAt: string;
  /** Most-recent timeline events (newest-first). */
  events: SessionEvent[];
  /** Count of timeline events the viewer hasn't seen — drives the
   *  unread badge on the timeline tab. */
  unreadCount: number;
  /** Viewer's last-read timestamp; null = never opened. */
  lastReadAt: string | null;
  /** Active cross-side suggestions (viewer-centric). */
  suggestions: PendingSuggestionView[];
  /** B6 — server-derived flag set when the session is waiting on
   *  the viewer's response (counterpart confirmed and viewer
   *  hasn't, or there's an unresolved suggestion targeting them).
   *  Drives Inbox row prominence on Home; can also feed future
   *  session-banner / re-engagement DM logic. */
  awaitingViewer: boolean;
  /** B5 — only meaningful when status='cancelled'. Distinguishes a
   *  declined offer from a mutual withdrawal so the terminal banner
   *  can render distinct copy. Null otherwise. */
  cancelReason: 'declined' | 'withdrawn' | null;
}

/**
 * Shape returned when the viewer is NOT a participant but the
 * session has an open slot — shown as "Join this trade" prompt.
 * Mirrors `lib/sessions.ts::SessionPreview`.
 */
export interface SessionPreview {
  id: string;
  creator: {
    handle: string;
    username: string;
    avatarUrl: string | null;
    isAnonymous: boolean;
  };
  creatorCardCount: number;
  createdAt: string;
  expiresAt: string;
}

export type SessionFetchStatus = 'loading' | 'ready' | 'preview' | 'not-found' | 'error';

export interface SessionApi {
  session: SessionView | null;
  preview: SessionPreview | null;
  status: SessionFetchStatus;
  /** Replace the viewer's half; the server clears confirmations and
   *  bumps expiry. Optimistically updates local state before the
   *  round-trip so card edits feel instant. */
  saveCards: (cards: TradeCardSnapshot[]) => Promise<void>;
  /** Confirm the current state; when both parties are confirmed, the
   *  server transitions status → settled. */
  confirm: () => Promise<{ settled: boolean }>;
  /** Remove the viewer from the confirmation set. Used when a user
   *  has confirmed, spotted a mistake, and wants to edit without
   *  having to bump a card qty as a side effect (editSessionSide
   *  already clears confirmations; this is the lighter-weight path). */
  unconfirm: () => Promise<void>;
  /** Cancel an active session. Terminal from both sides; either
   *  participant can cancel. */
  cancel: () => Promise<void>;
  /** Decline an active session. Same terminal effect as cancel
   *  (status → cancelled), but tags `cancel_reason='declined'` so
   *  the counterpart's notification reads as a rejection of an
   *  offer rather than mutual withdrawal. Returns ok/error so the
   *  UI can route on outcome (e.g. clear stale state on success). */
  decline: (note?: string) => Promise<
    | { ok: true }
    | { ok: false; reason: 'not-active' | 'no-counterpart' | 'note-too-long' | 'error' }
  >;
  /** Claim the open slot. Mints a ghost user if the viewer has no
   *  session cookie; otherwise promotes the signed-in user into
   *  slot B. Re-fetches on success so status flips to 'ready'. */
  claim: () => Promise<void>;
  /** True when the counterpart has edited more recently than we last
   *  saw — drives the "Alice changed something" banner in the UI. */
  hasUnseenCounterpartEdit: boolean;
  /** Mark the current counterpart state as seen (resets the banner
   *  above). Called when the user scrolls the counterpart panel into
   *  view or dismisses the banner. */
  markCounterpartSeen: () => void;
  /** Append a chat message to the timeline. Server validates length
   *  (≤500 chars) + rate-limits to ~10/min. Returns 'rate-limited'
   *  on cap-exceeded so the UI can show a transient "slow down"
   *  hint without retrying. */
  sendChat: (body: string) => Promise<{ ok: true } | { ok: false; reason: 'rate-limited' | 'invalid' | 'error' }>;
  /** Stamp the viewer's last-read timestamp to NOW. Called
   *  automatically on visibilitychange→visible (matches the
   *  background-sync pattern). Idempotent. */
  markRead: () => Promise<void>;
  /** Author a cross-side suggestion. targetSide must be the
   *  counterpart's side. */
  suggest: (args: {
    targetSide: 'a' | 'b';
    cardsToAdd?: TradeCardSnapshot[];
    cardsToRemove?: TradeCardSnapshot[];
  }) => Promise<{ ok: true; suggestionId: string } | { ok: false; reason: string }>;
  /** Accept a pending suggestion (target only). Applies the residual
   *  delta to the target side via the same edit machinery — clears
   *  confirmations + records snapshot. */
  acceptSuggestion: (suggestionId: string) => Promise<{ ok: boolean }>;
  /** Explicit dismissal — either party can dismiss. */
  dismissSuggestion: (suggestionId: string) => Promise<{ ok: boolean }>;
  /** Propose a revert to a past edit-snapshot. The targetSide is
   *  always 'both'; the counterpart accepts to apply (double-sided
   *  confirm). 'no-op' reason returned when current state already
   *  matches the snapshot. */
  proposeRevert: (snapshotEventId: string) => Promise<{ ok: true; suggestionId: string } | { ok: false; reason: string }>;
}

// Module-scoped cache: session id → SessionView. Same pattern as
// `useTradeDetail`. Mutations invalidate the affected key; polls
// overwrite with the freshest server state.
const cache = createKeyedCache<string, SessionView>();

/** Testing-only cache clear between runs. */
export function __resetSessionCache() {
  cache.clear();
}

/**
 * Cadence for the counterpart-change poll. 2500ms is fast enough to
 * feel live when both parties are actively editing, slow enough not
 * to burn server cycles for an async session where days go by
 * between edits. The poll pauses when the tab is hidden so we don't
 * waste requests on inactive tabs.
 */
const POLL_INTERVAL_MS = 2500;

export function useSession(sessionId: string | null): SessionApi {
  const [session, setSession] = useState<SessionView | null>(
    () => (sessionId ? cache.get(sessionId) ?? null : null),
  );
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [status, setStatus] = useState<SessionFetchStatus>(
    () => (sessionId && cache.has(sessionId) ? 'ready' : 'loading'),
  );
  // Last counterpart-edit timestamp the user has acknowledged. When
  // the server returns a newer `lastEditedAt` from the counterpart,
  // the banner fires. Reset on `markCounterpartSeen` or when the
  // viewer themselves edits.
  const [seenCounterpartEditAt, setSeenCounterpartEditAt] = useState<string | null>(null);

  // Track the latest session in a ref so the poll closure reads fresh
  // state without needing the effect to re-subscribe on every fetch.
  const latestRef = useRef<SessionView | null>(session);
  useEffect(() => {
    latestRef.current = session;
  }, [session]);

  // Poll-pause flag — true while ANY mutation (save/confirm/cancel/
  // suggest/etc.) is in flight. The polling loop checks it before
  // applying a server response so a poll can't land between the
  // viewer's optimistic update and that mutation's PUT response,
  // temporarily reverting the edit.
  //
  // **NOT a mutex.** This does NOT prevent two simultaneous mutations
  // of the same kind from racing (the saveCards rapid-click bug we
  // caught was exactly this — both fired, both applied optimistic
  // state, the first response overwrote the second). For real
  // mutation-vs-mutation race protection, see the gen-counter pattern
  // applied in useGuildMemberships / useAccountSettings /
  // useCommunityMembers (audit 13-mutation-patterns.md).
  //
  // The contract is poll-vs-mutation. Set true at the top of every
  // mutation, cleared on completion (success OR failure). Some paths
  // (e.g. saveCards' rollback `fetchOnce()`) clear it mid-mutation
  // because the rollback is itself a poll-style refetch that needs
  // the pause released.
  const pollPausedRef = useRef(false);

  const applyServerSession = useCallback((next: SessionView) => {
    cache.set(next.id, next);
    setSession(next);
    setStatus('ready');
  }, []);

  const fetchOnce = useCallback(async () => {
    if (!sessionId) return;
    if (pollPausedRef.current) return;
    const result = await apiGet<{
      session?: SessionView;
      preview?: SessionPreview;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (pollPausedRef.current) return;
    if (!result.ok) {
      // Preserve any cached body but flag the right terminal status.
      if (result.reason === 'not-found') setStatus('not-found');
      else if (!cache.has(sessionId)) setStatus('error');
      return;
    }
    if (result.data.session) {
      setPreview(null);
      applyServerSession(result.data.session);
      return;
    }
    if (result.data.preview) {
      setPreview(result.data.preview);
      setStatus('preview');
      return;
    }
    setStatus('not-found');
  }, [sessionId, applyServerSession]);

  // Initial fetch.
  useEffect(() => {
    if (!sessionId) {
      setStatus('not-found');
      return;
    }
    if (!cache.has(sessionId)) setStatus('loading');
    fetchOnce();
  }, [sessionId, fetchOnce]);

  // Polling — respects tab visibility to avoid background burn.
  useEffect(() => {
    if (!sessionId) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId != null) return;
      intervalId = setInterval(() => {
        // Skip the poll when the current state is a terminal. The
        // server won't change it from under us and we'd just pay
        // for the round-trip.
        if (latestRef.current && latestRef.current.status !== 'active') return;
        fetchOnce();
      }, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Immediate catch-up fetch when the tab becomes visible so
        // the user doesn't stare at stale state during the interval.
        fetchOnce();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop();
    };
  }, [sessionId, fetchOnce]);

  // Counterpart-edit banner bookkeeping. On first successful fetch
  // we treat whatever we loaded as "seen" so the banner doesn't fire
  // on initial render. Any later counterpart edit (their id on
  // lastEditedByViewer=false AND a newer timestamp) flags the banner.
  const initialSeenSetRef = useRef(false);
  useEffect(() => {
    if (!session) return;
    if (!initialSeenSetRef.current) {
      initialSeenSetRef.current = true;
      setSeenCounterpartEditAt(session.lastEditedAt);
    }
  }, [session]);

  const hasUnseenCounterpartEdit = !!session
    && !session.lastEditedByViewer
    && seenCounterpartEditAt !== null
    && session.lastEditedAt > seenCounterpartEditAt;

  const markCounterpartSeen = useCallback(() => {
    if (session) setSeenCounterpartEditAt(session.lastEditedAt);
  }, [session]);

  // The mutation lifecycle for this hook. Every server-mutating call
  // — saveCards, confirm, cancel, suggest, accept-suggestion, … —
  // wraps `request` with the same shape:
  //
  //   1. Pause the poll so a 2.5s tick can't land between the
  //      optimistic apply and the request's response (which would
  //      visibly revert the user's edit).
  //   2. If an `optimistic` snapshot is supplied, apply it now AND
  //      bump seenCounterpartEditAt to its timestamp so the viewer's
  //      own edit doesn't trip the "counterpart changed" banner.
  //   3. Fire the request.
  //   4. On success: apply the server's session (if returned). When
  //      we ran optimistic, re-sync seenCounterpartEditAt to the
  //      server's lastEditedAt (handles clock skew + counterpart
  //      edits the server reconciled).
  //   5. On failure with optimistic or `rollbackOnFailure`, drop the
  //      pause and `fetchOnce()` to overwrite local state with the
  //      canonical server view.
  //   6. Resume the poll regardless.
  //
  // Returns the underlying ActionResult so callers can narrow on
  // domain reasons (decline → 'not-active' / 'no-counterpart' etc.).
  // markRead deliberately bypasses this helper — read-state is fire-
  // and-forget and shouldn't pause the poll.
  const runMutation = useCallback(async <T extends { session?: SessionView | null }, E extends string = never>(
    config: {
      request: () => Promise<import('../services/apiClient').ActionResult<T, E>>;
      optimistic?: (current: SessionView) => SessionView;
      rollbackOnFailure?: boolean;
    },
  ): Promise<import('../services/apiClient').ActionResult<T, E>> => {
    pollPausedRef.current = true;
    const hasOptimistic = !!config.optimistic && !!session;
    if (hasOptimistic && config.optimistic && session) {
      const optimistic = config.optimistic(session);
      applyServerSession(optimistic);
      setSeenCounterpartEditAt(optimistic.lastEditedAt);
    }
    try {
      const result = await config.request();
      if (!result.ok) {
        if (hasOptimistic || config.rollbackOnFailure) {
          pollPausedRef.current = false;
          await fetchOnce();
        }
        return result;
      }
      if (result.data.session) {
        applyServerSession(result.data.session);
        if (hasOptimistic) {
          setSeenCounterpartEditAt(result.data.session.lastEditedAt);
        }
      }
      return result;
    } finally {
      pollPausedRef.current = false;
    }
  }, [session, applyServerSession, fetchOnce]);

  const saveCards = useCallback(async (cards: TradeCardSnapshot[]) => {
    if (!sessionId || !session) return;
    // Optimistic apply + auto-rollback on failure are both handled by
    // runMutation. The optimistic snapshot also clears confirmations
    // to match the server behaviour (edit invalidates confirms).
    await runMutation({
      request: () => apiPut<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/edit`,
        { cards },
      ),
      optimistic: current => ({
        ...current,
        yourCards: cards,
        confirmedByViewer: false,
        confirmedByCounterpart: false,
        lastEditedByViewer: true,
        lastEditedAt: new Date().toISOString(),
      }),
    });
  }, [sessionId, session, runMutation]);

  const confirm = useCallback(async () => {
    if (!sessionId) return { settled: false };
    const result = await runMutation({
      request: () => apiPost<{ session: SessionView | null; settled: boolean }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/confirm`,
      ),
    });
    if (!result.ok || !result.data.session) return { settled: false };
    return { settled: result.data.settled };
  }, [sessionId, runMutation]);

  const unconfirm = useCallback(async () => {
    if (!sessionId) return;
    await runMutation({
      request: () => apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/unconfirm`,
      ),
    });
  }, [sessionId, runMutation]);

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    await runMutation({
      request: () => apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
      ),
    });
  }, [sessionId, runMutation]);

  const decline = useCallback(async (note?: string) => {
    if (!sessionId) return { ok: false as const, reason: 'error' as const };
    const result = await runMutation({
      request: () => apiPost<{ session: SessionView | null }, typeof DECLINE_ERRORS[number]>(
        `/api/sessions/${encodeURIComponent(sessionId)}/decline`,
        note ? { note } : {},
        { domainErrors: DECLINE_ERRORS },
      ),
    });
    if (!result.ok) {
      // result.reason is now narrowed to the DECLINE_ERRORS union +
      // ActionFailureReason — switch exhaustively instead of string-
      // comparing detail.
      switch (result.reason) {
        case 'not-active':
        case 'no-counterpart':
        case 'note-too-long':
          return { ok: false as const, reason: result.reason };
        default:
          return { ok: false as const, reason: 'error' as const };
      }
    }
    return { ok: true as const };
  }, [sessionId, runMutation]);

  const claim = useCallback(async () => {
    if (!sessionId) return;
    // Claim is the one mutation where a failure (someone else won the
    // race) should fall through to a re-fetch so the UI flips to
    // whatever state the server has — usually 404 once the slot is
    // filled. rollbackOnFailure handles that path. On success the
    // helper applies the new session; we also clear the preview.
    const result = await runMutation({
      request: () => apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/claim`,
      ),
      rollbackOnFailure: true,
    });
    if (result.ok && result.data.session) setPreview(null);
  }, [sessionId, runMutation]);

  const sendChat = useCallback(async (body: string) => {
    if (!sessionId) return { ok: false as const, reason: 'error' as const };
    const trimmed = body.trim();
    if (trimmed.length === 0 || trimmed.length > 500) {
      return { ok: false as const, reason: 'invalid' as const };
    }
    const result = await runMutation({
      request: () => apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
        { message: trimmed },
      ),
    });
    if (!result.ok) {
      if (result.reason === 'rate-limited') {
        return { ok: false as const, reason: 'rate-limited' as const };
      }
      return { ok: false as const, reason: 'error' as const };
    }
    return { ok: true as const };
  }, [sessionId, runMutation]);

  const markRead = useCallback(async () => {
    if (!sessionId) return;
    // Skip if already at zero — avoids a write per visibility change
    // when the viewer is just toggling tabs without new activity.
    if (latestRef.current && latestRef.current.unreadCount === 0) return;
    try {
      const result = await apiPost<{ session: SessionView }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/mark-read`,
      );
      if (result.ok && result.data.session) applyServerSession(result.data.session);
    } catch {
      // Read-state is a UX nicety, not a correctness concern. A
      // failed mark-read just means the badge stays for one more
      // poll cycle.
    }
  }, [sessionId, applyServerSession]);

  // markRead used to auto-fire on page visibilitychange→visible —
  // intended to clear the unread badge once the user was actively
  // looking. In practice it fired on the FIRST visibility check
  // (page mount), wiping the unread count before the user saw the
  // glow on the chat button. Beta repro: A sends a chat, B clicks
  // the invite link, B's session page loads → markRead fires →
  // unreadCount goes to 0 → B never sees the badge for A's message.
  //
  // Read-state is now driven by the timeline-panel's own visibility
  // (SessionView fires markRead when timelineOpen flips true and
  // refreshes it on visibilitychange while open). The chat button
  // is the badge-bearing surface, so the badge clears when the
  // user looks AT the chat, not just at the session.

  const suggest = useCallback(async (args: {
    targetSide: 'a' | 'b';
    cardsToAdd?: TradeCardSnapshot[];
    cardsToRemove?: TradeCardSnapshot[];
  }) => {
    if (!sessionId) return { ok: false as const, reason: 'no-session' };
    const result = await runMutation({
      request: () => apiPost<{ session: SessionView | null; suggestionId: string | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/suggest`,
        {
          targetSide: args.targetSide,
          cardsToAdd: args.cardsToAdd ?? [],
          cardsToRemove: args.cardsToRemove ?? [],
        },
      ),
    });
    if (!result.ok) return { ok: false as const, reason: result.reason };
    return { ok: true as const, suggestionId: result.data.suggestionId ?? '' };
  }, [sessionId, runMutation]);

  const acceptSuggestion = useCallback(async (suggestionId: string) => {
    if (!sessionId) return { ok: false };
    const result = await runMutation({
      request: () => apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/suggestion/${encodeURIComponent(suggestionId)}/accept`,
      ),
    });
    if (!result.ok || !result.data.session) return { ok: false };
    return { ok: true };
  }, [sessionId, runMutation]);

  const dismissSuggestion = useCallback(async (suggestionId: string) => {
    if (!sessionId) return { ok: false };
    const result = await runMutation({
      request: () => apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/suggestion/${encodeURIComponent(suggestionId)}/dismiss`,
      ),
    });
    if (!result.ok || !result.data.session) return { ok: false };
    return { ok: true };
  }, [sessionId, runMutation]);

  const proposeRevert = useCallback(async (snapshotEventId: string) => {
    if (!sessionId) return { ok: false as const, reason: 'no-session' };
    const result = await runMutation({
      request: () => apiPost<{ session: SessionView | null; suggestionId: string | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/propose-revert`,
        { snapshotEventId },
      ),
    });
    if (!result.ok) return { ok: false as const, reason: result.reason };
    return { ok: true as const, suggestionId: result.data.suggestionId ?? '' };
  }, [sessionId, runMutation]);

  return {
    session,
    preview,
    status,
    saveCards,
    confirm,
    unconfirm,
    cancel,
    claim,
    hasUnseenCounterpartEdit,
    markCounterpartSeen,
    sendChat,
    decline,
    markRead,
    suggest,
    acceptSuggestion,
    dismissSuggestion,
    proposeRevert,
  };
}
