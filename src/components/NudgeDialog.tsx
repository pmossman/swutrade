import { useEffect, useState } from 'react';
import type { ActionResult } from '../services/tradeActions';
import { ErrorState } from './ui/states';

interface NudgeDialogProps {
  open: boolean;
  recipientHandle: string;
  onClose: () => void;
  onNudge: (note?: string) => Promise<ActionResult<{ id: string; nudgedAt: string }>>;
}

/**
 * Modal for proposers to nudge a pending proposal. Optional 280-char
 * note rides along in the re-posted Discord embed. Rate-limited server-
 * side to 1 nudge per 24h — the 429 response surfaces here as an
 * inline "tried too recently, try again after …" message rather than
 * a generic error.
 *
 * Intentionally lightweight — plain absolute-positioned overlay with a
 * focus-trapping `tabIndex={-1}` on the panel. No Radix dialog to
 * avoid dragging a dependency in for what's essentially "textarea +
 * two buttons".
 */
export function NudgeDialog({ open, recipientHandle, onClose, onNudge }: NudgeDialogProps) {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<string | null>(null);

  // Reset transient state every time the dialog opens so the previous
  // session's note / error doesn't ghost in.
  useEffect(() => {
    if (open) {
      setNote('');
      setSending(false);
      setErrorMessage(null);
      setCooldownUntil(null);
    }
  }, [open]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, sending, onClose]);

  if (!open) return null;

  const handleSend = async () => {
    setSending(true);
    setErrorMessage(null);
    setCooldownUntil(null);
    const trimmed = note.trim();
    const result = await onNudge(trimmed.length > 0 ? trimmed : undefined);
    setSending(false);
    if (result.ok) {
      onClose();
      return;
    }
    if (result.reason === 'rate-limited') {
      setCooldownUntil(result.nextAvailableAt ?? null);
      setErrorMessage(result.detail ?? 'You nudged this recently — try again later.');
      return;
    }
    if (result.reason === 'already-resolved') {
      setErrorMessage('This proposal was just resolved — reload the page.');
      return;
    }
    setErrorMessage(result.detail ?? 'Couldn\'t send the nudge. Try again in a moment.');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="nudge-title"
      onClick={e => { if (e.target === e.currentTarget && !sending) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-xl bg-space-900 border border-space-700 p-5 shadow-xl"
        tabIndex={-1}
      >
        <h2 id="nudge-title" className="text-sm font-bold text-gray-100 mb-1">
          Nudge @{recipientHandle}
        </h2>
        <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
          Re-pings the proposal in Discord so it surfaces at the top of their DMs or
          thread. You can attach an optional note — keep it short. Limited to one
          nudge per 24 hours per trade.
        </p>

        <label htmlFor="nudge-note" className="sr-only">Note</label>
        <textarea
          id="nudge-note"
          value={note}
          onChange={e => setNote(e.target.value.slice(0, 280))}
          disabled={sending}
          placeholder="Still interested? I'll be at the LGS on Saturday…"
          rows={3}
          maxLength={280}
          className="w-full bg-space-800/60 border border-space-700 rounded-md px-3 py-2 text-xs text-gray-100 placeholder-gray-500 resize-y min-h-[72px] focus:border-gold/50 focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center justify-between mt-1 text-[10px] text-gray-500">
          <span>{note.trim().length}/280</span>
        </div>

        {errorMessage && (
          <ErrorState variant="line" className="mt-3">
            {errorMessage}
            {cooldownUntil && (
              <div className="mt-0.5 text-red-400/80">
                Try again after {new Date(cooldownUntil).toLocaleString()}.
              </div>
            )}
          </ErrorState>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-medium text-gray-300 hover:text-gold transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={sending}
            className="px-4 h-9 rounded-lg bg-gold text-space-900 font-bold text-xs hover:bg-gold-bright transition-colors disabled:opacity-60 disabled:cursor-wait"
          >
            {sending ? 'Sending…' : 'Send nudge'}
          </button>
        </div>
      </div>
    </div>
  );
}
