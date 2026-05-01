import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../services/apiClient';
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

  const saveCards = useCallback(async (cards: TradeCardSnapshot[]) => {
    if (!sessionId || !session) return;
    pollPausedRef.current = true;
    // Optimistic update — flip local state immediately so the viewer
    // sees their change land without waiting for the round-trip.
    // Confirmations also clear optimistically to match the server
    // behaviour (edit invalidates confirms).
    const optimistic: SessionView = {
      ...session,
      yourCards: cards,
      confirmedByViewer: false,
      confirmedByCounterpart: false,
      lastEditedByViewer: true,
      lastEditedAt: new Date().toISOString(),
    };
    applyServerSession(optimistic);
    // Reset the "seen" pointer so the viewer's own edit doesn't
    // trigger the counterpart-change banner on the next poll.
    setSeenCounterpartEditAt(optimistic.lastEditedAt);

    try {
      const result = await apiPut<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/edit`,
        { cards },
      );
      if (!result.ok || !result.data.session) {
        pollPausedRef.current = false;
        // Rollback: re-fetch canonical server state.
        await fetchOnce();
        return;
      }
      applyServerSession(result.data.session);
      setSeenCounterpartEditAt(result.data.session.lastEditedAt);
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, session, applyServerSession, fetchOnce]);

  const confirm = useCallback(async () => {
    if (!sessionId) return { settled: false };
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null; settled: boolean }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/confirm`,
      );
      if (!result.ok || !result.data.session) return { settled: false };
      applyServerSession(result.data.session);
      return { settled: result.data.settled };
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession]);

  const unconfirm = useCallback(async () => {
    if (!sessionId) return;
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/unconfirm`,
      );
      if (!result.ok || !result.data.session) return;
      applyServerSession(result.data.session);
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession]);

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
      );
      if (!result.ok || !result.data.session) return;
      applyServerSession(result.data.session);
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession]);

  const claim = useCallback(async () => {
    if (!sessionId) return;
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/claim`,
      );
      if (!result.ok || !result.data.session) {
        // On conflict (someone else claimed first), fall through and
        // re-fetch so the UI flips to whatever state the server
        // actually has — probably a 404 now that the slot is filled.
        pollPausedRef.current = false;
        await fetchOnce();
        return;
      }
      setPreview(null);
      applyServerSession(result.data.session);
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession, fetchOnce]);

  const sendChat = useCallback(async (body: string) => {
    if (!sessionId) return { ok: false as const, reason: 'error' as const };
    const trimmed = body.trim();
    if (trimmed.length === 0 || trimmed.length > 500) {
      return { ok: false as const, reason: 'invalid' as const };
    }
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
        { message: trimmed },
      );
      if (!result.ok) {
        if (result.reason === 'rate-limited') {
          return { ok: false as const, reason: 'rate-limited' as const };
        }
        return { ok: false as const, reason: 'error' as const };
      }
      if (result.data.session) applyServerSession(result.data.session);
      return { ok: true as const };
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession]);

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

  // Auto mark-read on visibility→visible so opening the session
  // tab clears the unread badge (matches the foreground-sync pattern).
  // Initial open is also covered: the initial fetchOnce gives us
  // the unreadCount, and the first visibility check fires markRead.
  useEffect(() => {
    if (!sessionId) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') markRead();
    };
    if (document.visibilityState === 'visible') markRead();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sessionId, markRead]);

  const suggest = useCallback(async (args: {
    targetSide: 'a' | 'b';
    cardsToAdd?: TradeCardSnapshot[];
    cardsToRemove?: TradeCardSnapshot[];
  }) => {
    if (!sessionId) return { ok: false as const, reason: 'no-session' };
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null; suggestionId: string | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/suggest`,
        {
          targetSide: args.targetSide,
          cardsToAdd: args.cardsToAdd ?? [],
          cardsToRemove: args.cardsToRemove ?? [],
        },
      );
      if (!result.ok) return { ok: false as const, reason: result.reason };
      if (result.data.session) applyServerSession(result.data.session);
      return { ok: true as const, suggestionId: result.data.suggestionId ?? '' };
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession]);

  const acceptSuggestion = useCallback(async (suggestionId: string) => {
    if (!sessionId) return { ok: false };
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/suggestion/${encodeURIComponent(suggestionId)}/accept`,
      );
      if (!result.ok || !result.data.session) return { ok: false };
      applyServerSession(result.data.session);
      return { ok: true };
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession]);

  const dismissSuggestion = useCallback(async (suggestionId: string) => {
    if (!sessionId) return { ok: false };
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/suggestion/${encodeURIComponent(suggestionId)}/dismiss`,
      );
      if (!result.ok || !result.data.session) return { ok: false };
      applyServerSession(result.data.session);
      return { ok: true };
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession]);

  const proposeRevert = useCallback(async (snapshotEventId: string) => {
    if (!sessionId) return { ok: false as const, reason: 'no-session' };
    pollPausedRef.current = true;
    try {
      const result = await apiPost<{ session: SessionView | null; suggestionId: string | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/propose-revert`,
        { snapshotEventId },
      );
      if (!result.ok) return { ok: false as const, reason: result.reason };
      if (result.data.session) applyServerSession(result.data.session);
      return { ok: true as const, suggestionId: result.data.suggestionId ?? '' };
    } finally {
      pollPausedRef.current = false;
    }
  }, [sessionId, applyServerSession]);

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
    markRead,
    suggest,
    acceptSuggestion,
    dismissSuggestion,
    proposeRevert,
  };
}
