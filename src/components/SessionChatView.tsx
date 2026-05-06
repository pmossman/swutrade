import { useEffect, useMemo } from 'react';
import { AppHeader, type BreadcrumbSegment } from './ui/AppHeader';
import { LoadingState, ErrorState } from './ui/states';
import { useAuthContext } from '../contexts/AuthContext';
import { useSession } from '../hooks/useSession';
import { SessionTimelineBody } from './SessionTimelinePanel';

/**
 * Dedicated chat-page route at `/s/<id>/chat`. Used on mobile —
 * desktop continues to render the chat as a side-drawer overlay
 * inside SessionView.
 *
 * Why a separate page on mobile: the overlay was fighting iOS
 * Safari's soft-keyboard layout. After six iterations of CSS
 * positioning + visualViewport tracking, none reliably handled the
 * "input gets focused → keyboard opens → trade canvas peeks through
 * a gap" failure mode. A regular page with a regular text input is
 * iOS Safari's well-trodden happy path; the keyboard layout works
 * because that's what the browser is built for.
 *
 * The page renders `SessionTimelineBody` (the same chrome the
 * desktop overlay uses) inside a normal `min-h-[100dvh]` layout
 * with `AppHeader` at the top. The breadcrumb's "Trade" entry
 * navigates back to `/s/<id>`.
 *
 * This component is mounted directly by `App.tsx` when the route
 * matcher hits `viewMode === 'session-chat'`. It owns its own
 * useSession hook — there's no parent SessionView to pass props
 * down from.
 */
export function SessionChatView({ sessionId }: { sessionId: string }) {
  const auth = useAuthContext();
  const api = useSession(sessionId);
  const { session, status, sendChat, proposeRevert } = api;

  // Lock body scroll while the chat page is mounted. iOS Safari
  // otherwise scrolls the document upward when the textarea gains
  // focus (to "bring it into view"), and after the keyboard closes
  // the scroll doesn't always reset — leaving the AppHeader hidden
  // behind the iPhone notch/status bar. Locking body.overflow keeps
  // the page anchored to the viewport top no matter what iOS does
  // during the keyboard transition.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const counterpartHandle = session?.counterpart?.handle ?? null;
  const breadcrumbs: BreadcrumbSegment[] = useMemo(() => [
    { label: 'Home', href: '/' },
    { label: 'My trades', href: '/?trades=1' },
    {
      label: counterpartHandle ? `Trade with @${counterpartHandle}` : 'Shared trade',
      href: `/s/${encodeURIComponent(sessionId)}`,
    },
    { label: 'Chat' },
  ], [counterpartHandle, sessionId]);

  // `position: fixed; inset: 0` on the outer (NOT just `h-[100dvh]`)
  // because iOS Safari's input-focus-into-view scroll bypasses
  // `body { overflow: hidden }` — it programmatically shifts the
  // layout viewport even when scroll is "locked." A `position: fixed`
  // element is anchored to the viewport regardless of how iOS has
  // shifted things, so the AppHeader stays put across keyboard
  // open/close cycles. (Without this, the header slides behind the
  // iPhone notch when the keyboard closes.)
  //
  // The internal layout (flex-col, flex-1 main, sticky-bottom input)
  // still works the same way because the inner children are normal-flow
  // descendants of the fixed wrapper. Critically: this is the FULL
  // PAGE wrapper, not a child overlay nested inside another page —
  // earlier iterations of `position: fixed` on the chat panel had
  // issues because they were CHILDREN of SessionView's normal-flow
  // tree. Here the chat view IS the page; fixed positioning anchors
  // it to the viewport with no parent-tree quirks.
  //
  // App.tsx skips its outer footer-wrapper when viewMode is
  // 'session-chat' (matches the same special-case for 'trade'), so
  // we don't double-mount AppFooter here either.
  return (
    <div className="fixed inset-0 bg-space-900 text-gray-100 flex flex-col overflow-hidden">
      <AppHeader auth={auth} breadcrumbs={breadcrumbs} />
      <main className="flex-1 min-h-0 flex flex-col">
        {status === 'loading' && !session && (
          <LoadingState centered label="Loading shared trade…" />
        )}
        {status === 'error' && !session && (
          <div className="px-4 py-6">
            <ErrorState>Couldn't load this trade. Try refreshing.</ErrorState>
          </div>
        )}
        {status === 'not-found' && (
          <div className="px-4 py-6">
            <ErrorState>This shared trade doesn't exist or is no longer available.</ErrorState>
          </div>
        )}
        {session && (
          <SessionTimelineBody
            session={session}
            sendChat={sendChat}
            proposeRevert={proposeRevert}
          />
        )}
      </main>
    </div>
  );
}
