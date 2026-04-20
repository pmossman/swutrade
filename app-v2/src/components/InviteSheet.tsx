import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Sheet } from './primitives/Sheet';
import { apiPost, ApiError } from '../lib/fetchClient';

interface InviteSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  /** If true, the invite-by-handle form renders. Ghost creators have
   *  no Discord identity to originate a DM from, so the server rejects
   *  with 403 — we hide the form to match. */
  canInviteByHandle: boolean;
}

/*
 * Design §4.3 + §4.2. The invite surface while a session has an open
 * slot. Scanner-friendly QR (192px white background for dark-mode
 * viewports), copy-URL action, and for non-ghost creators the
 * invite-by-handle Discord DM form.
 */
export function InviteSheet({
  open,
  onOpenChange,
  sessionId,
  canInviteByHandle,
}: InviteSheetProps) {
  const [copied, setCopied] = useState(false);
  const [handle, setHandle] = useState('');
  const [inviteState, setInviteState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const url =
    typeof window !== 'undefined'
      ? `${window.location.origin}/s/${sessionId}`
      : `/s/${sessionId}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available — user can select the URL manually */
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const clean = handle.trim().replace(/^@/, '');
    if (!clean) return;
    setInviteState({ kind: 'sending' });
    try {
      await apiPost(`/api/sessions/${sessionId}/invite-handle`, { handle: clean });
      setInviteState({ kind: 'sent' });
      setHandle('');
    } catch (err) {
      const message =
        err instanceof ApiError && err.reason === 'not-found'
          ? `No SWUTrade user with that handle`
          : err instanceof ApiError && err.reason === 'rate-limited'
            ? `Already invited in the last 10 minutes`
            : `Couldn't send the invite. Try again.`;
      setInviteState({ kind: 'error', message });
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Invite to this trade" snap="full">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-white p-4">
            <QRCodeSVG value={url} size={192} level="M" />
          </div>
          <p className="text-center text-[length:var(--text-meta)] text-fg-muted">
            Point their camera here.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-meta)] text-fg-muted">
              {url}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="h-9 rounded-lg border border-border bg-bg px-3 text-[length:var(--text-meta)] font-semibold text-fg hover:bg-border/30"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {canInviteByHandle ? (
          <form onSubmit={handleInvite} className="flex flex-col gap-2">
            <label
              htmlFor="invite-handle"
              className="text-[length:var(--text-meta)] font-semibold uppercase tracking-wide text-fg-muted"
            >
              Or invite by handle
            </label>
            <div className="flex gap-2">
              <input
                id="invite-handle"
                type="text"
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={handle}
                onChange={(e) => {
                  setHandle(e.target.value);
                  setInviteState({ kind: 'idle' });
                }}
                placeholder="@their-handle"
                className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 text-[length:var(--text-body)] text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={!handle.trim() || inviteState.kind === 'sending'}
                className="h-11 rounded-xl bg-accent px-4 font-semibold text-accent-fg disabled:opacity-60"
              >
                {inviteState.kind === 'sending' ? 'Sending…' : 'Invite'}
              </button>
            </div>
            {inviteState.kind === 'sent' ? (
              <p className="text-[length:var(--text-meta)] text-state-settled">
                We messaged them on Discord with the link.
              </p>
            ) : null}
            {inviteState.kind === 'error' ? (
              <p className="text-[length:var(--text-meta)] text-danger">
                {inviteState.message}
              </p>
            ) : null}
          </form>
        ) : (
          <p className="text-[length:var(--text-meta)] text-fg-muted">
            Sign in with Discord to also invite someone by handle.
          </p>
        )}
      </div>
    </Sheet>
  );
}
