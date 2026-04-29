import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { botInstalledGuilds, tradeProposals, userGuildMemberships, userPeerPrefs, users } from '../lib/schema.js';
import { verifyDiscordSignature } from '../lib/discordSignature.js';
import { createDiscordBotClient, type DiscordBotClient } from '../lib/discordBot.js';
import {
  BUTTON_CUSTOM_ID_PREFIX,
  COMM_PREF_CUSTOM_ID_PREFIX,
  PREF_CUSTOM_ID_PREFIX,
  SERVER_INVITE_CUSTOM_ID_PREFIX,
  buildProposalMessage,
  buildResolvedProposalMessage,
  buildCounteredProposalMessage,
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
  buildServerInviteMessage,
  buildServerAutoEnrolledMessage,
  buildServerEnrollConfirmationMessage,
} from '../lib/proposalMessages.js';
import { handleThreadRequest, type CommunicationPref } from '../lib/threadConsent.js';
import { PREF_DEFINITIONS, getPrefDefinition, validatePrefValue } from '../lib/prefsRegistry.js';
import { resolvePref } from '../lib/prefsResolver.js';
import { reportError } from '../lib/errorReporter.js';
import { resolveProposal } from '../lib/proposalResolve.js';
import { recordEvent as recordCommunityEvent } from '../lib/communityEvents.js';
import { getGuildTradesChannel } from '../lib/tradeGuild.js';
import { waitUntil } from '@vercel/functions';
import {
  autocompleteSignalFamilies,
  findMatches,
  lookupSignalCard,
  lookupSignalFamily,
  type SignalCard,
  type SignalFamily,
  type VariantSpec,
} from '../lib/signalMatching.js';
import {
  buildSignalPost,
  buildVariantPickerEphemeral,
  formatExpiryHint,
  SIGNAL_CUSTOM_ID_PREFIX,
} from '../lib/signalMessages.js';
import { availableItems as availableItemsTable, cardSignals, wantsItems as wantsItemsTable } from '../lib/schema.js';
import { restrictionKey } from '../lib/shared.js';

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
const INTERACTION_TYPE_APPLICATION_COMMAND_AUTOCOMPLETE = 4;
// Application command types — slash commands are type 1, user-context
// menu commands are type 2, message-context menu commands are type 3.
const APPLICATION_COMMAND_TYPE_SLASH = 1;
const APPLICATION_COMMAND_TYPE_USER = 2;
// Option types inside slash command payloads.
const OPTION_TYPE_SUB_COMMAND = 1;
const OPTION_TYPE_STRING = 3;
const OPTION_TYPE_INTEGER = 4;
const OPTION_TYPE_USER = 6;
const OPTION_TYPE_NUMBER = 10;
const INTERACTION_RESPONSE_TYPE_PONG = 1;
// Type 4 = CHANNEL_MESSAGE_WITH_SOURCE (post a new reply, visible
// to the user who clicked via `flags: 64` ephemeral bit).
const INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
// Type 8 = APPLICATION_COMMAND_AUTOCOMPLETE_RESULT — Discord shows
// the returned `choices` array as the autocomplete dropdown.
const INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE = 8;
// Type 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE — "thinking…"
// indicator. We have 15 minutes to follow up via webhook PATCH
// instead of the 3-second window for synchronous responses. Used
// when cold-start latency makes 3s tight.
const INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE = 5;
// Type 6 = DEFERRED_UPDATE_MESSAGE (ack w/o visible change).
const INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE = 6;
// Type 7 = UPDATE_MESSAGE (update the message that had the button).
const INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE = 7;
const MESSAGE_FLAG_EPHEMERAL = 64;

// --- dispatcher -------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Cron requests arrive on `?action=cron-*` paths with a Vercel-
  // injected `Authorization: Bearer <CRON_SECRET>` header. They are
  // NOT signed by Discord — branch out before the signature gate so
  // we don't 401 our own scheduled jobs.
  const action = (req.query.action as string | undefined) ?? '';
  if (action.startsWith('cron-')) {
    return handleCronRequest(req, res, action);
  }

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
  /** Injected fetch for the deferred-followup PATCH path. Tests
   *  capture invocations to assert the followup body without
   *  hitting Discord's API. */
  fetchImpl?: typeof fetch;
  /** When true, callers (tests) await the deferred followup
   *  synchronously rather than via waitUntil. Lets unit tests
   *  observe the followup PATCH within the same await. */
  awaitFollowup?: boolean;
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
    return handleApplicationCommand(payload, res, deps);
  }

  if (type === INTERACTION_TYPE_APPLICATION_COMMAND_AUTOCOMPLETE) {
    return handleAutocomplete(payload, res);
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
    if (customId.startsWith(`${SERVER_INVITE_CUSTOM_ID_PREFIX}:`)) {
      return handleServerInviteButton(payload, res);
    }
    if (customId.startsWith(`${SIGNAL_CUSTOM_ID_PREFIX}:`)) {
      return handleSignalButton(payload, res, deps);
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
  deps: BotDeps = {},
): Promise<void> {
  // ACK immediately with a deferred ephemeral. Discord shows a
  // "thinking…" indicator and gives us 15 minutes to PATCH the
  // followup, instead of the 3-second window for synchronous
  // responses. Critical because Vercel cold-starts on this big
  // function bundle (~700KB) regularly push past 3s, and
  // intermittently produced "The application did not respond"
  // errors even though the function eventually succeeded.
  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE,
    data: { flags: MESSAGE_FLAG_EPHEMERAL },
  });

  const applicationId = payload.application_id as string | undefined;
  const token = payload.token as string | undefined;
  if (!applicationId || !token) {
    console.error('handleApplicationCommand: missing application_id or token in payload');
    return;
  }

  // Build the followup payload (the actual user-visible content)
  // and PATCH the deferred message in place. Wrapped in waitUntil
  // so Vercel's runtime keeps the function alive for the followup
  // even after the deferred ACK has already been written to the
  // response stream.
  const followupWork = (async () => {
    try {
      const body = await buildApplicationCommandFollowup(payload, deps);
      await sendDeferredFollowup({
        applicationId,
        token,
        body,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      console.error('handleApplicationCommand: followup failed', err);
      await reportError({
        source: 'bot.application-command.followup',
        tags: { applicationId },
      }, err);
    }
  })();
  waitUntil(followupWork);
  // Tests can opt into awaiting the followup synchronously by
  // passing `deps.awaitFollowup = true`. Production paths skip this
  // — the response has already been written.
  if (deps.awaitFollowup) await followupWork;
}

/**
 * Compute the body of the deferred followup for an application
 * command. Returns the `data` portion of an interaction response
 * (no `type` wrapper — webhook PATCH endpoint doesn't use it).
 *
 * Split out from `handleApplicationCommand` so the ACK can fire
 * before any of the body computation runs.
 */
async function buildApplicationCommandFollowup(
  payload: Record<string, unknown>,
  deps: BotDeps,
): Promise<Record<string, unknown>> {
  const data = payload.data as {
    name?: string;
    type?: number;
    options?: Array<{ name: string; type: number; value?: unknown; options?: Array<{ name: string; type: number; value?: unknown }> }>;
    target_id?: string;
    resolved?: { users?: Record<string, { id: string; username?: string; global_name?: string }> };
  } | undefined;

  const commandType = data?.type ?? APPLICATION_COMMAND_TYPE_SLASH;
  const commandName = data?.name;

  // /looking-for and /offering land here; both are slash commands
  // (type 1) but with their OWN command name, not a sub-command of
  // /swutrade. Branch by command name first so we don't try to
  // interpret a top-level option as a /swutrade subcommand.
  if (commandType === APPLICATION_COMMAND_TYPE_SLASH
      && (commandName === 'looking-for' || commandName === 'offering')) {
    return handleSignalSlashFollowup(
      payload,
      commandName === 'looking-for' ? 'wanted' : 'offering',
      deps,
    );
  }

  let peerDiscordId: string | undefined;
  let peerUsername: string | undefined;

  if (commandType === APPLICATION_COMMAND_TYPE_USER) {
    peerDiscordId = data?.target_id;
    const resolved = data?.resolved?.users?.[peerDiscordId ?? ''];
    peerUsername = resolved?.global_name ?? resolved?.username;
  } else if (commandType === APPLICATION_COMMAND_TYPE_SLASH) {
    const subcommand = data?.options?.find(o => o.type === OPTION_TYPE_SUB_COMMAND);
    if (subcommand?.name === 'settings') {
      const userOpt = subcommand.options?.find(o => o.type === OPTION_TYPE_USER && o.name === 'user');
      if (userOpt) {
        peerDiscordId = String(userOpt.value);
        const resolved = data?.resolved?.users?.[peerDiscordId];
        peerUsername = resolved?.global_name ?? resolved?.username;
      }
    } else {
      return {
        content: 'Unknown command. Try `/swutrade settings`.',
        flags: MESSAGE_FLAG_EPHEMERAL,
      };
    }
  } else {
    return { content: '', flags: MESSAGE_FLAG_EPHEMERAL };
  }

  if (!peerDiscordId) {
    const selfDefs = PREF_DEFINITIONS.filter(
      d => d.scope.kind === 'self' && d.surfaces.includes('discord'),
    );
    return { ...buildSelfPrefsIndexMessage(selfDefs), flags: MESSAGE_FLAG_EPHEMERAL };
  }

  const db = getDb();
  const [peerRow] = await db
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(eq(users.discordId, peerDiscordId))
    .limit(1);
  if (!peerRow) {
    return {
      content: `<@${peerDiscordId}>${peerUsername ? ` (@${peerUsername})` : ''} isn't on SWUTrade yet — no per-trader settings to set.`,
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  const maybeMember = payload.member as { user?: { id?: string } } | undefined;
  const maybeUser = payload.user as { id?: string } | undefined;
  const clickerDiscordId = maybeMember?.user?.id ?? maybeUser?.id;
  if (clickerDiscordId && clickerDiscordId === peerDiscordId) {
    return {
      content: "You can't set per-trader prefs for yourself. Use `/swutrade settings` (no target user) for your global defaults.",
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  const peerDefs = PREF_DEFINITIONS.filter(
    d => d.scope.kind === 'peer' && d.surfaces.includes('discord'),
  );
  return {
    ...buildPeerPrefsIndexMessage(peerDefs, peerRow.id, peerRow.handle),
    flags: MESSAGE_FLAG_EPHEMERAL,
  };
}

/**
 * PATCH the deferred response message with the actual user-facing
 * content. Auth is the interaction `token`, not a bot token —
 * webhook routes are pre-authorized via the token Discord generated
 * for this specific interaction.
 */
async function sendDeferredFollowup(opts: {
  applicationId: string;
  token: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${opts.applicationId}/${opts.token}/messages/@original`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord followup PATCH ${res.status}: ${text.slice(0, 200)}`);
  }
}

// --- /looking-for + /offering slash handlers -------------------------------

/** Days a signal stays active before the cron sweep marks it
 *  expired. Wanted signals linger longer (your wishlist; not as
 *  urgent) while offering signals turn over fast (cards on hand at
 *  events). User can cancel either at any time. */
const SIGNAL_TTL_DAYS: Record<'wanted' | 'offering', number> = {
  wanted: 7,
  offering: 3,
};

/**
 * Handle the followup body for `/looking-for` or `/offering`.
 *
 * Side effects (in order):
 *   1. Validate the card from autocomplete payload + the guild
 *      context (must be in a guild, bot must be installed).
 *   2. Upsert the underlying inventory row (`wants_items` for wanted
 *      signals, `available_items` for offering).
 *   3. Insert the `card_signals` row.
 *   4. Post the public signal embed in the channel via the bot
 *      client; UPDATE the signal with the message_id.
 *   5. Find guild matches; DM each (gated on dm_match_alerts).
 *
 * Returns the ephemeral followup body for the slash itself —
 * "Posted! N matches pinged." or an error explanation.
 */
async function handleSignalSlashFollowup(
  payload: Record<string, unknown>,
  kind: 'wanted' | 'offering',
  _deps: BotDeps,
): Promise<Record<string, unknown>> {
  const guildId = payload.guild_id as string | undefined;
  if (!guildId) {
    return {
      content: '`/looking-for` and `/offering` only work inside a server (not in DMs).',
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  const channelId = payload.channel_id as string | undefined;
  if (!channelId) {
    return { content: 'Discord didn\'t supply a channel id.', flags: MESSAGE_FLAG_EPHEMERAL };
  }

  const clickerDiscordId =
    (payload.member as { user?: { id?: string } } | undefined)?.user?.id
    ?? (payload.user as { id?: string } | undefined)?.id;
  if (!clickerDiscordId) {
    return { content: 'Couldn\'t identify the user from the interaction.', flags: MESSAGE_FLAG_EPHEMERAL };
  }

  const data = payload.data as {
    options?: Array<{ name: string; type: number; value?: unknown }>;
  } | undefined;
  const opts = data?.options ?? [];

  // Parse 1-5 card slots. `card` is required; `card2`..`card5` are
  // optional. Variant arg only applies to the primary card —
  // multi-card secondaries default to "any" with the post-hoc
  // Specify-variant button (deferred for multi-card to PR2).
  const cardKeys = ['card', 'card2', 'card3', 'card4', 'card5'] as const;
  const familyIds: Array<{ key: string; familyId: string }> = [];
  for (const key of cardKeys) {
    const opt = opts.find(o => o.name === key);
    if (opt && typeof opt.value === 'string' && opt.value.length > 0) {
      // Sentinel — the user submitted the slash with the autocomplete
      // hint row still selected (didn't actually pick a card).
      if (opt.value === '__signal-hint__') {
        return {
          content: `The \`${key}\` slot needs a real card — type to search the autocomplete.`,
          flags: MESSAGE_FLAG_EPHEMERAL,
        };
      }
      familyIds.push({ key, familyId: opt.value });
    }
  }
  if (familyIds.length === 0) {
    return { content: 'Pick at least one card from the autocomplete list.', flags: MESSAGE_FLAG_EPHEMERAL };
  }

  // Resolve each family + the primary's variant.
  const variantOpt = opts.find(o => o.name === 'variant');
  const variantOptValue = typeof variantOpt?.value === 'string' ? variantOpt.value : null;
  if (variantOptValue === '__signal-hint__') {
    return {
      content: 'The `variant` slot needs a real printing — type to search the autocomplete.',
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }
  const requestedVariant = variantOptValue && variantOptValue.length > 0 ? variantOptValue : null;

  type ResolvedCard = {
    family: ReturnType<typeof lookupSignalFamily>;
    variantSpec: VariantSpec;
    representativeProductId: string;
  };
  const resolvedCards: ResolvedCard[] = [];
  for (let i = 0; i < familyIds.length; i++) {
    const family = lookupSignalFamily(familyIds[i].familyId);
    if (!family) {
      return {
        content: `Couldn't find one of the cards in the SWUTrade index. Pick from the autocomplete list.`,
        flags: MESSAGE_FLAG_EPHEMERAL,
      };
    }
    // Variant arg only narrows the primary card.
    const isPrimary = i === 0;
    const variantSpec: VariantSpec = isPrimary
      && requestedVariant
      && family.variants.some(v => v.variant === requestedVariant)
      ? { mode: 'restricted', variants: [requestedVariant] }
      : { mode: 'any' };
    const representativeProductId = variantSpec.mode === 'restricted'
      ? family.variants.find(v => v.variant === variantSpec.variants[0])!.productId
      : family.variants[0].productId;
    resolvedCards.push({ family, variantSpec, representativeProductId });
  }

  const qty = Math.max(1, Math.min(99, Number(opts.find(o => o.name === 'qty')?.value ?? 1) || 1));
  const note = (() => {
    const v = opts.find(o => o.name === 'note')?.value;
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  })();
  const maxPriceRaw = opts.find(o => o.name === 'max_price')?.value;
  const maxUnitPrice = typeof maxPriceRaw === 'number' && maxPriceRaw > 0 ? maxPriceRaw : null;

  const db = getDb();

  // Resolve the SWUTrade user from the Discord id.
  const [signaler] = await db
    .select({ id: users.id, handle: users.handle, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.discordId, clickerDiscordId))
    .limit(1);
  if (!signaler) {
    return {
      content: 'Sign in with Discord at <https://swutrade.com> first — your post needs to attach to a SWUTrade account.',
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  // Ensure the bot is installed in this guild.
  const [installRow] = await db
    .select({ guildId: botInstalledGuilds.guildId })
    .from(botInstalledGuilds)
    .where(eq(botInstalledGuilds.guildId, guildId))
    .limit(1);
  if (!installRow) {
    return {
      content: 'SWUTrade isn\'t installed in this server.',
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  // Group all rows under one id. Single-card sets groupId = signalId
  // for query symmetry — group lookups always work the same way.
  const groupId = randomUUID();
  const expiresAt = new Date(Date.now() + SIGNAL_TTL_DAYS[kind] * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Insert each card's inventory row (wants/available) + signal row
  // with status='draft'. The preview ephemeral is the user's
  // confirmation gate before anything goes public.
  const draftRows: Array<{
    signalId: string;
    family: NonNullable<ReturnType<typeof lookupSignalFamily>>;
    variantSpec: VariantSpec;
    representativeProductId: string;
    matchedUsers: Awaited<ReturnType<typeof findMatches>>;
  }> = [];

  for (const rc of resolvedCards) {
    const family = rc.family!;
    let inventoryRowId: string;
    if (kind === 'wanted') {
      const wantsId = `w-${randomUUID().slice(0, 12)}`;
      const restriction = rc.variantSpec.mode === 'any'
        ? { mode: 'any' as const }
        : { mode: 'restricted' as const, variants: rc.variantSpec.variants };
      await db.insert(wantsItemsTable).values({
        id: wantsId,
        userId: signaler.id,
        familyId: family.familyId,
        qty,
        restrictionMode: restriction.mode,
        restrictionVariants: restriction.mode === 'restricted' ? restriction.variants : null,
        restrictionKey: restrictionKey(restriction),
        maxUnitPrice: maxUnitPrice != null ? String(maxUnitPrice) : null,
        isPriority: true,
        addedAt: now.getTime(),
      }).onConflictDoUpdate({
        target: [wantsItemsTable.userId, wantsItemsTable.familyId, wantsItemsTable.restrictionKey],
        set: {
          qty: sql`GREATEST(${wantsItemsTable.qty}, ${qty})`,
          isPriority: true,
          updatedAt: now,
        },
      });
      const [row] = await db
        .select({ id: wantsItemsTable.id })
        .from(wantsItemsTable)
        .where(and(
          eq(wantsItemsTable.userId, signaler.id),
          eq(wantsItemsTable.familyId, family.familyId),
          eq(wantsItemsTable.restrictionKey, restrictionKey(restriction)),
        ))
        .limit(1);
      inventoryRowId = row.id;
    } else {
      const availId = `a-${randomUUID().slice(0, 12)}`;
      await db.insert(availableItemsTable).values({
        id: availId,
        userId: signaler.id,
        productId: rc.representativeProductId,
        qty,
        addedAt: now.getTime(),
      }).onConflictDoUpdate({
        target: [availableItemsTable.userId, availableItemsTable.productId],
        set: {
          qty: sql`GREATEST(${availableItemsTable.qty}, ${qty})`,
          updatedAt: now,
        },
      });
      const [row] = await db
        .select({ id: availableItemsTable.id })
        .from(availableItemsTable)
        .where(and(
          eq(availableItemsTable.userId, signaler.id),
          eq(availableItemsTable.productId, rc.representativeProductId),
        ))
        .limit(1);
      inventoryRowId = row.id;
    }

    const signalId = randomUUID();
    await db.insert(cardSignals).values({
      id: signalId,
      userId: signaler.id,
      kind,
      groupId,
      wantsItemId: kind === 'wanted' ? inventoryRowId : null,
      availableItemId: kind === 'offering' ? inventoryRowId : null,
      guildId,
      channelId,
      expiresAt,
      signalNote: note,
      maxUnitPrice: maxUnitPrice != null ? String(maxUnitPrice) : null,
      status: 'draft',
    });

    // Compute matches now so the preview embed can show them. We
    // also re-compute on confirm (in case inventory shifts in
    // those few seconds), but the preview is the user's view.
    const matchedUsers = await findMatches(db, {
      kind,
      family,
      variant: rc.variantSpec,
      guildId,
      requesterUserId: signaler.id,
      eventId: null,
    });

    draftRows.push({ signalId, family, variantSpec: rc.variantSpec, representativeProductId: rc.representativeProductId, matchedUsers });
  }

  // Build the preview ephemeral. Same embed builder as the live
  // post; the action row flips to Confirm + Cancel via mode='preview'.
  // Add `flags: 64` (ephemeral) so the preview is only visible to
  // the slash author — the followup PATCH replaces the deferred
  // ack message Discord already marked as ephemeral.
  const previewBody = buildSignalPost({
    groupId,
    kind,
    status: 'draft',
    mode: 'preview',
    cards: draftRows.map(r => ({
      signalId: r.signalId,
      name: r.family.name,
      setCode: r.family.setCode,
      cardType: r.family.cardType,
      productId: r.representativeProductId,
      variantSpec: r.variantSpec,
      qty,
      matchedUsers: r.matchedUsers.map(m => ({ discordId: m.discordId, handle: m.handle })),
    })),
    note,
    maxUnitPrice,
    requester: { discordId: clickerDiscordId, handle: signaler.handle, avatarUrl: signaler.avatarUrl },
    expiryHint: formatExpiryHint(expiresAt, now),
  });
  return { ...previewBody, flags: MESSAGE_FLAG_EPHEMERAL } as unknown as Record<string, unknown>;
}

// --- autocomplete handler --------------------------------------------------

/**
 * Discord-side autocomplete for /looking-for and /offering. Returns
 * up to 25 cards whose name matches the focused option's value.
 *
 * Synchronous response (Discord requires <3s; autocomplete doesn't
 * support deferral). The card index is in-memory after first load
 * so warm calls are sub-ms; cold start has the same Vercel cold-
 * start risk as everything else but autocomplete doesn't show the
 * "didn't respond in time" error — Discord just shows an empty
 * dropdown, which the user can retype to retrigger.
 */
async function handleAutocomplete(
  payload: Record<string, unknown>,
  res: VercelResponse,
): Promise<void> {
  const data = payload.data as {
    name?: string;
    options?: Array<{ name: string; type: number; value?: unknown; focused?: boolean }>;
  } | undefined;

  const focused = data?.options?.find(o => o.focused);
  if (!focused) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE, data: { choices: [] } });
    return;
  }

  // `event` autocomplete is reserved for LGS — empty until the
  // events table exists.
  if (focused.name === 'event') {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE, data: { choices: [] } });
    return;
  }

  // `card`, `card2`, `card3`, `card4`, `card5` all share the
  // family-level autocomplete — the slash handler resolves each
  // independently, but the dropdown logic is identical.
  if (focused.name === 'card' || /^card[2-5]$/.test(focused.name ?? '')) {
    const query = typeof focused.value === 'string' ? focused.value : '';
    // Empty input → render a single hint choice so the dropdown
    // isn't a blank box. The slash handler rejects the sentinel
    // value with a friendly error if the user somehow submits it.
    if (query.trim().length === 0) {
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE,
        data: { choices: [{ name: 'Start typing to search SWUTrade\'s card index…', value: '__signal-hint__' }] },
      });
      return;
    }
    const families = autocompleteSignalFamilies(query, 25);
    if (families.length === 0) {
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE,
        data: { choices: [{ name: `No matches for "${query}". Try a partial name (e.g., "luke").`, value: '__signal-hint__' }] },
      });
      return;
    }
    const choices = families.map(f => {
      // Format: "Card Name [SET] (Leader) (+N printings)"
      // Examples:
      //   "Luke Skywalker - Faithful Friend [SOR] (Leader) (+4 printings)"
      //   "Aggressive Negotiations [SEC]"
      // Set code helps disambiguate when reprints exist; the
      // (Leader) tag lets users instantly tell if the autocomplete
      // hit a leader they meant or a same-named non-leader (e.g.
      // when typing partial names).
      const parts = [f.name, `[${f.setCode}]`];
      if (f.cardType === 'Leader') parts.push('(Leader)');
      if (f.alternateCount > 0) {
        parts.push(`(+${f.alternateCount} printing${f.alternateCount === 1 ? '' : 's'})`);
      }
      return {
        name: parts.join(' ').slice(0, 100),
        value: f.familyId.slice(0, 100),
      };
    });
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE, data: { choices } });
    return;
  }

  if (focused.name === 'variant') {
    // Variant autocomplete is contextual: read the user's already-
    // picked `card:` value (a family id) and return only the
    // variants that family actually has. Discord includes ALL
    // currently-filled options on the autocomplete payload, so we
    // can drill into the sibling `card:` arg without state.
    const cardOpt = data?.options?.find(o => o.name === 'card');
    const familyId = typeof cardOpt?.value === 'string' ? cardOpt.value : null;
    if (!familyId || familyId === '__signal-hint__') {
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE,
        data: { choices: [{ name: 'Pick a card first, then come back to specify a variant.', value: '__signal-hint__' }] },
      });
      return;
    }
    const family = lookupSignalFamily(familyId);
    if (!family) {
      res.status(200).json({
        type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE,
        data: { choices: [{ name: 'Couldn\'t find that card — repick from the autocomplete.', value: '__signal-hint__' }] },
      });
      return;
    }
    const query = typeof focused.value === 'string' ? focused.value.toLowerCase() : '';
    const filtered = query.length === 0
      ? family.variants
      : family.variants.filter(v => v.variant.toLowerCase().includes(query));
    const choices = filtered.slice(0, 25).map(v => ({
      name: v.market != null ? `${v.variant} · ~$${v.market.toFixed(2)}` : v.variant,
      value: v.variant,
    }));
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE, data: { choices } });
    return;
  }

  // Unknown focused option — empty choices (Discord renders nothing).
  res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_AUTOCOMPLETE, data: { choices: [] } });
}

// --- signal: button handler ------------------------------------------------

/**
 * Cancel button on a signal post (`signal:<id>:cancel`). Owner-only.
 * Responds with type 7 UPDATE_MESSAGE so the embed flips to the
 * cancelled state in place — same pattern as the trade-proposal
 * resolved-message PATCH.
 */
async function handleSignalButton(
  payload: Record<string, unknown>,
  res: VercelResponse,
  deps: BotDeps,
): Promise<void> {
  const data = payload.data as {
    custom_id?: string;
    values?: string[];
    component_type?: number;
  } | undefined;
  const parts = (data?.custom_id ?? '').split(':');
  if (parts.length < 3 || parts[0] !== SIGNAL_CUSTOM_ID_PREFIX) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }
  // The id slot is either a row id (for variant-* actions) or a
  // group id (for cancel / confirm-draft / cancel-draft). Single-
  // card signals have groupId === rowId so both lookups work the
  // same way for those.
  const id = parts[1];
  const action = parts[2];

  const clickerDiscordId =
    (payload.member as { user?: { id?: string } } | undefined)?.user?.id
    ?? (payload.user as { id?: string } | undefined)?.id;
  if (!clickerDiscordId) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  const db = getDb();
  const [clicker] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.discordId, clickerDiscordId))
    .limit(1);
  if (!clicker) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: 'Sign in with Discord at <https://swutrade.com> first.',
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  // Group-scoped actions: cancel, confirm-draft, cancel-draft.
  // Row-scoped actions: variant-open, variant-pick.
  const isGroupAction = action === 'cancel'
    || action === 'confirm-draft'
    || action === 'cancel-draft';

  if (isGroupAction) {
    return handleSignalGroupAction({
      groupId: id,
      action,
      clickerUserId: clicker.id,
      res,
      deps,
    });
  }

  // Row-scoped: variant-open, variant-pick.
  const [signal] = await db
    .select()
    .from(cardSignals)
    .where(eq(cardSignals.id, id))
    .limit(1);
  if (!signal) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'This signal post no longer exists.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }
  if (signal.userId !== clicker.id) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: `Only the post's author can change the variant.`, flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }
  if (signal.status !== 'active') {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: `This signal is already ${signal.status}.`, flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }
  const [signaler] = await db
    .select({ id: users.id, handle: users.handle, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, signal.userId))
    .limit(1);
  if (!signaler) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  switch (action) {
    case 'variant-open':
      return handleVariantOpen(signal, res);
    case 'variant-pick': {
      const picked = data?.values?.[0];
      if (!picked) {
        res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
        return;
      }
      return handleVariantPick(signal, signaler, picked, res, deps);
    }
    default:
      res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
  }
}

/**
 * Group-scoped button actions: cancel a live group, confirm a
 * draft (post the public message), or cancel a draft (discard).
 *
 * Auth check is shared: the clicker must own the group's signals.
 * The first row's userId is the canonical owner — every row in a
 * group has the same userId by construction.
 */
async function handleSignalGroupAction(args: {
  groupId: string;
  action: string;
  clickerUserId: string;
  res: VercelResponse;
  deps: BotDeps;
}): Promise<void> {
  const { groupId, action, clickerUserId, res, deps } = args;
  const db = getDb();

  const groupRows = await db
    .select()
    .from(cardSignals)
    .where(eq(cardSignals.groupId, groupId));

  if (groupRows.length === 0) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'This signal post no longer exists.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  const ownerId = groupRows[0].userId;
  if (ownerId !== clickerUserId) {
    const verb = action === 'cancel' ? 'cancel it'
      : action === 'confirm-draft' ? 'post it'
      : action === 'cancel-draft' ? 'discard it'
      : 'modify it';
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: `Only the post's author can ${verb}.`,
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  switch (action) {
    case 'confirm-draft':
      return handleConfirmDraft(groupId, groupRows, res, deps);
    case 'cancel-draft':
      return handleCancelDraft(groupId, groupRows, res);
    case 'cancel':
      return handleCancelLive(groupId, groupRows, res, deps);
    default:
      res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
  }
}

/**
 * Confirm a draft group: flip every row from `draft` → `active`,
 * post the public embed in the original channel, store the
 * resulting message_id on every row, and PATCH the ephemeral
 * preview into a "Posted!" confirmation.
 *
 * Re-runs `findMatches` per card just before posting so the
 * public surface reflects the freshest matchable inventory (vs
 * the stale snapshot the preview had if the user lingered).
 */
async function handleConfirmDraft(
  groupId: string,
  groupRows: Array<typeof cardSignals.$inferSelect>,
  res: VercelResponse,
  deps: BotDeps,
): Promise<void> {
  const db = getDb();

  // All rows in the group share status. If any aren't draft, the
  // group already published — bail.
  if (groupRows.some(r => r.status !== 'draft')) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'This signal already posted (or was cancelled).', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  const [signaler] = await db
    .select({ id: users.id, handle: users.handle, avatarUrl: users.avatarUrl, discordId: users.discordId })
    .from(users)
    .where(eq(users.id, groupRows[0].userId))
    .limit(1);
  if (!signaler) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  // Resolve each row's family + variantSpec (read from the
  // inventory row written during the slash) + recompute matches.
  const cards = await Promise.all(groupRows.map(async (row) => {
    const family = await resolveSignalFamily(row);
    const variantSpec = await resolveVariantSpec(row);
    if (!family) return null;
    const matches = await findMatches(db, {
      kind: row.kind,
      family,
      variant: variantSpec,
      guildId: row.guildId,
      requesterUserId: row.userId,
      eventId: null,
    });
    const representative = variantSpec.mode === 'restricted'
      ? family.variants.find(v => v.variant === variantSpec.variants[0]) ?? family.variants[0]
      : family.variants[0];
    return {
      signalId: row.id,
      name: family.name,
      setCode: family.setCode,
      cardType: family.cardType,
      productId: representative.productId,
      variantSpec,
      qty: 1, // qty lives on the inventory row but the embed only needs a label; pull from the row directly when re-rendering
      matchedUsers: matches.map(m => ({ discordId: m.discordId, handle: m.handle })),
    };
  }));

  if (cards.some(c => c === null)) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'Couldn\'t resolve one of the cards. The signal may reference deleted inventory.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  // Pull qty from the wants_items / available_items row per card
  // (the qty option on the slash applies to all cards in the
  // group, but we read from the source of truth in case it drifted).
  for (let i = 0; i < cards.length; i++) {
    const row = groupRows[i];
    if (row.kind === 'wanted' && row.wantsItemId) {
      const [w] = await db.select({ qty: wantsItemsTable.qty }).from(wantsItemsTable).where(eq(wantsItemsTable.id, row.wantsItemId)).limit(1);
      if (w) cards[i]!.qty = w.qty;
    } else if (row.kind === 'offering' && row.availableItemId) {
      const [a] = await db.select({ qty: availableItemsTable.qty }).from(availableItemsTable).where(eq(availableItemsTable.id, row.availableItemId)).limit(1);
      if (a) cards[i]!.qty = a.qty;
    }
  }

  const firstRow = groupRows[0];
  const embedBody = buildSignalPost({
    groupId,
    kind: firstRow.kind,
    status: 'active',
    mode: 'live',
    cards: cards.map(c => c!),
    note: firstRow.signalNote,
    maxUnitPrice: firstRow.maxUnitPrice ? Number(firstRow.maxUnitPrice) : null,
    requester: { discordId: signaler.discordId, handle: signaler.handle, avatarUrl: signaler.avatarUrl },
    expiryHint: formatExpiryHint(firstRow.expiresAt),
  });

  // Post the public message.
  const bot = deps.bot ?? createDiscordBotClient();
  let postedMessageId: string;
  try {
    const posted = await bot.postChannelMessage(firstRow.channelId, embedBody);
    postedMessageId = posted.id;
  } catch (err) {
    console.error('handleConfirmDraft: postChannelMessage failed', err);
    await reportError({
      source: 'bot.signal-confirm-draft.post',
      tags: { groupId, channelId: firstRow.channelId },
    }, err);
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'Couldn\'t post — bot might be missing permissions to send messages here.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  // Flip every draft row to active + record the message id.
  await db.update(cardSignals)
    .set({ status: 'active', messageId: postedMessageId })
    .where(eq(cardSignals.groupId, groupId));

  // Replace the ephemeral preview with a "Posted!" confirmation.
  const channelId = firstRow.channelId;
  const guildId = firstRow.guildId;
  const messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${postedMessageId}`;
  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
    data: {
      content: `Posted! [Open the post →](${messageUrl})`,
      embeds: [],
      components: [],
      flags: MESSAGE_FLAG_EPHEMERAL,
    },
  });
}

/**
 * Cancel a draft group: delete the draft rows. Inventory rows
 * (`wants_items` / `available_items`) are left in place — the user
 * intentionally typed those cards, and removing them silently
 * would surprise them. The ephemeral copy mentions this so they
 * know where to manage if they want to clean up.
 */
async function handleCancelDraft(
  groupId: string,
  groupRows: Array<typeof cardSignals.$inferSelect>,
  res: VercelResponse,
): Promise<void> {
  if (groupRows.some(r => r.status !== 'draft')) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'This signal already posted; use Cancel post to retire it.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  const db = getDb();
  await db.delete(cardSignals).where(eq(cardSignals.groupId, groupId));

  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
    data: {
      content: 'Cancelled. *(The cards stayed in your wishlist/binder — manage them at swutrade.com if you want to remove.)*',
      embeds: [],
      components: [],
      flags: MESSAGE_FLAG_EPHEMERAL,
    },
  });
}

/**
 * Cancel a live (active) group. Marks every row cancelled,
 * PATCHes the public message via UPDATE_MESSAGE response so the
 * embed strikes through in place.
 */
async function handleCancelLive(
  groupId: string,
  groupRows: Array<typeof cardSignals.$inferSelect>,
  res: VercelResponse,
  _deps: BotDeps,
): Promise<void> {
  if (groupRows.some(r => r.status !== 'active')) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: `This signal is already ${groupRows[0].status}.`, flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  const db = getDb();
  await db.update(cardSignals)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(cardSignals.groupId, groupId));

  // Re-render the (now cancelled) embed using the same data the
  // post had. Match listings are kept since they're cosmetic at
  // this point.
  const [signaler] = await db
    .select({ id: users.id, handle: users.handle, avatarUrl: users.avatarUrl, discordId: users.discordId })
    .from(users)
    .where(eq(users.id, groupRows[0].userId))
    .limit(1);

  const cards = await Promise.all(groupRows.map(async (row) => {
    const family = await resolveSignalFamily(row);
    const variantSpec = await resolveVariantSpec(row);
    if (!family) return null;
    const representative = variantSpec.mode === 'restricted'
      ? family.variants.find(v => v.variant === variantSpec.variants[0]) ?? family.variants[0]
      : family.variants[0];
    return {
      signalId: row.id,
      name: family.name,
      setCode: family.setCode,
      cardType: family.cardType,
      productId: representative.productId,
      variantSpec,
      qty: 1,
      matchedUsers: [],
    };
  }));

  const firstRow = groupRows[0];
  const cancelledEmbed = buildSignalPost({
    groupId,
    kind: firstRow.kind,
    status: 'cancelled',
    mode: 'live',
    cards: cards.filter(c => c !== null) as Array<NonNullable<typeof cards[number]>>,
    note: firstRow.signalNote,
    maxUnitPrice: firstRow.maxUnitPrice ? Number(firstRow.maxUnitPrice) : null,
    requester: {
      discordId: signaler?.discordId ?? null,
      handle: signaler?.handle ?? '?',
      avatarUrl: signaler?.avatarUrl ?? null,
    },
    expiryHint: '',
  });

  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
    data: cancelledEmbed,
  });
}

/** Family lookup helper for signal-flow handlers — resolves the
 *  family attached to either a wants_items or available_items row. */
async function resolveSignalFamily(
  signal: typeof cardSignals.$inferSelect,
): Promise<SignalFamily | null> {
  const db = getDb();
  if (signal.kind === 'wanted' && signal.wantsItemId) {
    const [row] = await db
      .select({ familyId: wantsItemsTable.familyId })
      .from(wantsItemsTable)
      .where(eq(wantsItemsTable.id, signal.wantsItemId))
      .limit(1);
    return row ? lookupSignalFamily(row.familyId) : null;
  }
  if (signal.kind === 'offering' && signal.availableItemId) {
    const [row] = await db
      .select({ productId: availableItemsTable.productId })
      .from(availableItemsTable)
      .where(eq(availableItemsTable.id, signal.availableItemId))
      .limit(1);
    if (!row) return null;
    const card = lookupSignalCard(row.productId);
    return card ? lookupSignalFamily(card.familyId) : null;
  }
  return null;
}

/** Compute the current variantSpec from a signal's underlying
 *  inventory row. For wanted: read wants_items.restriction_mode +
 *  variants. For offering: always 'restricted' to the chosen
 *  product's variant (since available_items is product-keyed). */
async function resolveVariantSpec(
  signal: typeof cardSignals.$inferSelect,
): Promise<VariantSpec> {
  const db = getDb();
  if (signal.kind === 'wanted' && signal.wantsItemId) {
    const [row] = await db
      .select({
        restrictionMode: wantsItemsTable.restrictionMode,
        restrictionVariants: wantsItemsTable.restrictionVariants,
      })
      .from(wantsItemsTable)
      .where(eq(wantsItemsTable.id, signal.wantsItemId))
      .limit(1);
    if (!row || row.restrictionMode === 'any') return { mode: 'any' };
    return { mode: 'restricted', variants: row.restrictionVariants ?? [] };
  }
  if (signal.kind === 'offering' && signal.availableItemId) {
    const [row] = await db
      .select({ productId: availableItemsTable.productId })
      .from(availableItemsTable)
      .where(eq(availableItemsTable.id, signal.availableItemId))
      .limit(1);
    if (!row) return { mode: 'any' };
    const card = lookupSignalCard(row.productId);
    return card ? { mode: 'restricted', variants: [card.variant] } : { mode: 'any' };
  }
  return { mode: 'any' };
}

async function handleVariantOpen(
  signal: typeof cardSignals.$inferSelect,
  res: VercelResponse,
): Promise<void> {
  const family = await resolveSignalFamily(signal);
  if (!family) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'Couldn\'t resolve this signal\'s card.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }
  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
    data: buildVariantPickerEphemeral({
      signalId: signal.id,
      familyName: family.name,
      variants: family.variants,
    }),
  });
}

async function handleVariantPick(
  signal: typeof cardSignals.$inferSelect,
  signaler: { handle: string; avatarUrl: string | null },
  pickedVariant: string,
  res: VercelResponse,
  deps: BotDeps,
): Promise<void> {
  const family = await resolveSignalFamily(signal);
  if (!family || !family.variants.some(v => v.variant === pickedVariant)) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'That variant doesn\'t exist for this card.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  const db = getDb();

  // Update the underlying wants_items / available_items row to
  // narrow its variant. For wanted: flip restriction to
  // 'restricted' with the picked variant. For offering: re-point
  // available_items.product_id to the picked variant's product.
  if (signal.kind === 'wanted' && signal.wantsItemId) {
    const newRestriction = { mode: 'restricted' as const, variants: [pickedVariant] };
    await db.update(wantsItemsTable)
      .set({
        restrictionMode: newRestriction.mode,
        restrictionVariants: newRestriction.variants,
        restrictionKey: restrictionKey(newRestriction),
        updatedAt: new Date(),
      })
      .where(eq(wantsItemsTable.id, signal.wantsItemId));
  } else if (signal.kind === 'offering' && signal.availableItemId) {
    const product = family.variants.find(v => v.variant === pickedVariant)!;
    await db.update(availableItemsTable)
      .set({ productId: product.productId, updatedAt: new Date() })
      .where(eq(availableItemsTable.id, signal.availableItemId));
  }

  // PATCH the public signal post with the new variant baked in.
  // Variant pinning is single-card-only (the multi-card embed
  // hides the button), so we re-render the post as a single-card
  // group reflecting the new variant.
  const bot = deps.bot ?? createDiscordBotClient();
  if (signal.messageId) {
    const newVariantSpec: VariantSpec = { mode: 'restricted', variants: [pickedVariant] };
    const product = family.variants.find(v => v.variant === pickedVariant)!;
    // Pull current qty from the inventory row.
    const db2 = getDb();
    let qty = 1;
    if (signal.kind === 'wanted' && signal.wantsItemId) {
      const [w] = await db2.select({ qty: wantsItemsTable.qty }).from(wantsItemsTable).where(eq(wantsItemsTable.id, signal.wantsItemId)).limit(1);
      if (w) qty = w.qty;
    } else if (signal.kind === 'offering' && signal.availableItemId) {
      const [a] = await db2.select({ qty: availableItemsTable.qty }).from(availableItemsTable).where(eq(availableItemsTable.id, signal.availableItemId)).limit(1);
      if (a) qty = a.qty;
    }
    // Recompute matches with the narrower variant restriction.
    const matches = await findMatches(db2, {
      kind: signal.kind,
      family,
      variant: newVariantSpec,
      guildId: signal.guildId,
      requesterUserId: signal.userId,
      eventId: null,
    });
    try {
      await bot.editChannelMessage(signal.channelId, signal.messageId, buildSignalPost({
        groupId: signal.groupId ?? signal.id,
        kind: signal.kind,
        status: 'active',
        mode: 'live',
        cards: [{
          signalId: signal.id,
          name: family.name,
          setCode: family.setCode,
          cardType: family.cardType,
          productId: product.productId,
          variantSpec: newVariantSpec,
          qty,
          matchedUsers: matches.map(m => ({ discordId: m.discordId, handle: m.handle })),
        }],
        note: signal.signalNote,
        maxUnitPrice: signal.maxUnitPrice ? Number(signal.maxUnitPrice) : null,
        requester: { discordId: null, handle: signaler.handle, avatarUrl: signaler.avatarUrl },
        expiryHint: formatExpiryHint(signal.expiresAt),
      }));
    } catch (err) {
      console.error('handleVariantPick: editChannelMessage failed', err);
    }
  }

  // Edit the ephemeral picker into a confirmation.
  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
    data: {
      content: `Pinned to **${pickedVariant}**. The post above has been updated.`,
      flags: MESSAGE_FLAG_EPHEMERAL,
      components: [],
    },
  });
}

// --- cron handlers ----------------------------------------------------------

/**
 * Cron entrypoints. Authorization is `Bearer <CRON_SECRET>` —
 * Vercel injects this header on scheduled cron invocations using
 * the `CRON_SECRET` env var that the platform manages.
 */
async function handleCronRequest(
  req: VercelRequest,
  res: VercelResponse,
  action: string,
): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(`cron: CRON_SECRET not set — refusing ${action}`);
    res.status(500).json({ error: 'cron not configured' });
    return;
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (action === 'cron-signals') {
    return runSignalExpirySweep(res);
  }

  res.status(404).json({ error: `unknown cron action ${action}` });
}

/**
 * Find active signals past `expires_at`, mark them expired, and
 * PATCH each post's embed so the channel reflects the state. Best-
 * effort per-signal — a single PATCH failure is logged but doesn't
 * abort the sweep.
 */
async function runSignalExpirySweep(res: VercelResponse): Promise<void> {
  const db = getDb();

  // 1. Stale-draft sweep: drafts older than 1h were abandoned (the
  //    user closed Discord, never confirmed). Delete to keep the
  //    table tidy. This is non-destructive — only signal rows;
  //    inventory rows the slash inserted stay (those are the
  //    user's wishlist/binder, not the post).
  const staleDraftThreshold = new Date(Date.now() - 60 * 60 * 1000);
  const deletedDrafts = await db
    .delete(cardSignals)
    .where(and(
      eq(cardSignals.status, 'draft'),
      sql`${cardSignals.createdAt} < ${staleDraftThreshold}`,
    ))
    .returning({ id: cardSignals.id });

  // 2. Active-expiry sweep: walk active signals past their
  //    expires_at. Group by groupId so we handle multi-card
  //    signals atomically — the public message represents the
  //    whole group; we only PATCH it once.
  const overdue = await db
    .select()
    .from(cardSignals)
    .where(and(
      eq(cardSignals.status, 'active'),
      sql`${cardSignals.expiresAt} < now()`,
    ));

  if (overdue.length === 0) {
    res.status(200).json({ ok: true, expired: 0, staleDraftsDeleted: deletedDrafts.length });
    return;
  }

  // Group rows by groupId. Single-card signals end up in their own
  // group. Multi-card share.
  const byGroup = new Map<string, typeof overdue>();
  for (const row of overdue) {
    const key = row.groupId ?? row.id;
    const list = byGroup.get(key) ?? [];
    list.push(row);
    byGroup.set(key, list);
  }

  const bot = createDiscordBotClient();
  let expired = 0;
  let patchFailures = 0;

  for (const [groupId, rows] of byGroup) {
    // Flip every row's status FIRST so a flaky Discord PATCH
    // doesn't keep us re-sweeping the same group next day.
    await db.update(cardSignals)
      .set({ status: 'expired' })
      .where(eq(cardSignals.groupId, groupId));
    expired += rows.length;

    const firstRow = rows[0];
    if (!firstRow.messageId) continue;

    const [signaler] = await db
      .select({ handle: users.handle, avatarUrl: users.avatarUrl, discordId: users.discordId })
      .from(users)
      .where(eq(users.id, firstRow.userId))
      .limit(1);

    const cards = await Promise.all(rows.map(async (row) => {
      const family = await resolveSignalFamily(row);
      const variantSpec = await resolveVariantSpec(row);
      if (!family) return null;
      const representative = variantSpec.mode === 'restricted'
        ? family.variants.find(v => v.variant === variantSpec.variants[0]) ?? family.variants[0]
        : family.variants[0];
      return {
        signalId: row.id,
        name: family.name,
        setCode: family.setCode,
        cardType: family.cardType,
        productId: representative.productId,
        variantSpec,
        qty: 1,
        matchedUsers: [],
      };
    }));

    const expiredEmbed = buildSignalPost({
      groupId,
      kind: firstRow.kind,
      status: 'expired',
      mode: 'live',
      cards: cards.filter(c => c !== null) as Array<NonNullable<typeof cards[number]>>,
      note: firstRow.signalNote,
      maxUnitPrice: firstRow.maxUnitPrice ? Number(firstRow.maxUnitPrice) : null,
      requester: {
        discordId: signaler?.discordId ?? null,
        handle: signaler?.handle ?? '?',
        avatarUrl: signaler?.avatarUrl ?? null,
      },
      expiryHint: '',
    });

    try {
      await bot.editChannelMessage(firstRow.channelId, firstRow.messageId, expiredEmbed);
    } catch (err) {
      patchFailures += 1;
      console.error('cron-signals: editChannelMessage failed', { groupId, err });
      await reportError({
        source: 'bot.cron-signals.embed-patch',
        tags: { groupId },
      }, err);
    }
  }

  res.status(200).json({ ok: true, expired, staleDraftsDeleted: deletedDrafts.length, patchFailures });
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

  // Shared state transition + event log + proposer notification.
  // Both the Discord button path (here) and the web endpoint
  // (`api/trades.ts::handleAcceptDecline`) funnel through this so
  // the recipient sees the same DM edit, the proposer sees the
  // same notification, and the activity timeline records the same
  // event regardless of which surface drove the action.
  //
  // `resolveProposal` may return `already-resolved` if a racing
  // click or web call landed between our status check above and
  // its optimistic UPDATE. Either way the final body we send is
  // the resolved banner — idempotent from the clicker's POV.
  const result = await resolveProposal({
    proposalId: trade.id,
    actorUserId: recipient.id,
    newStatus,
    deps: { db, bot: deps.bot },
  });

  if (result.status === 'not-found') {
    // Defensive — we already confirmed recipient + existence above.
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }

  // Response protocol: UPDATE_MESSAGE (type 7) swaps the button row
  // in place so the recipient's DM reflects the outcome immediately,
  // even though `resolveProposal` also PATCHes the same message via
  // its DM-edit side effect. The PATCH is idempotent (same body,
  // empty components) and covers the web-initiated path where we
  // can't respond with UPDATE_MESSAGE.
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
  guildId: string | null;
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
      const tradesChannelId = trade.guildId
        ? await getGuildTradesChannel(getDb(), trade.guildId)
        : null;
      if (!tradesChannelId) {
        // Either the trade was DM-only by design (no guild_id at
        // propose-time) or the guild was uninstalled in the meantime.
        // Either way, can't open a thread — tell the clicker.
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
        await reportError({
          source: 'bot.thread-flow.auto-approve-create',
          tags: { tradeId: trade.id, requesterId: requester.id, counterpartId: counterpart.id },
        }, err);
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
        threadParentChannelId: tradesChannelId,
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
      await reportError({
        source: 'bot.thread-flow.approval-dm',
        tags: { tradeId: trade.id, requesterId: requester.id, counterpartId: counterpart.id },
      }, err);
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
      const tradesChannelId = trade.guildId
        ? await getGuildTradesChannel(getDb(), trade.guildId)
        : null;
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
        await reportError({
          source: 'bot.thread-flow.approve-create',
          tags: { tradeId: trade.id, proposerId: proposer.id, recipientId: recipient.id },
        }, err);
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
  threadParentChannelId: string;
  clickerIsProposer: boolean;
  res: VercelResponse;
}): Promise<void> {
  const { bot, trade, proposalCtx, threadId, threadParentChannelId, res } = args;
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
      discordThreadParentChannelId: threadParentChannelId,
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
    await reportError({
      source: 'bot.install.auto-create-channel',
      tags: { guildId, installedByUserId },
    }, err);
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
      // Filter in reportError treats 50007 (DMs disabled) as noise,
      // so this only alerts on the surprising cases (50001 missing
      // access, 5xx, validation bugs).
      console.error('discord-bot: welcome DM to installer failed', err);
      await reportError({
        source: 'bot.install.welcome-dm',
        tags: { guildId, installedByUserId },
      }, err);
    }
  }

  // Member outreach — invite existing SWUTrade users who are already
  // in this guild to enroll. Only fires on fresh install (re-auths
  // don't notify the same members twice). Respects the user's prefs:
  //   - autoEnrollOnBotInstall=true: flip their enrollment row + send
  //     a confirmation-shaped DM instead of an invitation.
  //   - dmServerNewInstall=false: skip the DM entirely.
  if (isFreshInstall) {
    await outreachToMembers({
      guildId,
      guildName,
      guildIcon,
      excludeUserId: installedByUserId,
      deps,
    });
  }
}

/**
 * Enumerate every SWUTrade user who's a member of the newly-installed
 * guild and invite them in. Runs with a concurrency cap so a huge
 * guild doesn't fan out thousands of DMs into a thundering herd —
 * the 429 retry in the bot client handles transient throttling, but
 * we'd rather not manufacture a rate-limit storm in the first place.
 *
 * Failures on any individual member are logged but don't abort the
 * batch — one user with DMs disabled shouldn't block the other 499.
 */
async function outreachToMembers(args: {
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  excludeUserId: string | null;
  deps: BotDeps;
}): Promise<void> {
  const { guildId, guildName, guildIcon, excludeUserId, deps } = args;
  const db = getDb();

  // One query joins memberships + users so we get prefs + Discord id
  // in a single round trip.
  const rows = await db
    .select({
      userId: users.id,
      discordId: users.discordId,
      dmServerNewInstall: users.dmServerNewInstall,
      autoEnrollOnBotInstall: users.autoEnrollOnBotInstall,
      membershipId: userGuildMemberships.id,
      enrolled: userGuildMemberships.enrolled,
    })
    .from(userGuildMemberships)
    .innerJoin(users, eq(users.id, userGuildMemberships.userId))
    .where(eq(userGuildMemberships.guildId, guildId));

  const guildIconUrl = guildIcon
    ? `https://cdn.discordapp.com/icons/${guildId}/${guildIcon}.png?size=128`
    : null;

  // Batches of 5 concurrent DMs — fast enough for realistic guild
  // sizes, small enough to keep rate-limit bursts tame. Promise.allSettled
  // so one failure doesn't kill the batch.
  const BATCH_SIZE = 5;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      chunk.map(row => outreachToSingleMember({
        row,
        guildId,
        guildName,
        guildIconUrl,
        excludeUserId,
        deps,
      })),
    );
  }
}

async function outreachToSingleMember(args: {
  row: {
    userId: string;
    discordId: string;
    dmServerNewInstall: boolean;
    autoEnrollOnBotInstall: boolean;
    membershipId: string;
    enrolled: boolean;
  };
  guildId: string;
  guildName: string;
  guildIconUrl: string | null;
  excludeUserId: string | null;
  deps: BotDeps;
}): Promise<void> {
  const { row, guildId, guildName, guildIconUrl, excludeUserId, deps } = args;
  // Skip the installing admin — they already got the "bot installed"
  // welcome DM with the same info.
  if (excludeUserId && row.discordId === excludeUserId) return;

  try {
    const bot = deps.bot ?? createDiscordBotClient();
    const ctx = { guildId, guildName, guildIconUrl };

    if (row.autoEnrollOnBotInstall && !row.enrolled) {
      // Flip all three consent axes. Matches the sync-path auto-
      // enroll behaviour for new memberships; the user opted into
      // this by setting the pref.
      const db = getDb();
      await db
        .update(userGuildMemberships)
        .set({ enrolled: true, includeInRollups: true, appearInQueries: true })
        .where(eq(userGuildMemberships.id, row.membershipId));
      await recordCommunityEvent(db, {
        guildId,
        actorUserId: row.userId,
        type: 'member_joined',
      });
      // Still DM them so they know it happened (unless they've
      // opted out of these DMs entirely).
      if (row.dmServerNewInstall) {
        await bot.sendDirectMessage(row.discordId, buildServerAutoEnrolledMessage(ctx));
      }
      return;
    }

    // Standard invite path — user hasn't opted into auto-enroll; send
    // them the one-tap enroll DM unless they've muted these invites.
    if (row.dmServerNewInstall) {
      await bot.sendDirectMessage(row.discordId, buildServerInviteMessage(ctx));
    }
  } catch (err) {
    console.error('discord-bot: member outreach DM failed', err);
    await reportError({
      source: 'bot.install.member-outreach',
      tags: {
        guildId,
        userId: row.userId,
        discordId: row.discordId,
        autoEnroll: String(row.autoEnrollOnBotInstall),
      },
    }, err);
  }
}

/**
 * Handler for the "Enroll in {server}" button that ships on the
 * invite DM. One tap: look up the viewer's membership row for the
 * specific guild, flip the three consent axes to true, and PATCH the
 * DM in place with a confirmation embed. The original invite is
 * self-contained (no auxiliary state), so there's no teardown.
 */
export async function handleServerInviteButton(
  payload: Record<string, unknown>,
  res: VercelResponse,
): Promise<void> {
  const data = payload.data as { custom_id?: string } | undefined;
  const parts = (data?.custom_id ?? '').split(':');
  // ['server-invite', guildId, action]
  const guildId = parts[1] ?? '';
  const action = parts[2] ?? '';
  if (!guildId || action !== 'enroll') {
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
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: "Sign into SWUTrade on the web first, then retry this button.",
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  // Resolve the guild's display name + icon from our own cache — the
  // button custom_id only carries the id; we don't want to round-trip
  // to Discord for the name on every click.
  const [guildRow] = await db
    .select({ guildName: botInstalledGuilds.guildName, guildIcon: botInstalledGuilds.guildIcon })
    .from(botInstalledGuilds)
    .where(eq(botInstalledGuilds.guildId, guildId))
    .limit(1);
  const guildName = guildRow?.guildName ?? 'this server';
  const guildIconUrl = guildRow?.guildIcon
    ? `https://cdn.discordapp.com/icons/${guildId}/${guildRow.guildIcon}.png?size=128`
    : null;

  // Flip all three consent axes on the membership row. Scoped to
  // (viewer, guild) — won't match anything if the viewer isn't a
  // member of the guild, in which case we surface a clear message
  // instead of silently succeeding. Pre-read prior state so we can
  // tell first-enroll (fire community event) from "already enrolled,
  // button re-click" (no-op on the feed).
  const [priorMembership] = await db
    .select({ enrolled: userGuildMemberships.enrolled })
    .from(userGuildMemberships)
    .where(and(
      eq(userGuildMemberships.userId, viewer.id),
      eq(userGuildMemberships.guildId, guildId),
    ))
    .limit(1);

  const result = await db
    .update(userGuildMemberships)
    .set({ enrolled: true, includeInRollups: true, appearInQueries: true })
    .where(and(
      eq(userGuildMemberships.userId, viewer.id),
      eq(userGuildMemberships.guildId, guildId),
    ))
    .returning({ id: userGuildMemberships.id });

  if (result.length > 0 && priorMembership && !priorMembership.enrolled) {
    await recordCommunityEvent(db, {
      guildId,
      actorUserId: viewer.id,
      type: 'member_joined',
    });
  }

  if (result.length === 0) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: "You're not a member of this server — try signing in again to sync your Discord memberships.",
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
    data: buildServerEnrollConfirmationMessage({ guildId, guildName, guildIconUrl }),
  });
}

