import { describe, it, expect } from 'vitest';
import {
  sessionCapabilities,
  isSessionTerminal,
} from './sessionCapabilities';
import type { SessionView, SessionStatus } from '../hooks/useSession';

function fakeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    status: 'active',
    viewer: { userId: 'u1', side: 'a' },
    counterpart: { userId: 'u2', handle: 'them', avatarUrl: null },
    openSlot: false,
    yourCards: [],
    theirCards: [],
    confirmedByViewer: false,
    confirmedByCounterpart: false,
    lastEditedByViewer: false,
    lastEditedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settledAt: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    events: [],
    unreadCount: 0,
    lastReadAt: null,
    suggestions: [],
    awaitingViewer: false,
    cancelReason: null,
    ...overrides,
  } as unknown as SessionView;
}

const TERMINAL: SessionStatus[] = ['settled', 'cancelled', 'expired'];

describe('isSessionTerminal', () => {
  it('is true for non-active statuses only', () => {
    expect(isSessionTerminal(fakeSession({ status: 'active' }))).toBe(false);
    for (const s of TERMINAL) {
      expect(isSessionTerminal(fakeSession({ status: s }))).toBe(true);
    }
  });
});

describe('sessionCapabilities', () => {
  it('all capabilities false on terminal sessions', () => {
    for (const status of TERMINAL) {
      const caps = sessionCapabilities(fakeSession({ status }));
      expect(Object.values(caps).every(v => v === false)).toBe(true);
    }
  });

  it('full capability set on active two-party session, viewer not yet confirmed', () => {
    const caps = sessionCapabilities(fakeSession());
    expect(caps).toEqual({
      canEdit: true,
      canConfirm: true,
      canUnconfirm: false,
      canCancel: true,
      canDecline: true,
      canSuggest: true,
      canChat: true,
    });
  });

  it('viewer confirmed flips canConfirm → canUnconfirm', () => {
    const caps = sessionCapabilities(fakeSession({ confirmedByViewer: true }));
    expect(caps.canConfirm).toBe(false);
    expect(caps.canUnconfirm).toBe(true);
  });

  it('open-slot session disables decline / suggest / chat', () => {
    const caps = sessionCapabilities(
      fakeSession({ openSlot: true, counterpart: null }),
    );
    expect(caps.canDecline).toBe(false);
    expect(caps.canSuggest).toBe(false);
    expect(caps.canChat).toBe(false);
    expect(caps.canEdit).toBe(true);
    expect(caps.canConfirm).toBe(true);
    expect(caps.canCancel).toBe(true);
  });
});
