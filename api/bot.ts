import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../lib/db.js';
import { botInstalledGuilds } from '../lib/schema.js';
import { verifyDiscordSignature } from '../lib/discordSignature.js';
import { createDiscordBotClient } from '../lib/discordBot.js';

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
const INTERACTION_RESPONSE_TYPE_PONG = 1;

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
  if (!verified) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const action = (req.query.action as string | undefined) ?? '';
  return dispatchBotPayload(action, parsed, res);
}

/**
 * Post-signature-verification dispatch. Exported for integration
 * tests so they can invoke the handler logic with pre-parsed
 * payloads and skip the raw-body-stream + signature-verify layers
 * (those are unit-tested separately in discord-signature.test.ts).
 */
export async function dispatchBotPayload(
  action: string,
  payload: Record<string, unknown>,
  res: VercelResponse,
): Promise<void> {
  switch (action) {
    case 'interactions': return handleInteraction(payload, res);
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
): Promise<void> {
  const type = payload.type;

  // PING handshake: Discord sends this when the Interactions Endpoint
  // URL is first configured and periodically thereafter. Reply PONG
  // or the URL is rejected.
  if (type === INTERACTION_TYPE_PING) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_PONG });
    return;
  }

  // Future: dispatch on component custom_id for trade-proposal
  // Accept / Counter / Decline buttons. For now nothing else is
  // wired up — ack with an empty "deferred update message" so
  // Discord doesn't surface a generic failure in the client.
  res.status(200).json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE
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

