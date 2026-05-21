import { describe, it, expect } from 'vitest';
import {
  isTerminal,
  isOpenSlot,
  nextStatus,
  sessionCapabilities,
  type LifecycleAction,
} from '../../lib/sessionLifecycle.js';
import type { SessionStatus } from '../../lib/schema.js';

const NON_ACTIVE: SessionStatus[] = ['settled', 'cancelled', 'expired'];

describe('isTerminal', () => {
  it('is false only for active', () => {
    expect(isTerminal('active')).toBe(false);
    for (const s of NON_ACTIVE) expect(isTerminal(s)).toBe(true);
  });
});

describe('isOpenSlot', () => {
  it('requires active AND null userBId', () => {
    expect(isOpenSlot({ status: 'active', userBId: null })).toBe(true);
    expect(isOpenSlot({ status: 'active', userBId: 'u_b' })).toBe(false);
    for (const s of NON_ACTIVE) {
      expect(isOpenSlot({ status: s, userBId: null })).toBe(false);
    }
  });
});

describe('nextStatus', () => {
  it('returns null for any action against a terminal status', () => {
    const actions: LifecycleAction[] = [
      { kind: 'edit' },
      { kind: 'confirm', bothNowConfirmed: true },
      { kind: 'cancel' },
      { kind: 'expire' },
    ];
    for (const s of NON_ACTIVE) {
      for (const a of actions) expect(nextStatus(s, a)).toBeNull();
    }
  });

  it('confirm: settles only when both confirmations now present', () => {
    expect(nextStatus('active', { kind: 'confirm', bothNowConfirmed: true })).toBe('settled');
    expect(nextStatus('active', { kind: 'confirm', bothNowConfirmed: false })).toBe('active');
  });

  it('cancel and decline both terminate to cancelled', () => {
    expect(nextStatus('active', { kind: 'cancel' })).toBe('cancelled');
    expect(nextStatus('active', { kind: 'decline' })).toBe('cancelled');
  });

  it('expire terminates to expired', () => {
    expect(nextStatus('active', { kind: 'expire' })).toBe('expired');
  });

  it('non-terminating actions keep status active', () => {
    const stayActive: LifecycleAction['kind'][] = [
      'edit',
      'unconfirm',
      'claim',
      'suggest',
      'accept-suggestion',
      'dismiss-suggestion',
      'propose-revert',
      'send-chat',
    ];
    for (const kind of stayActive) {
      expect(nextStatus('active', { kind } as LifecycleAction)).toBe('active');
    }
  });
});

describe('sessionCapabilities', () => {
  const viewer = 'u_viewer';
  const counterpart = 'u_counterpart';

  it('every capability is false on terminal sessions', () => {
    for (const status of NON_ACTIVE) {
      const caps = sessionCapabilities(
        { status, userBId: counterpart, confirmedByUserIds: [] },
        viewer,
      );
      expect(Object.values(caps).every(v => v === false)).toBe(true);
    }
  });

  it('on an active two-party session, viewer has full capability set', () => {
    const caps = sessionCapabilities(
      { status: 'active', userBId: counterpart, confirmedByUserIds: [] },
      viewer,
    );
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

  it('viewer who has confirmed flips canConfirm → canUnconfirm', () => {
    const caps = sessionCapabilities(
      { status: 'active', userBId: counterpart, confirmedByUserIds: [viewer] },
      viewer,
    );
    expect(caps.canConfirm).toBe(false);
    expect(caps.canUnconfirm).toBe(true);
  });

  it('open-slot session: decline / suggest / chat are disabled (no counterpart)', () => {
    const caps = sessionCapabilities(
      { status: 'active', userBId: null, confirmedByUserIds: [] },
      viewer,
    );
    expect(caps.canDecline).toBe(false);
    expect(caps.canSuggest).toBe(false);
    expect(caps.canChat).toBe(false);
    // Editing, confirming, and cancelling remain legal on the
    // originator's side of an open slot.
    expect(caps.canEdit).toBe(true);
    expect(caps.canConfirm).toBe(true);
    expect(caps.canCancel).toBe(true);
  });
});
