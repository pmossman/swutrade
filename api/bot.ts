import type { VercelRequest, VercelResponse } from '@vercel/node';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { botInstalledGuilds, tradeProposals, userPeerPrefs, users } from '../lib/schema.js';
import { verifyDiscordSignature } from '../lib/discordSignature.js';
import { createDiscordBotClient, type DiscordBotClient } from '../lib/discordBot.js';
import {
  BUTTON_CUSTOM_ID_PREFIX,
  COMM_PREF_CUSTOM_ID_PREFIX,
  PREF_CUSTOM_ID_PREFIX,
  buildProposalMessage,
  buildResolvedProposalMessage,
  buildCounteredProposalMessage,
  buildProposerNotification,
  buildThreadRequestedProposalMessage,
  buildThreadApprovalRequestMessage,
  buildThreadMovedProposalMessage,
  buildThreadRequestDeclinedMessage,
  buildPrefOptionsMessage,
  buildPrefConfirmationMessage,
  buildPeerPrefOptionsMessage,
  buildPeerPrefConfirmationMessage,
  buildSelfPrefsIndexMessage,
  buildPeerPrefsIndexMessage,
  buildCombinedPrefsMessage,
} from '../lib/proposalMessages.js';
import { handleThreadRequest, type CommunicationPref } from '../lib/threadConsent.js';
import { PREF_DEFINITIONS, getPrefDefinition, validatePrefValue } from '../lib/prefsRegistry.js';
import { resolvePref } from '../lib/prefsResolver.js';

/**
 * Single entry point for Discord's signed webhooks.
 *
 * Discord sends two distinct kinds of signed request:
 *   - HTTP Interactions: slash commands + button/select/modal submits
 *     from inside Discord. Configured at "Interactions Endpoint URL"
 *     in the Developer Portal.
 *   - Event Webhooks: app lifecycle events like APPLICATION_AUTHORIZED
 *     (bot installed / user re-authed). Configured at "Event Webhooks
 *     URL" with an event subscription list.
 *
 * Both require Ed25519 signature verification with the application's
 * public key (DISCORD_APP_PUBLIC_KEY). They share this handler —
 * vercel.json rewrites /api/bot/interactions and /api/bot/events to
 * ?action=interactions and ?action=events respectively so Discord
 * sees two distinct URLs but we only burn one serverless function
 * slot (Hobby plan ceiling is 12 — see project memory).
 *
 * Body handling: @vercel/node pre-parses JSON bodies and does NOT
 * honor the Next.js `config.api.bodyParser = false` convention, so
 * we can't read the raw request stream. Instead we re-serialize
 * `req.body` via JSON.stringify and feed that to the verifier.
 * This works because Discord's signed payloads are compact JSON
 * produced by their server — `JSON.parse` preserves key insertion
 * order in V8, so round-tripping produces byte-identical output.
 */

function canonicalRequestBody(req: VercelRequest): string {
  if (typeof req.body === 'string') return req.body;
  if (req.body == null) return '';
  // Pre-parsed JSON object: round-trip via stringify. Compact
  // (no spaces) matches the format Discord's servers emit.
  return JSON.stringify(req.body);
}

/**
 * Resolve the optional test-only Discord public key, gated by
 * environment. Preview/dev deploys may carry a test keypair so e2e
 * specs can sign synthetic interactions. In production the fallback
 * must be inert regardless of whether the env var is set — a leaked
 * test private key should not become a path to forging real
 * interactions. Exported for the unit test.
 */
export function resolveTestPublicKey(env: {
  VERCEL_ENV?: string;
  DISCORD_APP_PUBLIC_KEY_TEST?: string;
}): string | undefined {
  if (env.VERCEL_ENV === 'production') return undefined;
  return env.DISCORD_APP_PUBLIC_KEY_TEST;
}

// --- Discord interaction constants ------------------------------------------

const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const INTERACTION_TYPE_MESSAGE_COMPONENT = 3;
// Application command types — slash commands are type 1, user-context
// menu commands are type 2, message-context menu commands are type 3.
const APPLICATION_COMMAND_TYPE_SLASH = 1;
const APPLICATION_COMMAND_TYPE_USER = 2;
// Option types inside slash command payloads: SUB_COMMAND = 1, USER = 6.
const OPTION_TYPE_SUB_COMMAND = 1;
const OPTION_TYPE_USER = 6;
const INTERACTION_RESPONSE_TYPE_PONG = 1;
// Type 4 = CHANNEL_MESSAGE_WITH_SOURCE (post a new reply, visible
// to the user who clicked via `flags: 64` ephemeral bit).
const INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
// Type 6 = DEFERRED_UPDATE_MESSAGE (ack w/o visible change).
const INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE = 6;
// Type 7 = UPDATE_MESSAGE (update the message that had the button).
const INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE = 7;
const MESSAGE_FLAG_EPHEMERAL = 64;

// --- dispatcher -------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const publicKey = process.env.DISCORD_APP_PUBLIC_KEY;
  if (!publicKey) {
    console.error('DISCORD_APP_PUBLIC_KEY not set — bot endpoints cannot verify signatures');
    return res.status(500).json({ error: 'Bot not configured' });
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (typeof signature !== 'string' || typeof timestamp !== 'string') {
    return res.status(401).json({ error: 'Missing signature headers' });
  }

  const rawBody = canonicalRequestBody(req);
  const verified = verifyDiscordSignature({
    signature,
    timestamp,
    body: rawBody,
    publicKeyHex: publicKey,
  });
  // Optional fallback: a test-only public key lets e2e specs on
  // Preview deploys sign interactions with a known test keypair
  // and exercise the full signature-verify + dispatch path without
  // needing a real human click in Discord. `resolveTestPublicKey`
  // hard-gates this to non-production environments, so even if the
  // env var is present on Production it stays inert.
  const testPublicKey = resolveTestPublicKey(process.env);
  const verifiedWithTestKey = !verified && testPublicKey
    ? verifyDiscordSignature({ signature, timestamp, body: rawBody, publicKeyHex: testPublicKey })
    : false;
  if (!verified && !verifiedWithTestKey) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const action = (req.query.action as string | undefined) ?? '';
  // Derive the site's public origin from the request so deep-links
  // (e.g., `/?counter=<id>` returned when a user clicks Counter in
  // their DM) route back to whichever deployment served the DM.
  // Falls back to an env var if the header is missing.
  const originFromReq = req.headers.host
    ? `https://${req.headers.host}`
    : process.env.SWUTRADE_PUBLIC_URL ?? 'https://beta.swutrade.com';
  return dispatchBotPayload(action, parsed, res, { origin: originFromReq });
}

export interface BotDeps {
  bot?: DiscordBotClient;
  /** Absolute origin (scheme + host) used for deep-links embedded
   *  in interaction responses. Supplied by the top-level handler. */
  origin?: string;
}

/**
 * Post-signature-verification dispatch. Exported for integration
 * tests so they can invoke the handler logic with pre-parsed
 * payloads and skip the raw-body-stream + signature-verify layers
 * (those are unit-tested separately in discord-signature.test.ts).
 *
 * `deps.bot` is injectable for the same reason: the button handler
 * PATCHes Discord + sends follow-up DMs; tests swap in a fake.
 */
export async function dispatchBotPayload(
  action: string,
  payload: Record<string, unknown>,
  res: VercelResponse,
  deps: BotDeps = {},
): Promise<void> {
  switch (action) {
    case 'interactions': return handleInteraction(payload, res, deps);
    case 'events':       return handleEvent(payload, res, deps);
    default:
      res.status(404).json({ error: 'Unknown bot action' });
      return;
  }
}

// --- interactions handler ---------------------------------------------------

async function handleInteraction(
  payload: Record<string, unknown>,
  res: VercelResponse,
  deps: BotDeps = {},
): Promise<void> {
  const type = payload.type;

  // PING handshake: Discord sends this when the Interactions Endpoint
  // URL is first configured and periodically thereafter. Reply PONG
  // or the URL is rejected.
  if (type === INTERACTION_TYPE_PING) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_PONG });
    return;
  }

  if (type === INTERACTION_TYPE_APPLICATION_COMMAND) {
    return handleApplicationCommand(payload, res);
  }

  if (type === INTERACTION_TYPE_MESSAGE_COMPONENT) {
    const data = payload.data as { custom_id?: string } | undefined;
    const customId = data?.custom_id ?? '';
    if (customId.startsWith(`${BUTTON_CUSTOM_ID_PREFIX}:`)) {
      return handleTradeProposalButton(payload, res, deps);
    }
    if (
      customId.startsWith(`${PREF_CUSTOM_ID_PREFIX}:`)
      || customId.startsWith(`${COMM_PREF_CUSTOM_ID_PREFIX}:`)
    ) {
      return handlePrefsButton(payload, res);
    }
  }

  // Unknown: ack with a deferred update. Discord swallows the click
  // gracefully instead of showing "interaction failed".
  res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
}

// --- application-command handler -------------------------------------------

/**
 * Dispatch for slash commands + user-context menus. Two surfaces
 * both land here:
 *   - `/swutrade settings [user:@peer]` (slash, type 1): no user →
 *     self-prefs index; with user → peer-prefs index for that target.
 *   - "SWUTrade prefs" user context menu (type 2): always the
 *     peer-prefs index for the target user.
 *
 * Response protocol: ephemeral CHANNEL_MESSAGE_WITH_SOURCE with the
 * index body, so the clicker sees a private set of pref buttons they
 * can drill into via the existing `pref:*` custom_id handler.
 */
async function handleApplicationCommand(
  payload: Record<string, unknown>,
  res: VercelResponse,
): Promise<void> {
  const data = payload.data as {
    name?: string;
    type?: number;
    options?: Array<{ name: string; type: number; value?: unknown; options?: Array<{ name: string; type: number; value?: unknown }> }>;
    target_id?: string;
    resolved?: { users?: Record<string, { id: string; username?: string; global_name?: string }> };
  } | undefined;

  const commandType = data?.type ?? APPLICATION_COMMAND_TYPE_SLASH;

  // Identify the peer target:
  //   - User context menu → payload.data.target_id
  //   - `/swutrade settings user:@alice` → options[0].options[?name=user].value
  let peerDiscordId: string | undefined;
  let peerUsername: string | undefined;

  if (commandType === APPLICATION_COMMAND_TYPE_USER) {
    peerDiscordId = data?.target_id;
    const resolved = data?.resolved?.users?.[peerDiscordId ?? ''];
    peerUsername = resolved?.global_name ?? resolved?.username;
  } else if (commandType === APPLICATION_COMMAND_TYPE_SLASH) {
    // For `/swutrade settings`, data.name = "swutrade" and
    // options[0] is the "settings" subcommand. Drill through.
    const subcommand = data?.options?.find(o => o.type === OPTION_TYPE_SUB_COMMAND);
    if (subcommand?.name === 'settings') {
      const userOpt = subcommand.options?.find(o => o.type === OPTION_TYPE_USER && o.name === 'user');
      if (userOpt) {
        peerDiscordId = String(userOpt.value);
        const resolved = data?.resolved?.users?.[peerDiscordId];
        peerUsername = resolved?.global_name ?? resolved?.username;
      }
    } else {
      // Unknown subcommand — respond with a note rather than silently
      // dropping so the caller sees what happened.
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: {
          content: 'Unknown command. Try `/swutrade settings`.',
          flags: MESSAGE_FLAG_EPHEMERAL,
        },
      });
      return;
    }
  } else {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  // No peer → self-prefs index.
  if (!peerDiscordId) {
    const selfDefs = PREF_DEFINITIONS.filter(
      d => d.scope.kind === 'self' && d.surfaces.includes('discord'),
    );
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { ...buildSelfPrefsIndexMessage(selfDefs), flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  // Peer flow: map the target Discord id to a SWUTrade user id.
  const db = getDb();
  const [peerRow] = await db
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(eq(users.discordId, peerDiscordId))
    .limit(1);
  if (!peerRow) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: `<@${peerDiscordId}>${peerUsername ? ` (@${peerUsername})` : ''} isn't on SWUTrade yet — no per-trader settings to set.`,
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  // Reject self-override — peer prefs are for OTHER users.
  const maybeMember = payload.member as { user?: { id?: string } } | undefined;
  const maybeUser = payload.user as { id?: string } | undefined;
  const clickerDiscordId = maybeMember?.user?.id ?? maybeUser?.id;
  if (clickerDiscordId && clickerDiscordId === peerDiscordId) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: "You can't set per-trader prefs for yourself. Use `/swutrade settings` (no target user) for your global defaults.",
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  const peerDefs = PREF_DEFINITIONS.filter(
    d => d.scope.kind === 'peer' && d.surfaces.includes('discord'),
  );
  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
    data: {
      ...buildPeerPrefsIndexMessage(peerDefs, peerRow.id, peerRow.handle),
      flags: MESSAGE_FLAG_EPHEMERAL,
    },
  });
}

/**
 * Accept / Decline button on a trade proposal DM.
 *
 * Response protocol: we reply with type 7 (UPDATE_MESSAGE) so the
 * button row in the recipient's DM is replaced in place by the
 * "accepted/declined" body — cheaper than a separate edit PATCH
 * and avoids a flicker where buttons stay clickable after the
 * state change commits.
 *
 * Idempotency: if the trade is already out of `pending`, we still
 * update the message (the recipient's DM might be stale in that
 * rare case) but skip the DB write + the proposer-notification DM.
 * No risk of double-firing notifications on a duplicate click.
 */
export async function handleTradeProposalButton(
  payload: Record<string, unknown>,
  res: VercelResponse,
  deps: BotDeps = {},
): Promise<void> {
  const data = payload.data as { custom_id?: string } | undefined;
  const parts = (data?.custom_id ?? '').split(':');
  // [prefix, tradeId, action]
  const tradeId = parts[1] ?? '';
  const rawAction = parts[2] ?? '';
  const KNOWN_ACTIONS = [
    'accept',
    'decline',
    'counter',
    'request-thread',
    'approve-thread',
    'decline-thread',
  ] as const;
  type KnownAction = (typeof KNOWN_ACTIONS)[number];
  if (!tradeId || !KNOWN_ACTIONS.includes(rawAction as KnownAction)) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }
  const action = rawAction as KnownAction;

  // In a DM the payload has `user`; in a guild `member.user`. The
  // bot only sends to DMs for proposals but handle both for safety.
  const maybeMember = payload.member as { user?: { id?: string } } | undefined;
  const maybeUser = payload.user as { id?: string } | undefined;
  const clickerDiscordId = maybeMember?.user?.id ?? maybeUser?.id;
  if (!clickerDiscordId) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const db = getDb();
  const [trade] = await db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.id, tradeId))
    .limit(1);
  if (!trade) {
    // Trade vanished (shouldn't normally happen). Post an ephemeral
    // explanation so the recipient knows why their click did nothing.
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: 'This trade proposal no longer exists.',
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  const [recipient] = await db
    .select({
      id: users.id,
      discordId: users.discordId,
      handle: users.handle,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, trade.recipientUserId))
    .limit(1);
  const [proposer] = await db
    .select({
      id: users.id,
      discordId: users.discordId,
      handle: users.handle,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, trade.proposerUserId))
    .limit(1);
  if (!recipient || !proposer) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: 'Could not find the users on this trade — it may have been orphaned.',
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  // Thread-flow actions have different auth than accept/decline/
  // counter (either party can request; the *other* party decides),
  // so branch off before the recipient-only check below. Handlers
  // return void; fall-through reaches the accept/decline/counter path.
  if (action === 'request-thread' || action === 'approve-thread' || action === 'decline-thread') {
    return handleThreadFlowButton({
      action,
      trade,
      proposer,
      recipient,
      clickerDiscordId,
      res,
      deps,
    });
  }

  // Authorization: only the recipient can accept/decline/counter.
  // Anyone else seeing this button (shouldn't happen from a DM, but
  // belt-and-suspenders for the guild-channel case) gets an ephemeral.
  if (recipient.discordId !== clickerDiscordId) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: 'This trade proposal was sent to someone else.',
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  // Counter takes a different shape: no state change, no message
  // edit — just reply with an ephemeral deep-link to the web
  // composer. The original DM stays live so the recipient can
  // still Accept/Decline if they change their mind mid-compose
  // (see PHASE4C_COUNTER_DESIGN.md for why we don't eager-lock).
  if (action === 'counter') {
    const origin = deps.origin ?? 'https://beta.swutrade.com';
    const link = `${origin}/?counter=${encodeURIComponent(trade.id)}`;
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: `Open SWUTrade to compose your counter: ${link}`,
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  const proposalCtx = {
    tradeId: trade.id,
    proposerUserId: proposer.id,
    proposerHandle: proposer.handle,
    proposerUsername: proposer.username,
    offeringCards: trade.offeringCards,
    receivingCards: trade.receivingCards,
    message: trade.message,
  };

  // Idempotent path — already resolved. Refresh the message body
  // and bail without firing side effects again.
  if (trade.status === 'accepted' || trade.status === 'declined') {
    const body = buildResolvedProposalMessage(proposalCtx, trade.status, recipient.handle);
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
      data: body,
    });
    return;
  }
  if (trade.status === 'countered') {
    // Original was already countered — refresh the DM body so the
    // stale buttons (if somehow still clickable) are gone.
    const body = buildCounteredProposalMessage(proposalCtx, recipient.handle);
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
      data: body,
    });
    return;
  }

  // Status transitions other than pending → accepted/declined (e.g.
  // cancelled by proposer via a future web action) should block the
  // button — show an ephemeral instead of updating the message.
  if (trade.status !== 'pending') {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: `This proposal is ${trade.status} and can't be responded to.`,
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  // At this point, `action` is guaranteed to be 'accept' or 'decline'
  // (the other cases all returned above). TS can't narrow the union
  // through the early-return chain, so pin the discriminant here.
  if (action !== 'accept' && action !== 'decline') {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }
  const newStatus: 'accepted' | 'declined' = action === 'accept' ? 'accepted' : 'declined';

  await db
    .update(tradeProposals)
    .set({
      status: newStatus,
      respondedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, trade.id));

  // Follow-up DM to the proposer. Awaited so Vercel doesn't kill
  // the function before the request completes — Discord allows 3s
  // for interaction responses and this usually lands in <500ms.
  // Failures are logged but don't block the interaction response.
  try {
    const bot = deps.bot ?? createDiscordBotClient();
    const notifyBody = buildProposerNotification({
      tradeId: trade.id,
      recipientHandle: recipient.handle,
      outcome: newStatus,
    });
    await bot.sendDirectMessage(proposer.discordId, notifyBody);
  } catch (err) {
    console.error('handleTradeProposalButton: proposer notify failed', err);
  }

  const resolvedBody = buildResolvedProposalMessage(proposalCtx, newStatus, recipient.handle);
  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
    data: resolvedBody,
  });
}

// --- thread-flow buttons ---------------------------------------------------

interface TradeRow {
  id: string;
  proposerUserId: string;
  recipientUserId: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered';
  offeringCards: import('../lib/schema.js').TradeCardSnapshot[];
  receivingCards: import('../lib/schema.js').TradeCardSnapshot[];
  message: string | null;
  discordDmChannelId: string | null;
  discordDmMessageId: string | null;
  discordThreadId: string | null;
  threadApprovalDmChannelId: string | null;
  threadApprovalDmMessageId: string | null;
}

interface PartyRow {
  id: string;
  discordId: string;
  handle: string;
  username: string;
}

/**
 * Thread flow dispatcher. Handles request-thread (click by either
 * party) + approve-thread / decline-thread (click by the counterpart
 * who received the approval DM).
 *
 * Auth differs from accept/decline:
 *   - request-thread: clicker is either proposer or recipient
 *   - approve/decline-thread: clicker is whichever party DIDN'T click
 *     request-thread (i.e., the approval DM recipient)
 */
async function handleThreadFlowButton(args: {
  action: 'request-thread' | 'approve-thread' | 'decline-thread';
  trade: TradeRow;
  proposer: PartyRow;
  recipient: PartyRow;
  clickerDiscordId: string;
  res: VercelResponse;
  deps: BotDeps;
}): Promise<void> {
  const { action, trade, proposer, recipient, clickerDiscordId, res, deps } = args;

  // Proposal must still be live to act on the thread decision.
  if (trade.status !== 'pending') {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: `This proposal is ${trade.status} — thread changes no longer apply.`,
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  if (trade.discordThreadId) {
    // Already threaded — nothing further to do.
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: 'This trade is already in a thread.',
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  const proposalCtx = {
    tradeId: trade.id,
    proposerUserId: proposer.id,
    proposerHandle: proposer.handle,
    proposerUsername: proposer.username,
    offeringCards: trade.offeringCards,
    receivingCards: trade.receivingCards,
    message: trade.message,
  };

  if (action === 'request-thread') {
    // Clicker must be proposer OR recipient.
    const clickerIsProposer = proposer.discordId === clickerDiscordId;
    const clickerIsRecipient = recipient.discordId === clickerDiscordId;
    if (!clickerIsProposer && !clickerIsRecipient) {
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: {
          content: 'You are not on this trade.',
          flags: MESSAGE_FLAG_EPHEMERAL,
        },
      });
      return;
    }

    const requester = clickerIsProposer ? proposer : recipient;
    const counterpart = clickerIsProposer ? recipient : proposer;
    // Counterpart's pref vis-à-vis THIS specific requester — a peer
    // override on (counterpart, requester) can flip auto-approve /
    // manual-decide / auto-decline per trading partner.
    const counterpartPref = (await resolvePref({
      key: 'communicationPref',
      viewerUserId: counterpart.id,
      peerUserId: requester.id,
    })) as CommunicationPref;
    const outcome = handleThreadRequest(counterpartPref);

    if (outcome === 'auto-decline') {
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: {
          content: "They don't accept thread requests — continuing in DM.",
          flags: MESSAGE_FLAG_EPHEMERAL,
        },
      });
      return;
    }

    const bot = deps.bot ?? createDiscordBotClient();

    if (outcome === 'auto-approve') {
      // Counterpart has `prefer` or `auto-accept` — skip the approval
      // DM and create the thread now. Edit BOTH DMs to the "moved"
      // variant.
      const tradesChannelId = process.env.TRADES_CHANNEL_ID;
      if (!tradesChannelId) {
        res.status(200).json({
          type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
          data: {
            content: "Couldn't create thread, continuing in DM.",
            flags: MESSAGE_FLAG_EPHEMERAL,
          },
        });
        return;
      }

      let createdThreadId: string | null = null;
      try {
        const thread = await bot.createPrivateThread(tradesChannelId, {
          name: `trade-${proposer.handle}-${recipient.handle}-${trade.id.slice(0, 4)}`.slice(0, 100),
        });
        createdThreadId = thread.id;
        await Promise.all([
          bot.addThreadMember(thread.id, proposer.discordId),
          bot.addThreadMember(thread.id, recipient.discordId),
        ]);
        // Post the full proposal embed inside the thread (buttons
        // included) so both traders can act from there. Mirrors the
        // initial thread-immediately path.
        await bot.postChannelMessage(thread.id, buildProposalMessage(proposalCtx));
      } catch (err) {
        console.error('handleThreadFlowButton: auto-approve thread create failed', err);
        if (createdThreadId) {
          bot.deleteChannel(createdThreadId).catch(cleanupErr => {
            console.error('handleThreadFlowButton: orphan thread cleanup failed', cleanupErr);
          });
        }
        res.status(200).json({
          type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
          data: {
            content: "Couldn't create thread, continuing in DM.",
            flags: MESSAGE_FLAG_EPHEMERAL,
          },
        });
        return;
      }

      await _autoApproveMoveThread({
        bot,
        trade,
        proposalCtx,
        threadId: createdThreadId,
        clickerIsProposer,
        res,
      });
      return;
    }

    // outcome === 'manual-decide' — DM the counterpart an approval
    // prompt, edit the clicker's DM to "thread requested" state via
    // UPDATE_MESSAGE.
    let approvalChannelId: string | null = null;
    let approvalMessageId: string | null = null;
    try {
      const approvalBody = buildThreadApprovalRequestMessage(proposalCtx, requester.handle);
      const sent = await bot.sendDirectMessage(counterpart.discordId, approvalBody);
      approvalChannelId = sent.channel_id;
      approvalMessageId = sent.id;
    } catch (err) {
      console.error('handleThreadFlowButton: approval DM send failed', err);
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: {
          content: "Couldn't reach the other party — continuing in DM.",
          flags: MESSAGE_FLAG_EPHEMERAL,
        },
      });
      return;
    }

    const db = getDb();
    await db.update(tradeProposals)
      .set({
        threadApprovalDmChannelId: approvalChannelId,
        threadApprovalDmMessageId: approvalMessageId,
        updatedAt: new Date(),
      })
      .where(eq(tradeProposals.id, trade.id));

    // Edit the clicker's DM via UPDATE_MESSAGE (type 7).
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
      data: buildThreadRequestedProposalMessage(proposalCtx, requester.handle),
    });
    return;
  }

  if (action === 'approve-thread' || action === 'decline-thread') {
    // Clicker must be the counterpart (i.e., NOT whoever requested).
    // The requester stored their approval-DM ids on the row — those
    // ids point at the *counterpart's* DM channel, so the clicker is
    // the recipient of that DM.
    if (!trade.threadApprovalDmChannelId || !trade.threadApprovalDmMessageId) {
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: {
          content: 'No thread request is pending on this trade.',
          flags: MESSAGE_FLAG_EPHEMERAL,
        },
      });
      return;
    }

    // The "requester" is whoever clicked Request-thread. We didn't
    // persist that explicitly; infer from discord_dm_channel_id being
    // the recipient's DM (the initial proposal DM path) — the
    // approval DM is sent to the OTHER party. Simpler approach:
    // allow either party to click, but dispatch the "requester DM"
    // edit to whichever is NOT the clicker.
    const clickerIsProposer = proposer.discordId === clickerDiscordId;
    const clickerIsRecipient = recipient.discordId === clickerDiscordId;
    if (!clickerIsProposer && !clickerIsRecipient) {
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
        data: {
          content: 'You are not on this trade.',
          flags: MESSAGE_FLAG_EPHEMERAL,
        },
      });
      return;
    }

    const bot = deps.bot ?? createDiscordBotClient();

    if (action === 'approve-thread') {
      const tradesChannelId = process.env.TRADES_CHANNEL_ID;
      if (!tradesChannelId) {
        res.status(200).json({
          type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
          data: {
            content: "Couldn't create thread, continuing in DM.",
            flags: MESSAGE_FLAG_EPHEMERAL,
          },
        });
        return;
      }

      let createdThreadId: string | null = null;
      let threadParentId: string | null = null;
      try {
        const thread = await bot.createPrivateThread(tradesChannelId, {
          name: `trade-${proposer.handle}-${recipient.handle}-${trade.id.slice(0, 4)}`.slice(0, 100),
        });
        createdThreadId = thread.id;
        threadParentId = thread.parent_id ?? tradesChannelId;
        await Promise.all([
          bot.addThreadMember(thread.id, proposer.discordId),
          bot.addThreadMember(thread.id, recipient.discordId),
        ]);
        // Post the full proposal embed inside the thread so both
        // traders can act from there (buttons + summary).
        await bot.postChannelMessage(thread.id, buildProposalMessage(proposalCtx));
      } catch (err) {
        console.error('handleThreadFlowButton: approve-thread create failed', err);
        if (createdThreadId) {
          bot.deleteChannel(createdThreadId).catch(cleanupErr => {
            console.error('handleThreadFlowButton: orphan thread cleanup failed', cleanupErr);
          });
        }
        res.status(200).json({
          type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
          data: {
            content: "Couldn't create thread, continuing in DM.",
            flags: MESSAGE_FLAG_EPHEMERAL,
          },
        });
        return;
      }

      // Persist thread ids on the row.
      const db = getDb();
      await db.update(tradeProposals)
        .set({
          discordThreadId: createdThreadId,
          discordThreadParentChannelId: threadParentId,
          updatedAt: new Date(),
        })
        .where(eq(tradeProposals.id, trade.id));

      // Edit the requester's DM (the original-proposal DM lives at
      // discord_dm_channel_id / discord_dm_message_id).
      if (trade.discordDmChannelId && trade.discordDmMessageId) {
        try {
          await bot.editChannelMessage(
            trade.discordDmChannelId,
            trade.discordDmMessageId,
            buildThreadMovedProposalMessage(proposalCtx, createdThreadId!),
          );
        } catch (err) {
          console.error('handleThreadFlowButton: requester DM edit failed', err);
        }
      }

      // Edit the approver's DM via UPDATE_MESSAGE response.
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
        data: buildThreadMovedProposalMessage(proposalCtx, createdThreadId!),
      });
      return;
    }

    // action === 'decline-thread'
    // Edit the requester's DM via PATCH to restore Accept/Counter/
    // Decline with a "declined, continuing in DM" note.
    if (trade.discordDmChannelId && trade.discordDmMessageId) {
      try {
        await bot.editChannelMessage(
          trade.discordDmChannelId,
          trade.discordDmMessageId,
          buildThreadRequestDeclinedMessage(proposalCtx),
        );
      } catch (err) {
        console.error('handleThreadFlowButton: requester DM edit (decline) failed', err);
      }
    }

    // Clear the approval DM ids so a future re-click can't misfire.
    const db = getDb();
    await db.update(tradeProposals)
      .set({
        threadApprovalDmChannelId: null,
        threadApprovalDmMessageId: null,
        updatedAt: new Date(),
      })
      .where(eq(tradeProposals.id, trade.id));

    // Edit the approver's DM via UPDATE_MESSAGE response.
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
      data: buildThreadRequestDeclinedMessage(proposalCtx),
    });
    return;
  }
}

/**
 * Shared edit-both-DMs-to-moved tail used by the auto-approve path.
 * The clicker's DM is updated via type-7 UPDATE_MESSAGE response;
 * the counterpart's DM is PATCHed in place via editChannelMessage.
 */
async function _autoApproveMoveThread(args: {
  bot: DiscordBotClient;
  trade: TradeRow;
  proposalCtx: {
    tradeId: string;
    proposerUserId: string;
    proposerHandle: string;
    proposerUsername: string;
    offeringCards: import('../lib/schema.js').TradeCardSnapshot[];
    receivingCards: import('../lib/schema.js').TradeCardSnapshot[];
    message: string | null;
  };
  threadId: string | null;
  clickerIsProposer: boolean;
  res: VercelResponse;
}): Promise<void> {
  const { bot, trade, proposalCtx, threadId, res } = args;
  if (!threadId) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: "Couldn't create thread, continuing in DM.",
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  // Persist thread ids.
  const db = getDb();
  await db.update(tradeProposals)
    .set({
      discordThreadId: threadId,
      discordThreadParentChannelId: process.env.TRADES_CHANNEL_ID ?? null,
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, trade.id));

  // Since auto-approve was triggered from the initial DM (one party's
  // DM), the OTHER party's DM is the one we need to PATCH. But we
  // don't track both parties' DM ids separately — only discord_dm_*
  // exists. In the auto-approve path, the initial proposal went as
  // a per-user DM to the recipient; that's what discord_dm_* tracks.
  // The proposer never got a DM (they sent the trade). So PATCH the
  // recipient's DM and type-7 the clicker's DM.
  //
  // If the clicker is the recipient, their DM is being responded to
  // via type-7 — nothing else to PATCH. If the clicker is the
  // proposer, we need to PATCH the recipient's DM via the
  // discord_dm_* ids.
  if (args.clickerIsProposer) {
    if (trade.discordDmChannelId && trade.discordDmMessageId) {
      try {
        await bot.editChannelMessage(
          trade.discordDmChannelId,
          trade.discordDmMessageId,
          buildThreadMovedProposalMessage(proposalCtx, threadId),
        );
      } catch (err) {
        console.error('_autoApproveMoveThread: recipient DM edit failed', err);
      }
    }
  }

  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
    data: buildThreadMovedProposalMessage(proposalCtx, threadId),
  });
}

// --- preference buttons ----------------------------------------------------

/**
 * `⚙ Prefs` button flow surfaced on proposal DMs and (future) the
 * `/swutrade settings` slash command. Shapes:
 *   - `pref:{key}:open` — reply with an ephemeral selector; each
 *     option button carries the commit custom_id.
 *   - `pref:{key}:set:{value}` — UPDATE the user's corresponding
 *     column and reply with an ephemeral confirmation that replaces
 *     the selector.
 *
 * Legacy `comm-pref:*` custom_ids from DMs shipped before the
 * registry existed dispatch through this handler too — they pin the
 * key to `communicationPref`. Remove once deployed DMs have rolled
 * over to the `pref:*` form.
 *
 * Rejects any key that isn't registered self-scope + Discord-surfaced.
 * A user forging a custom_id for a web-only pref (e.g. profileVisibility)
 * gets a silent deferred ack — no write, no surface leak.
 */
export async function handlePrefsButton(
  payload: Record<string, unknown>,
  res: VercelResponse,
): Promise<void> {
  const data = payload.data as { custom_id?: string } | undefined;
  const customId = data?.custom_id ?? '';
  const parts = customId.split(':');

  // Combined-view fork: `pref:combo:<peerUserId>:open`. Opens an
  // ephemeral showing BOTH the viewer's global default AND their
  // override vs this peer, in one message. The option buttons inside
  // carry standard per-scope custom_ids (pref:<key>:set:X for self,
  // pref:peer:<peerUserId>:<key>:set:X for peer) so clicks route back
  // through the existing per-scope handlers — this is a layout over
  // primitives, not a new write path.
  if (parts[0] === PREF_CUSTOM_ID_PREFIX && parts[1] === 'combo') {
    return handleCombinedPrefsButton(payload, res, {
      peerUserId: parts[2] ?? '',
      action: parts[3] ?? '',
    });
  }

  // Peer-scope fork: `pref:peer:<peerUserId>:<key>:<action>[:<value>]`.
  // Routes to a separate handler that reads/writes user_peer_prefs
  // instead of users. `peerUserId` in the custom_id is a SWUTrade
  // user id (set at selector-render time by the slash/context menu
  // handler after mapping the Discord id to users.id).
  if (parts[0] === PREF_CUSTOM_ID_PREFIX && parts[1] === 'peer') {
    return handlePeerPrefButton(payload, res, {
      peerUserId: parts[2] ?? '',
      defKey: parts[3] ?? '',
      action: parts[4] ?? '',
      rawValue: parts[5],
    });
  }

  // Self scope — existing logic. Parse into (defKey, action, rawValue).
  // The two prefixes differ in arity — legacy `comm-pref:{action}[:{value}]`
  // vs new `pref:{key}:{action}[:{value}]` — so keep the dispatch explicit.
  let defKey: string;
  let action: string;
  let rawValue: string | undefined;
  if (parts[0] === PREF_CUSTOM_ID_PREFIX) {
    defKey = parts[1] ?? '';
    action = parts[2] ?? '';
    rawValue = parts[3];
  } else if (parts[0] === COMM_PREF_CUSTOM_ID_PREFIX) {
    defKey = 'communicationPref';
    action = parts[1] ?? '';
    rawValue = parts[2];
  } else {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  // Registry lookup is the authorization gate. Unknown keys + keys
  // the registry doesn't surface on Discord (web-only, like
  // profileVisibility) silently defer — nothing to do, no leak.
  const def = getPrefDefinition(defKey, 'self');
  if (!def || !def.surfaces.includes('discord')) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const maybeMember = payload.member as { user?: { id?: string } } | undefined;
  const maybeUser = payload.user as { id?: string } | undefined;
  const clickerDiscordId = maybeMember?.user?.id ?? maybeUser?.id;
  if (!clickerDiscordId) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const db = getDb();
  // Dynamic column access — `def.column` is validated against the
  // users schema at registry test time, so the runtime property
  // lookup is safe. Used for both read (selector highlight) and
  // write (commit).
  const usersColumns = users as unknown as Record<
    string,
    import('drizzle-orm/pg-core').AnyPgColumn
  >;
  const column = usersColumns[def.column];

  if (action === 'open') {
    const [row] = await db
      .select({ value: column })
      .from(users)
      .where(eq(users.discordId, clickerDiscordId))
      .limit(1);
    const current = (row?.value ?? def.default) as boolean | string;
    const body = buildPrefOptionsMessage(def, current);
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { ...body, flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  if (action === 'set') {
    // `rawValue` arrives as a string fragment from the custom_id.
    // Coerce to the def's expected type before validating — boolean
    // prefs encode as the literal strings 'true' / 'false'.
    let candidate: unknown = rawValue;
    if (def.type.kind === 'boolean') {
      if (rawValue === 'true') candidate = true;
      else if (rawValue === 'false') candidate = false;
    }
    const validated = validatePrefValue(def, candidate);
    if (!validated.ok) {
      res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
      return;
    }

    await db
      .update(users)
      .set({ [def.column]: validated.value, updatedAt: new Date() })
      .where(eq(users.discordId, clickerDiscordId));

    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
      data: buildPrefConfirmationMessage(def, validated.value),
    });
    return;
  }

  res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
}

/**
 * Peer-scope variant of the prefs button handler. Reads/writes
 * `user_peer_prefs` keyed on (viewerId, peerUserId). Called from
 * buttons emitted by the `/swutrade settings user:@peer` ephemeral.
 *
 * The `set:inherit` action clears the override (UPSERT null) so the
 * resolver cascade falls back to the viewer's self value. Any other
 * set value is validated against the peer-scoped registry def before
 * writing. Unknown peer keys, web-only defs, or custom_ids missing
 * the peer id all silently defer — no leak surface.
 */
/**
 * `pref:combo:<peerUserId>:open` — render the two-row "self + peer"
 * ephemeral. `communicationPref` is the only pref that renders here
 * today (it's the only one registered at both scopes); if we register
 * a second dual-scope pref in the future, we'll either loop over all
 * of them or add disambiguation to the custom_id.
 */
async function handleCombinedPrefsButton(
  payload: Record<string, unknown>,
  res: VercelResponse,
  parsed: { peerUserId: string; action: string },
): Promise<void> {
  const { peerUserId, action } = parsed;
  if (!peerUserId || action !== 'open') {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  // The combined view today always surfaces communicationPref. Pull
  // both defs and bail if either isn't registered at the expected scope.
  const selfDef = getPrefDefinition('communicationPref', 'self');
  const peerDef = getPrefDefinition('communicationPref', 'peer');
  if (!selfDef || !peerDef) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const maybeMember = payload.member as { user?: { id?: string } } | undefined;
  const maybeUser = payload.user as { id?: string } | undefined;
  const clickerDiscordId = maybeMember?.user?.id ?? maybeUser?.id;
  if (!clickerDiscordId) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const db = getDb();
  const [viewer] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.discordId, clickerDiscordId))
    .limit(1);
  if (!viewer) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }
  // If someone's DM somehow carried their own id as the peer
  // (shouldn't happen — proposer != recipient is a handlePropose
  // invariant), fall back to the self-only selector.
  if (viewer.id === peerUserId) {
    const usersColumns = users as unknown as Record<
      string,
      import('drizzle-orm/pg-core').AnyPgColumn
    >;
    const [row] = await db
      .select({ value: usersColumns[selfDef.column] })
      .from(users)
      .where(eq(users.id, viewer.id))
      .limit(1);
    const current = (row?.value ?? selfDef.default) as boolean | string;
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { ...buildPrefOptionsMessage(selfDef, current), flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  // Pull the three values the combined view displays in parallel.
  const usersColumns = users as unknown as Record<
    string,
    import('drizzle-orm/pg-core').AnyPgColumn
  >;
  const peerColumns = userPeerPrefs as unknown as Record<
    string,
    import('drizzle-orm/pg-core').AnyPgColumn
  >;

  const [selfRow] = await db
    .select({ value: usersColumns[selfDef.column] })
    .from(users)
    .where(eq(users.id, viewer.id))
    .limit(1);
  const [overrideRow] = await db
    .select({ value: peerColumns[peerDef.column] })
    .from(userPeerPrefs)
    .where(and(
      eq(userPeerPrefs.userId, viewer.id),
      eq(userPeerPrefs.peerUserId, peerUserId),
    ))
    .limit(1);
  const [peerRow] = await db
    .select({ handle: users.handle })
    .from(users)
    .where(eq(users.id, peerUserId))
    .limit(1);

  const currentSelf = (selfRow?.value ?? selfDef.default) as boolean | string;
  const currentOverride = (overrideRow?.value ?? null) as boolean | string | null;
  const effective = (await resolvePref({
    key: selfDef.key,
    viewerUserId: viewer.id,
    peerUserId,
  })) as boolean | string | null;
  const peerHandle = peerRow?.handle ?? peerUserId.slice(0, 8);

  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
    data: {
      ...buildCombinedPrefsMessage(
        selfDef,
        peerUserId,
        peerHandle,
        currentSelf,
        currentOverride,
        effective,
      ),
      flags: MESSAGE_FLAG_EPHEMERAL,
    },
  });
}

async function handlePeerPrefButton(
  payload: Record<string, unknown>,
  res: VercelResponse,
  parsed: { peerUserId: string; defKey: string; action: string; rawValue: string | undefined },
): Promise<void> {
  const { peerUserId, defKey, action, rawValue } = parsed;
  if (!peerUserId || !defKey || !action) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const def = getPrefDefinition(defKey, 'peer');
  if (!def || !def.surfaces.includes('discord')) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const maybeMember = payload.member as { user?: { id?: string } } | undefined;
  const maybeUser = payload.user as { id?: string } | undefined;
  const clickerDiscordId = maybeMember?.user?.id ?? maybeUser?.id;
  if (!clickerDiscordId) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const db = getDb();

  // Map the clicker's Discord id to their SWUTrade user id — that's
  // the `userId` side of the user_peer_prefs composite key.
  const [viewer] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.discordId, clickerDiscordId))
    .limit(1);
  if (!viewer) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: "You need to sign into SWUTrade on the web before setting per-trader prefs.",
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }
  if (viewer.id === peerUserId) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: "You can't override prefs against yourself.",
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  // Resolve peer handle for the message copy — purely cosmetic, so a
  // missing row just falls back to the raw id.
  const [peerRow] = await db
    .select({ handle: users.handle })
    .from(users)
    .where(eq(users.id, peerUserId))
    .limit(1);
  const peerHandle = peerRow?.handle ?? peerUserId.slice(0, 8);

  const peerColumns = userPeerPrefs as unknown as Record<
    string,
    import('drizzle-orm/pg-core').AnyPgColumn
  >;
  const column = peerColumns[def.column];

  if (action === 'open') {
    const [row] = await db
      .select({ value: column })
      .from(userPeerPrefs)
      .where(and(
        eq(userPeerPrefs.userId, viewer.id),
        eq(userPeerPrefs.peerUserId, peerUserId),
      ))
      .limit(1);
    const override = (row?.value ?? null) as boolean | string | null;
    const effective = (await resolvePref({
      key: def.key,
      viewerUserId: viewer.id,
      peerUserId,
    })) as boolean | string | null;
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        ...buildPeerPrefOptionsMessage(def, peerUserId, peerHandle, override, effective),
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  if (action === 'set') {
    // `set:inherit` clears the override; any other value goes through
    // the registry validator (with the boolean literal coercion from
    // the self-scope path).
    let persisted: boolean | string | null;
    if (rawValue === 'inherit') {
      persisted = null;
    } else {
      let candidate: unknown = rawValue;
      if (def.type.kind === 'boolean') {
        if (rawValue === 'true') candidate = true;
        else if (rawValue === 'false') candidate = false;
      }
      const validated = validatePrefValue(def, candidate);
      if (!validated.ok) {
        res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
        return;
      }
      persisted = validated.value;
    }

    const now = new Date();
    await db
      .insert(userPeerPrefs)
      .values({
        userId: viewer.id,
        peerUserId,
        [def.column]: persisted,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userPeerPrefs.userId, userPeerPrefs.peerUserId],
        set: { [def.column]: persisted, updatedAt: now },
      });

    // Compute the post-write effective value for the confirmation
    // message — matters when we cleared (inherited) so the user sees
    // what their self default now resolves to.
    const effectiveAfter = (await resolvePref({
      key: def.key,
      viewerUserId: viewer.id,
      peerUserId,
    })) as boolean | string | null;

    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
      data: buildPeerPrefConfirmationMessage(def, peerUserId, peerHandle, persisted, effectiveAfter),
    });
    return;
  }

  res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
}

// --- event webhook handler --------------------------------------------------

interface ApplicationAuthorizedEventData {
  integration_type?: number;
  user?: { id: string; username?: string };
  scopes?: string[];
  guild?: { id: string; name?: string; icon?: string | null };
}

async function handleEvent(
  payload: Record<string, unknown>,
  res: VercelResponse,
  deps: BotDeps = {},
): Promise<void> {
  // Event Webhooks use a distinct `type` enum from Interactions:
  //   0 = PING (endpoint verification on URL save)
  //   1 = EVENT (normal delivery; the event object is in `event`)
  // Do NOT reuse INTERACTION_TYPE_PING here — those are different
  // enum spaces that happen to alias on the same field name.
  const typeField = payload.type;
  if (typeField === 0) {
    res.status(204).end();
    return;
  }

  const event = payload.event as { type?: string; data?: ApplicationAuthorizedEventData } | undefined;
  const eventType = event?.type;

  if (eventType === 'APPLICATION_AUTHORIZED') {
    await handleApplicationAuthorized(event?.data, deps);
    res.status(204).end();
    return;
  }

  // Unknown event — ack so Discord doesn't retry, but log for
  // observability. (Retries on 5xx; 2xx tells Discord we received.)
  console.log('discord-bot: unhandled event type', eventType);
  res.status(204).end();
}

/**
 * Bot was installed (or re-authorized) into a guild. Insert or
 * refresh the `bot_installed_guilds` row. Gracefully tolerates
 * missing metadata by falling back to a Discord API lookup.
 *
 * After the row is upserted, attempts to auto-create a
 * `#swutrade-threads` channel scoped to the bot so future private
 * trade-proposal threads have a home. Any failure here (missing
 * MANAGE_CHANNELS, network hiccup, etc.) is logged and swallowed —
 * the install itself must not fail on channel-creation problems.
 */
async function handleApplicationAuthorized(
  data: ApplicationAuthorizedEventData | undefined,
  deps: BotDeps = {},
): Promise<void> {
  if (!data?.guild?.id) {
    // APPLICATION_AUTHORIZED fires for user-install (no guild) too.
    // Only the guild-install variant is relevant to bot_installed_guilds.
    return;
  }

  const guildId = data.guild.id;
  let guildName = data.guild.name ?? '';
  let guildIcon: string | null = data.guild.icon ?? null;
  const installedByUserId = data.user?.id ?? null;

  // Fall back to a direct fetch if the event didn't carry name/icon.
  if (!guildName) {
    try {
      const bot = deps.bot ?? createDiscordBotClient();
      const meta = await bot.getGuild(guildId);
      guildName = meta.name;
      guildIcon = meta.icon;
    } catch (err) {
      console.error('discord-bot: getGuild fallback failed', err);
      guildName = `Guild ${guildId}`;
    }
  }

  const db = getDb();

  // Check for pre-existing row FIRST so we know whether this is a
  // fresh install (welcome-DM the admin) vs a re-authorization (stay
  // quiet — they already got the welcome once).
  const [priorRow] = await db
    .select({ tradesChannelId: botInstalledGuilds.tradesChannelId })
    .from(botInstalledGuilds)
    .where(eq(botInstalledGuilds.guildId, guildId))
    .limit(1);
  const isFreshInstall = !priorRow;

  await db
    .insert(botInstalledGuilds)
    .values({
      guildId,
      guildName,
      guildIcon,
      installedByUserId,
    })
    .onConflictDoUpdate({
      target: botInstalledGuilds.guildId,
      set: { guildName, guildIcon },
    });

  // Skip auto-create if this guild already has a trades channel —
  // re-auth / re-install shouldn't spawn duplicates.
  if (priorRow?.tradesChannelId) {
    return;
  }

  try {
    const bot = deps.bot ?? createDiscordBotClient();
    // Discord rejects `/guilds/:id/members/@me` for bots — we have to
    // supply the bot's user id, which for applications is identical
    // to the OAuth client id.
    const botUserId = process.env.DISCORD_CLIENT_ID;
    if (!botUserId) {
      throw new Error('DISCORD_CLIENT_ID not set — cannot resolve bot member');
    }
    const botMember = await bot.getGuildBotMember(guildId, botUserId);
    const botRoleId = botMember.roles[0];
    if (!botRoleId) {
      throw new Error('bot has no roles in guild — cannot grant channel perms');
    }
    // The `@everyone` role id in Discord always equals the guild id.
    const everyoneRoleId = guildId;
    const channel = await bot.createGuildChannel(guildId, {
      name: 'swutrade-threads',
      type: 0,
      topic:
        'SWUTrade trade proposal threads. The bot creates a private thread per proposal; only the traders see the contents.',
      permission_overwrites: [
        {
          id: everyoneRoleId,
          type: 0,
          // VIEW_CHANNEL so members can see the channel + the system
          // "bot started a thread" pings. No deny — private threads
          // are invisible regardless of server-wide defaults.
          allow: '1024',
        },
        {
          id: botRoleId,
          type: 0,
          // Full set from BOT_INSTALL_PERMISSIONS so the bot works
          // regardless of server defaults on the channel.
          allow: '360777255952',
        },
      ],
    });
    await db
      .update(botInstalledGuilds)
      .set({ tradesChannelId: channel.id })
      .where(eq(botInstalledGuilds.guildId, guildId));
  } catch (err) {
    console.error('discord-bot: auto-create channel failed', err);
  }

  // Welcome DM — fresh installs only. The admin who actually added
  // the bot is our best discovery vector; they're most-engaged and
  // least likely to miss a DM. Failures don't block the install.
  if (isFreshInstall && installedByUserId) {
    try {
      const bot = deps.bot ?? createDiscordBotClient();
      await bot.sendDirectMessage(installedByUserId, {
        embeds: [{
          title: `SWUTrade is installed in ${guildName}`,
          description: [
            "Here's how to use it:",
            "",
            "• **`/swutrade settings`** — manage your global preferences (thread behavior, notification toggles, profile visibility).",
            "• **`/swutrade settings user:@someone`** — set per-trader overrides for a specific person.",
            "• **Right-click any SWUTrade user → Apps → SWUTrade prefs** — same as the above, without typing.",
            "• **Web app**: sign in at https://beta.swutrade.com to manage wants + available lists and see the community directory for this server.",
            "",
            "Your preferences follow you across every server the bot is in. Server members set their own independently.",
          ].join('\n'),
          color: 0xD4AF37,
          footer: { text: 'SWUTrade — local trading, structured' },
        }],
      });
    } catch (err) {
      // Installing admin might have DMs disabled. Log + move on.
      console.error('discord-bot: welcome DM to installer failed', err);
    }
  }
}

