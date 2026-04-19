/**
 * Shared accept/decline logic for trade proposals.
 *
 * Both the Discord button handler (`api/bot.ts::handleTradeProposalButton`)
 * and the web endpoints (`api/trades.ts::handleAcceptDecline`) call through
 * here so the state transition, event log, and Discord side effects stay
 * in one place. Keeping the logic shared avoids drift — e.g., a proposer
 * notification that only fires when the recipient clicks in Discord, or
 * an event row that only lands for the web path.
 *
 * Callers render their own native response shape (UPDATE_MESSAGE for
 * Discord, JSON for web); this function returns a structured outcome
 * they map to that shape.
 */
import { and, eq } from 'drizzle-orm';
import type { getDb } from './db.js';
import { tradeProposals, users } from './schema.js';
import { createDiscordBotClient, type DiscordBotClient } from './discordBot.js';
import {
  buildResolvedProposalMessage,
  buildProposerNotification,
} from './proposalMessages.js';
import { recordEvent } from './proposalEvents.js';
import { reportError } from './errorReporter.js';

type Db = ReturnType<typeof getDb>;

export interface ResolveDeps {
  db: Db;
  bot?: DiscordBotClient;
}

export interface ResolveResult {
  status: 'ok' | 'already-resolved' | 'not-found';
  trade?: { id: string; status: 'accepted' | 'declined' };
}

/**
 * Transition a pending proposal to accepted or declined on behalf of
 * the recipient. Shared between the Discord button handler and the web
 * endpoints.
 *
 * Semantics:
 *   1. Proposal must exist AND the actor must be the recipient — any
 *      other combination returns `'not-found'` to avoid leaking
 *      existence of proposals to non-parties.
 *   2. Only `pending` proposals can transition — already-resolved
 *      (accepted / declined / cancelled / countered) returns
 *      `'already-resolved'` without firing side effects.
 *   3. Optimistic-concurrency on the UPDATE so a racing click/API call
 *      doesn't double-fire side effects.
 *   4. Records a `proposalEvents` row with `type` = new status.
 *   5. Best-effort Discord side effects: edit the recipient's original
 *      DM/thread message in place (strips buttons, shows the outcome
 *      banner) and DM the proposer a concise notification.
 *
 * Discord failures are swallowed + `reportError`'d; they never fail the
 * primary transition — the DB is authoritative, Discord is transport.
 */
export async function resolveProposal(opts: {
  proposalId: string;
  actorUserId: string;
  newStatus: 'accepted' | 'declined';
  deps: ResolveDeps;
}): Promise<ResolveResult> {
  const { proposalId, actorUserId, newStatus, deps } = opts;
  const { db } = deps;

  const [trade] = await db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.id, proposalId))
    .limit(1);
  // Collapse "not found" and "not your proposal" into the same outcome
  // — callers 404 both. Proposals are private data; the existence of a
  // given id shouldn't be probeable by a non-party.
  if (!trade || trade.recipientUserId !== actorUserId) {
    return { status: 'not-found' };
  }
  if (trade.status !== 'pending') {
    return { status: 'already-resolved' };
  }

  // Optimistic concurrency: transition only where status is still
  // pending. If a racing button click or duplicate request got here
  // first, this returns 0 rows and we treat the race as
  // already-resolved.
  const updated = await db
    .update(tradeProposals)
    .set({
      status: newStatus,
      respondedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(tradeProposals.id, proposalId),
      eq(tradeProposals.status, 'pending'),
    ))
    .returning({ id: tradeProposals.id });
  if (updated.length === 0) {
    return { status: 'already-resolved' };
  }

  await recordEvent(db, {
    proposalId,
    actorUserId,
    type: newStatus,
  });

  // Discord side effects from here on are best-effort. The DB state
  // change has committed; at worst Discord stays stale until someone
  // refreshes the channel.
  const [recipient] = await db
    .select({ id: users.id, discordId: users.discordId, handle: users.handle, username: users.username })
    .from(users)
    .where(eq(users.id, trade.recipientUserId))
    .limit(1);
  const [proposer] = await db
    .select({ id: users.id, discordId: users.discordId, handle: users.handle, username: users.username })
    .from(users)
    .where(eq(users.id, trade.proposerUserId))
    .limit(1);

  if (recipient && proposer) {
    const bot = deps.bot ?? createDiscordBotClient();
    const proposalCtx = {
      tradeId: trade.id,
      proposerUserId: proposer.id,
      proposerHandle: proposer.handle,
      proposerUsername: proposer.username,
      offeringCards: trade.offeringCards,
      receivingCards: trade.receivingCards,
      message: trade.message,
    };

    // 1) Edit the recipient's original proposal DM/thread message in
    //    place — strips the action row + shows the outcome banner so
    //    a stale button can't be clicked a second time. Only if we
    //    actually have a message id to edit (DM path always does; a
    //    few legacy rows might not).
    if (trade.discordDmChannelId && trade.discordDmMessageId) {
      try {
        const patched = buildResolvedProposalMessage(
          proposalCtx,
          newStatus,
          recipient.handle,
        );
        await bot.editChannelMessage(
          trade.discordDmChannelId,
          trade.discordDmMessageId,
          patched,
        );
      } catch (err) {
        console.error('resolveProposal: edit original message failed', err);
        await reportError({
          source: 'proposal.resolve.edit-original',
          tags: { tradeId: proposalId, outcome: newStatus },
        }, err);
      }
    }

    // 2) DM the proposer a concise notification with the outcome.
    try {
      const notifyBody = buildProposerNotification({
        tradeId: trade.id,
        recipientHandle: recipient.handle,
        outcome: newStatus,
      });
      await bot.sendDirectMessage(proposer.discordId, notifyBody);
    } catch (err) {
      console.error('resolveProposal: proposer notify failed', err);
      await reportError({
        source: 'proposal.resolve.proposer-notify',
        tags: { tradeId: proposalId, proposerId: proposer.id, recipientId: recipient.id, outcome: newStatus },
      }, err);
    }
  }

  return { status: 'ok', trade: { id: proposalId, status: newStatus } };
}
