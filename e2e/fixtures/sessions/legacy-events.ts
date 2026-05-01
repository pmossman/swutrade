import type { SessionFixture } from '../../helpers/session-seed';

/**
 * "Legacy events" fixture — exercises the timeline panel's fallback
 * paths for edited events that pre-date the diff-payload + snapshot-
 * pairing enrichments. A regression here would be the kind of bug
 * that breaks a long-lived session whose events were recorded under
 * an older schema generation.
 *
 * Coverage points:
 *   - Modern edited event (payload.added / payload.removed / payload.snapshotEventId)
 *   - Legacy edited event with payload = { side } only — falls through
 *     to summarizeStructuredEvent's one-liner.
 *   - Truly null-payload edited event — must not crash the renderer.
 *
 * The session row itself uses the current schema (no point in faking
 * pre-pendingSuggestions sessions; Drizzle's default IS `[]`).
 */
export function legacyEventsFixture(args: {
  userAId: string;
  userBId: string;
  sessionId: string;
}): SessionFixture {
  const { userAId, userBId, sessionId } = args;
  const luke = {
    productId: '617159',
    name: 'Luke Skywalker - Hero of Yavin',
    variant: 'Standard',
    qty: 1,
    unitPrice: 0,
  };

  return {
    name: 'Legacy timeline events',
    generation: 'pre-diff-payload + pre-snapshot-pairing',
    session: {
      id: sessionId,
      userAId,
      userBId,
      userACards: [luke],
      userBCards: [],
      status: 'active',
    },
    events: [
      // 1. Truly null-payload edited event (oldest schema generation —
      //    we used to record nothing in payload).
      {
        type: 'edited',
        actorUserId: userAId,
        payload: null,
        createdAt: new Date(Date.now() - 60_000 * 30), // 30 min ago
      },
      // 2. Legacy edited event with payload = { side } only.
      {
        type: 'edited',
        actorUserId: userBId,
        payload: { side: 'b' },
        createdAt: new Date(Date.now() - 60_000 * 15), // 15 min ago
      },
      // 3. Modern edited event with the full diff payload + snapshot
      //    pairing. The matching edit-snapshot row is not seeded —
      //    proposeRevert would fail, but the timeline render path
      //    doesn't depend on that.
      {
        type: 'edited',
        actorUserId: userAId,
        payload: {
          side: 'a',
          added: [luke],
          removed: [],
          snapshotEventId: `${sessionId}-snap-3`,
        },
        createdAt: new Date(Date.now() - 60_000 * 5), // 5 min ago
      },
      // 4. A chat event sandwiched in — proves the timeline interleaves
      //    edited and chat events in chronological order.
      {
        type: 'chat',
        actorUserId: userBId,
        payload: { body: 'hey from the legacy past' },
        createdAt: new Date(Date.now() - 60_000 * 2), // 2 min ago
      },
    ],
  };
}
