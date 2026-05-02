import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCommunityMembers, type CommunityMember } from '../hooks/useCommunityMembers';
import { useRecentPartners, type RecentPartner } from '../hooks/useRecentPartners';
import { useFavorites, type Favorite } from '../hooks/useFavorites';
import { apiGet, apiPost } from '../services/apiClient';
import { useAuthContext } from '../contexts/AuthContext';
import { useNavigation } from '../contexts/NavigationContext';

interface HandlePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the picked handle (no `@`). Caller navigates to the
   *  `/?propose=<handle>` composer. Legacy proposal flow. */
  onPick: (handle: string) => void;
}

/** Cap the suggestions list so it never crowds the panel on mobile —
 *  the free-form typing input handles the long-tail case. */
const MAX_SUGGESTIONS = 8;
const MAX_RECENT_CHIPS = 5;

/**
 * Modal for the "Propose a trade" action. Three paths to the composer:
 *
 *   1) Recent chips — up to five recent trade partners, one tap each.
 *   2) Type a handle directly. Validated on submit against
 *      `/api/user/:handle` so an unknown handle surfaces an inline
 *      error instead of bouncing the user into a broken composer.
 *   3) Pick from the viewer's community directory (members of the
 *      mutual Discord guilds they're enrolled in).
 *
 * Migrated from a hand-rolled `role="dialog"` shell to Radix's
 * `Dialog.Root` to gain focus-trap, focus-restore, scroll-lock,
 * `inert` siblings, and ESC handling for free. Audit
 * 10-ux-primitives.md #3.
 */
export function HandlePickerDialog({ open, onClose, onPick }: HandlePickerDialogProps) {
  const nav = useNavigation();
  const auth = useAuthContext();
  // Favorites are signed-in-only; the hook internally short-circuits
  // for ghosts. Dialog gate (`!open`) also prevents fetching on
  // unrelated surfaces. Reading it whether or not it populates lets
  // the star-toggle on suggestion rows act uniformly.
  const favoritesApi = useFavorites(!!auth.user && !auth.user.isAnonymous && open);
  const [query, setQuery] = useState('');
  const [validation, setValidation] = useState<
    | { kind: 'idle' }
    | { kind: 'checking'; handle: string }
    | { kind: 'error'; handle: string; reason: 'not-found' | 'request-failed' }
  >({ kind: 'idle' });
  const [startingSession, setStartingSession] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Pull the community directory + recent partners only while the
  // dialog is mounted. Both hooks run fetch on mount — we already
  // early-return when `!open`, so they stay inert until the dialog
  // actually opens.
  const { members, status } = useCommunityMembers();
  const { partners: recentPartners, status: recentStatus } = useRecentPartners();

  // Reset transient input every time the dialog opens so yesterday's
  // "@ja…" doesn't ghost in. Radix's onOpenAutoFocus is suppressed
  // below so we can focus the input directly here, matching the prior
  // mobile-Safari-friendly setTimeout(0) approach.
  useEffect(() => {
    if (open) {
      setQuery('');
      setValidation({ kind: 'idle' });
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Clear validation error as the user keeps typing — the handle has
  // changed, the stale "no such user" message shouldn't linger.
  useEffect(() => {
    if (validation.kind === 'error') setValidation({ kind: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Normalise the typed handle: strip a leading `@` (users type them
  // reflexively) and trim whitespace. Everything downstream wants
  // the bare handle.
  const trimmedHandle = useMemo(() => query.trim().replace(/^@+/, ''), [query]);

  const suggestions = useMemo<CommunityMember[]>(() => {
    if (members.length === 0) return [];
    const needle = trimmedHandle.toLowerCase();
    if (!needle) return members.slice(0, MAX_SUGGESTIONS);
    return members
      .filter(m =>
        m.handle.toLowerCase().includes(needle) ||
        m.username.toLowerCase().includes(needle),
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [members, trimmedHandle]);

  // Recent chips: only surface when the user hasn't started typing.
  // Once they're searching, the in-community suggestions filter below
  // does the work and stacking another list feels cluttered.
  const showRecent = query.length === 0
    && recentStatus === 'ready'
    && recentPartners.length > 0;
  const showFavorites = query.length === 0
    && favoritesApi.status === 'ready'
    && favoritesApi.favorites.length > 0;

  // Dedupe the Recent row against Favorites — a user who's both
  // favorited and recently traded shouldn't show up in both sections.
  // Favorites are the stronger signal (explicit), so keep them in
  // Favorites and drop from Recent.
  const dedupedRecents = useMemo<RecentPartner[]>(() => {
    const favHandles = new Set(
      favoritesApi.favorites.map(f => f.handle.toLowerCase()),
    );
    return recentPartners.filter(p => !favHandles.has(p.handle.toLowerCase()));
  }, [recentPartners, favoritesApi.favorites]);

  const canSubmit = trimmedHandle.length > 0 && validation.kind !== 'checking';

  // Shortcut: if the typed handle exactly matches a member in the
  // community directory (case-insensitive), skip validation and pick
  // immediately — we already know it exists.
  function isKnownHandle(handle: string): boolean {
    const lower = handle.toLowerCase();
    if (members.some(m => m.handle.toLowerCase() === lower)) return true;
    if (recentPartners.some(p => p.handle.toLowerCase() === lower)) return true;
    return false;
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    if (isKnownHandle(trimmedHandle)) {
      onPick(trimmedHandle);
      return;
    }
    setValidation({ kind: 'checking', handle: trimmedHandle });
    const result = await apiGet<{ user: { handle: string } }>(
      `/api/user/${encodeURIComponent(trimmedHandle)}`,
    );
    if (!result.ok) {
      setValidation({
        kind: 'error',
        handle: trimmedHandle,
        reason: result.reason === 'not-found' ? 'not-found' : 'request-failed',
      });
      return;
    }
    onPick(result.data.user.handle);
  }

  /**
   * Start-shared-trade path — POSTs /api/sessions/create and
   * navigates to `/s/<id>`. If an active session already exists
   * between this pair, the server returns the existing id and we
   * jump into it (the pair-uniqueness redirect). Uses the handle
   * from the input; validation + known-handle shortcut mirror the
   * propose path so the UX feels symmetric.
   */
  async function handleStartSession() {
    if (!canSubmit || startingSession) return;
    setStartingSession(true);
    try {
      // Validate first when the handle isn't already in a source we
      // trust — same policy as Propose.
      let handleToUse = trimmedHandle;
      if (!isKnownHandle(handleToUse)) {
        setValidation({ kind: 'checking', handle: handleToUse });
        const check = await apiGet<{ user: { handle: string } }>(
          `/api/user/${encodeURIComponent(handleToUse)}`,
        );
        if (!check.ok) {
          setValidation({
            kind: 'error',
            handle: handleToUse,
            reason: check.reason === 'not-found' ? 'not-found' : 'request-failed',
          });
          return;
        }
        handleToUse = check.data.user.handle;
      }
      const result = await apiPost<{ id: string; created: boolean }>(
        '/api/sessions/create',
        { counterpartHandle: handleToUse, initialCards: [] },
      );
      if (!result.ok) {
        setValidation({
          kind: 'error',
          handle: handleToUse,
          reason: 'request-failed',
        });
        return;
      }
      nav.toSession(result.data.id);
    } finally {
      setStartingSession(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={e => {
            // Skip Radix's default focus so our setTimeout-based
            // autofocus on inputRef can grab focus cleanly (avoids a
            // mobile-Safari ignore-on-fresh-mount bug).
            e.preventDefault();
          }}
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100vw-2rem)] max-w-md rounded-xl bg-space-900 border border-space-700 p-5 shadow-xl"
        >
        <Dialog.Title className="text-sm font-bold text-gray-100 mb-1">
          Trade with…
        </Dialog.Title>
        <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
          Pick someone, then choose to send a formal proposal or start a shared trade you can edit together.
        </p>

        {showFavorites && (
          <section aria-labelledby="handle-picker-favorites" className="mb-3">
            <h3
              id="handle-picker-favorites"
              className="text-[10px] tracking-[0.18em] uppercase text-gold font-semibold mb-1.5"
            >
              Your trading partners
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {favoritesApi.favorites.slice(0, MAX_RECENT_CHIPS).map(f => (
                <li key={f.userId}>
                  <FavoriteChip favorite={f} onPick={() => onPick(f.handle)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {showRecent && dedupedRecents.length > 0 && (
          <section aria-labelledby="handle-picker-recent" className="mb-3">
            <h3
              id="handle-picker-recent"
              className="text-[10px] tracking-[0.18em] uppercase text-gray-500 font-semibold mb-1.5"
            >
              Recent
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {dedupedRecents.slice(0, MAX_RECENT_CHIPS).map(p => (
                <li key={p.userId}>
                  <RecentChip partner={p} onPick={() => onPick(p.handle)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <label htmlFor="handle-picker-input" className="sr-only">Handle</label>
        <div className="relative">
          {/* Visual `@` prefix — the input itself is controlled and
              strips any leading @ on submit, so users can type it or
              not without consequence. */}
          <span
            aria-hidden
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm font-medium pointer-events-none"
          >
            @
          </span>
          <input
            ref={inputRef}
            id="handle-picker-input"
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="handle"
            aria-invalid={validation.kind === 'error'}
            aria-describedby={validation.kind === 'error' ? 'handle-picker-error' : undefined}
            className="w-full bg-space-800/60 border border-space-700 rounded-md pl-7 pr-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-gold/50 focus:outline-none"
          />
        </div>

        {validation.kind === 'error' && (
          <p id="handle-picker-error" className="mt-2 text-[11px] text-red-300">
            {validation.reason === 'not-found'
              ? <>No SWUTrade user with the handle <span className="font-semibold">@{validation.handle}</span>. Double-check the spelling.</>
              : <>Couldn't verify the handle. Try again in a moment.</>}
          </p>
        )}

        {/* Suggestions: three visual states — loading, empty (viewer has
            no mutual guilds or query filtered everything out), and a
            populated list. Keeps the panel height stable-ish instead of
            collapsing/jumping as the user types. */}
        <div className="mt-3">
          {status === 'loading' && (
            <div className="text-[11px] text-gray-500 px-1 py-2">
              Loading your community…
            </div>
          )}
          {status === 'error' && (
            <div className="text-[11px] text-red-300 px-1 py-2">
              Couldn't load your community directory. You can still type a handle above.
            </div>
          )}
          {status === 'ready' && members.length === 0 && (
            <EmptyCommunityState hasRecent={recentPartners.length > 0} />
          )}
          {/* Suppress the "send anyway" hint while a validation error is
              showing — the two messages contradict each other (the red
              error says "no such user", the hint says "press Go anyway").
              Clearing the error fires as soon as the user edits the input,
              so the hint reappears the moment the guidance is useful. */}
          {status === 'ready' && members.length > 0 && suggestions.length === 0 && validation.kind !== 'error' && (
            <div className="text-[11px] text-gray-500 px-1 py-2">
              No matches in your communities. Press <span className="text-gray-300 font-medium">Go</span> to send to @{trimmedHandle || '…'} anyway.
            </div>
          )}
          {suggestions.length > 0 && (
            <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {suggestions.map(m => (
                <li key={m.userId}>
                  <SuggestionRow
                    member={m}
                    onPick={() => onPick(m.handle)}
                    isFavorite={favoritesApi.isFavorite(m.handle)}
                    // Favoriting is signed-in only — hide the toggle
                    // for ghosts (the hook's `enabled=false` path
                    // leaves `add`/`remove` callable but 401-ing on
                    // the server). Ghosts can still tap-to-pick.
                    favoritable={!!auth.user && !auth.user.isAnonymous}
                    onToggleFavorite={() => {
                      if (favoritesApi.isFavorite(m.handle)) {
                        void favoritesApi.remove(m.handle);
                      } else {
                        void favoritesApi.add(m.handle);
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Dialog.Close asChild>
            <button
              type="button"
              className="px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-medium text-gray-300 hover:text-gold transition-colors"
            >
              Cancel
            </button>
          </Dialog.Close>
          <button
            type="button"
            onClick={() => void handleStartSession()}
            disabled={!canSubmit || startingSession}
            className="px-4 h-9 rounded-lg border border-cyan-500/50 text-cyan-200 hover:border-cyan-400 hover:bg-cyan-950/40 text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Open a shared trade with this person — you can both edit, live or async"
          >
            {startingSession ? 'Starting…' : 'Start shared trade'}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || startingSession}
            className="px-4 h-9 rounded-lg bg-gold text-space-900 font-bold text-xs hover:bg-gold-bright transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Send a formal trade proposal via Discord DM"
          >
            {validation.kind === 'checking' ? 'Checking…' : 'Send proposal'}
          </button>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RecentChip({
  partner,
  onPick,
}: {
  partner: RecentPartner;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-space-800/60 border border-space-700 hover:border-gold/50 hover:bg-space-800 text-[12px] text-gray-200 hover:text-gold transition-colors"
      title={partner.username || partner.handle}
    >
      <SuggestionAvatar avatarUrl={partner.avatarUrl} name={partner.username || partner.handle} size="sm" />
      <span className="font-medium truncate max-w-[10ch]">@{partner.handle}</span>
    </button>
  );
}

/**
 * Gold-toned chip for explicit trading-partner favorites. Rendered
 * above Recent when the viewer has any favorites; one tap jumps
 * straight into the propose composer (same affordance as RecentChip,
 * different colour to convey "you chose this person" vs "you happened
 * to trade with them").
 */
function FavoriteChip({
  favorite,
  onPick,
}: {
  favorite: Favorite;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-gold/10 border border-gold/40 hover:bg-gold/20 hover:border-gold/60 text-[12px] text-gold transition-colors"
      title={favorite.username || favorite.handle}
    >
      <SuggestionAvatar avatarUrl={favorite.avatarUrl} name={favorite.username || favorite.handle} size="sm" />
      <span className="font-medium truncate max-w-[10ch]">@{favorite.handle}</span>
    </button>
  );
}

/**
 * Community-suggestion row with a nested star toggle. The primary
 * (outer) button picks the handle and closes the dialog via `onPick`;
 * the star toggle is a sibling button that stops propagation so the
 * pick doesn't also fire. Favoritable is gated off for ghosts — they
 * can still pick by tapping the identity area.
 */
function SuggestionRow({
  member,
  onPick,
  isFavorite,
  favoritable,
  onToggleFavorite,
}: {
  member: CommunityMember;
  onPick: () => void;
  isFavorite: boolean;
  favoritable: boolean;
  onToggleFavorite: () => void;
}) {
  return (
    <div className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-space-800/30 border border-space-700 hover:border-gold/40 hover:bg-space-800/60 transition-colors">
      <button
        type="button"
        onClick={onPick}
        className="flex items-center gap-3 flex-1 min-w-0 text-left"
      >
        <SuggestionAvatar avatarUrl={member.avatarUrl} name={member.username || member.handle} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-gray-100 truncate">
            @{member.handle}
          </div>
          {member.username && member.username !== member.handle && (
            <div className="text-[11px] text-gray-500 truncate">
              {member.username}
            </div>
          )}
        </div>
      </button>
      {favoritable && (
        <button
          type="button"
          onClick={(e) => {
            // Stop propagation defensively — the parent row is not a
            // button anymore but nested button handlers sometimes
            // bubble in unexpected browsers.
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-pressed={isFavorite}
          aria-label={
            isFavorite
              ? `Remove @${member.handle} from your trading partners`
              : `Add @${member.handle} to your trading partners`
          }
          title={
            isFavorite
              ? 'Remove from trading partners'
              : 'Add to trading partners'
          }
          className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
            isFavorite
              ? 'bg-gold/20 border border-gold/50 text-gold hover:bg-gold/10'
              : 'bg-space-800/40 border border-space-700 text-gray-500 hover:border-gold/40 hover:text-gold'
          }`}
        >
          <svg
            viewBox="0 0 16 16"
            className="w-3.5 h-3.5"
            fill={isFavorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3.5 2.5h9v12l-4.5-3-4.5 3z" />
          </svg>
        </button>
      )}
    </div>
  );
}

function EmptyCommunityState({ hasRecent }: { hasRecent: boolean }) {
  return (
    <div className="mt-1 rounded-lg bg-space-800/40 border border-space-700 px-3 py-3 text-[11px] text-gray-400 leading-relaxed">
      <div className="text-gray-300 font-semibold mb-1">
        {hasRecent
          ? "No community suggestions — your recent partners are above."
          : "You're not in any shared Discord communities yet."}
      </div>
      <div>
        Type a handle above to send a proposal to anyone on SWUTrade.
        To see suggestions here,{' '}
        <a href="/?settings=1&tab=servers" className="text-gold hover:underline font-medium">
          enroll in a Discord server
        </a>
        {' '}that has the bot installed.
      </div>
    </div>
  );
}

function SuggestionAvatar({
  avatarUrl,
  name,
  size = 'md',
}: {
  avatarUrl: string | null;
  name: string;
  size?: 'sm' | 'md';
}) {
  const cls = size === 'sm' ? 'w-5 h-5' : 'w-8 h-8';
  const fontCls = size === 'sm' ? 'text-[10px]' : 'text-xs';
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className={`${cls} rounded-full shrink-0`} />;
  }
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className={`${cls} ${fontCls} rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0`}
    >
      {initial}
    </span>
  );
}
