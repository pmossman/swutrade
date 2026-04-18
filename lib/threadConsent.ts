/**
 * Four-state consent model for whether a trade proposal's Discord
 * conversation lives in a private thread (both traders inside) or
 * in per-user DMs.
 *
 *   - prefer        Wants threads by default when the counterpart
 *                   is also opted in.
 *   - auto-accept   DM first; auto-approves any thread request from
 *                   the counterpart.
 *   - allow         DM first; approves/declines thread requests
 *                   manually via button. Default for new users.
 *   - dm-only       Refuses threads entirely. No "Request thread"
 *                   button is surfaced on their DM.
 *
 * The decision matrix below is the single source of truth for how
 * a proposer+recipient pair's prefs combine to route a new proposal.
 */

export type CommunicationPref = 'prefer' | 'auto-accept' | 'allow' | 'dm-only';

export type ProposalDelivery =
  /** Both sides opted in; skip the negotiation and create the thread
   *  up front. */
  | 'thread-immediately'
  /** DM first; include a "Request thread" button so either side can
   *  kick off the mutual-approval flow. */
  | 'dm-with-request'
  /** DM only; at least one side has refused threads. No request
   *  button. */
  | 'dm-only';

/**
 * Given a proposer and recipient's communication_pref values, decide
 * the delivery path for the proposal.
 *
 * The rules:
 *   1. If EITHER side is `dm-only`, force DM-only (no button).
 *   2. If both sides are in the "thread-positive" set (prefer or
 *      auto-accept), start the thread immediately. Either's `prefer`
 *      combined with the other's `auto-accept` is enough.
 *   3. Otherwise, DM with the Request button available to either
 *      side.
 *
 * `allow` on both sides is the default-default: neither has opted
 * out, neither has pre-consented, so a thread requires explicit
 * runtime request + approval.
 */
export function deliveryForPair(
  proposer: CommunicationPref,
  recipient: CommunicationPref,
): ProposalDelivery {
  if (proposer === 'dm-only' || recipient === 'dm-only') {
    return 'dm-only';
  }
  const threadPositive = (p: CommunicationPref) =>
    p === 'prefer' || p === 'auto-accept';
  if (threadPositive(proposer) && threadPositive(recipient)) {
    return 'thread-immediately';
  }
  return 'dm-with-request';
}

/**
 * When a thread request lands, the counterpart's pref determines how
 * the request is handled:
 *   - prefer       Auto-approve (should've started threaded; still
 *                  honors the request).
 *   - auto-accept  Auto-approve (the whole point of the pref).
 *   - allow        Manual decision — bot DMs them with Approve/
 *                  Decline buttons.
 *   - dm-only      Auto-decline (defensive; the button shouldn't
 *                  have been offered, but pref may have changed
 *                  mid-flight).
 */
export type ThreadRequestOutcome = 'auto-approve' | 'manual-decide' | 'auto-decline';

export function handleThreadRequest(counterpart: CommunicationPref): ThreadRequestOutcome {
  switch (counterpart) {
    case 'prefer':
    case 'auto-accept':
      return 'auto-approve';
    case 'allow':
      return 'manual-decide';
    case 'dm-only':
      return 'auto-decline';
  }
}
