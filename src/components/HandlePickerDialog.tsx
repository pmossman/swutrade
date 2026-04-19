import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommunityMembers, type CommunityMember } from '../hooks/useCommunityMembers';

interface HandlePickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the picked handle (no `@`). Caller navigates to the
   *  composer using this handle. */
  onPick: (handle: string) => void;
}

/** Cap the suggestions list so it never crowds the panel on mobile —
 *  the free-form typing input handles the long-tail case. */
const MAX_SUGGESTIONS = 8;

/**
 * Modal for the Home "Propose a trade" action. Two paths to the
 * composer:
 *
 *   1) type a handle directly (e.g. a friend who isn't in any of your
 *      enrolled Discord guilds yet — valid because handles are the
 *      canonical SWUTrade identity, not gated by community overlap).
 *   2) pick from the viewer's community directory — members of the
 *      mutual guilds they're already enrolled in.
 *
 * Deliberately mirrors NudgeDialog's plain-overlay look: fixed
 * inset-0 bg-black/70, centered `max-w-md` panel, Escape + click
 * outside to close. No Radix — keeps the single-purpose surface
 * cheap and the dependency surface unchanged.
 */
export function HandlePickerDialog({ open, onClose, onPick }: HandlePickerDialogProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Pull the community directory only while the dialog is mounted.
  // `useCommunityMembers` runs fetch on mount — if we gated the hook
  // call on `open`, React would violate rules-of-hooks. Instead the
  // hook fires once the component mounts (we already early-return
  // when `!open`, so it stays inert until the dialog actually opens).
  const { members, status } = useCommunityMembers();

  // Reset transient input every time the dialog opens so yesterday's
  // "@ja…" doesn't ghost in.
  useEffect(() => {
    if (open) {
      setQuery('');
      // Defer autofocus until after the panel paints — mobile
      // Safari otherwise ignores focus on a freshly-mounted input.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

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

  if (!open) return null;

  const canSubmit = trimmedHandle.length > 0;
  const handleSubmit = () => {
    if (!canSubmit) return;
    onPick(trimmedHandle);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="handle-picker-title"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-xl bg-space-900 border border-space-700 p-5 shadow-xl"
        tabIndex={-1}
      >
        <h2 id="handle-picker-title" className="text-sm font-bold text-gray-100 mb-1">
          Propose a trade to…
        </h2>
        <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
          Pick someone from your communities or type their SWUTrade handle.
        </p>

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
                handleSubmit();
              }
            }}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="handle"
            className="w-full bg-space-800/60 border border-space-700 rounded-md pl-7 pr-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-gold/50 focus:outline-none"
          />
        </div>

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
            <div className="text-[11px] text-gray-500 px-1 py-2 leading-relaxed">
              You're not in any shared Discord communities yet — type a handle above to send a proposal to anyone on SWUTrade.
            </div>
          )}
          {status === 'ready' && members.length > 0 && suggestions.length === 0 && (
            <div className="text-[11px] text-gray-500 px-1 py-2">
              No matches in your communities. Press <span className="text-gray-300 font-medium">Go</span> to send to @{trimmedHandle || '…'} anyway.
            </div>
          )}
          {suggestions.length > 0 && (
            <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {suggestions.map(m => (
                <li key={m.userId}>
                  <button
                    type="button"
                    onClick={() => onPick(m.handle)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg bg-space-800/30 border border-space-700 hover:border-gold/40 hover:bg-space-800/60 transition-colors text-left"
                  >
                    <SuggestionAvatar avatarUrl={m.avatarUrl} name={m.username || m.handle} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-gray-100 truncate">
                        @{m.handle}
                      </div>
                      {m.username && m.username !== m.handle && (
                        <div className="text-[11px] text-gray-500 truncate">
                          {m.username}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-medium text-gray-300 hover:text-gold transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 h-9 rounded-lg bg-gold text-space-900 font-bold text-xs hover:bg-gold-bright transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Go
          </button>
        </div>
      </div>
    </div>
  );
}

function SuggestionAvatar({ avatarUrl, name }: { avatarUrl: string | null; name: string }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="w-8 h-8 rounded-full shrink-0" />;
  }
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="w-8 h-8 rounded-full bg-space-700 text-gold font-bold flex items-center justify-center shrink-0 text-xs"
    >
      {initial}
    </span>
  );
}
