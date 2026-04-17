import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { botInstalledGuilds, tradeProposals, users } from '../lib/schema.js';
import { verifyDiscordSignature } from '../lib/discordSignature.js';
import { createDiscordBotClient, type DiscordBotClient } from '../lib/discordBot.js';
import {
  BUTTON_CUSTOM_ID_PREFIX,
  buildResolvedProposalMessage,
  buildCounteredProposalMessage,
  buildProposerNotification,
} from '../lib/proposalMessages.js';

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

// --- Discord interaction constants ------------------------------------------

const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_MESSAGE_COMPONENT = 3;
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
  // needing a real human click in Discord. Set only on Preview —
  // never on Production. If a forged interaction is ever an issue,
  // rotate / unset this env var to disable.
  const testPublicKey = process.env.DISCORD_APP_PUBLIC_KEY_TEST;
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
    case 'events':       return handleEvent(payload, res);
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

  if (type === INTERACTION_TYPE_MESSAGE_COMPONENT) {
    const data = payload.data as { custom_id?: string } | undefined;
    const customId = data?.custom_id ?? '';
    if (customId.startsWith(`${BUTTON_CUSTOM_ID_PREFIX}:`)) {
      return handleTradeProposalButton(payload, res, deps);
    }
  }

  // Unknown: ack with a deferred update. Discord swallows the click
  // gracefully instead of showing "interaction failed".
  res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
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
  if (!tradeId || (rawAction !== 'accept' && rawAction !== 'decline' && rawAction !== 'counter')) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }
  const action = rawAction as 'accept' | 'decline' | 'counter';

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
    .select({ id: users.id, discordId: users.discordId, handle: users.handle })
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
    await handleApplicationAuthorized(event?.data);
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
 */
async function handleApplicationAuthorized(
  data: ApplicationAuthorizedEventData | undefined,
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
      const bot = createDiscordBotClient();
      const meta = await bot.getGuild(guildId);
      guildName = meta.name;
      guildIcon = meta.icon;
    } catch (err) {
      console.error('discord-bot: getGuild fallback failed', err);
      guildName = `Guild ${guildId}`;
    }
  }

  const db = getDb();
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
}

