import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { botInstalledGuilds, userGuildMemberships, users } from '../lib/schema.js';
import { verifyDiscordSignature } from '../lib/discordSignature.js';
import { createDiscordBotClient, type DiscordBotClient } from '../lib/discordBot.js';
import {
  createOrGetActiveSession,
  sendSessionCreateInviteDm,
} from '../lib/sessions.js';
import {
  PREF_CUSTOM_ID_PREFIX,
  SERVER_INVITE_CUSTOM_ID_PREFIX,
  buildPrefOptionsMessage,
  buildPrefConfirmationMessage,
  buildSelfPrefsIndexMessage,
  buildServerInviteMessage,
  buildServerAutoEnrolledMessage,
  buildServerEnrollConfirmationMessage,
} from '../lib/discordMessages.js';
import {
  PREF_DEFINITIONS,
  getPrefDefinition,
  getUserPrefColumn,
  validatePrefValue,
} from '../lib/prefsRegistry.js';
import { resolvePref } from '../lib/prefsResolver.js';
import { reportError } from '../lib/errorReporter.js';
import { recordEvent as recordCommunityEvent } from '../lib/communityEvents.js';
import { ensureSwutradeCategory } from '../lib/tradeGuild.js';
import { waitUntil } from '@vercel/functions';
import {
  findMatches,
  resolveSignalCardsBatch,
  resolveSignalFamily,
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
    // Stale `trade-proposal:*` button clicks from in-flight DMs that
    // pre-date the proposal-flow retirement (Phase C) fall through to
    // the unknown-button branch below — Discord clears the pending
    // state silently. The proposal flow has no consumers in current
    // code; sessions are the only trade primitive.
    if (customId.startsWith(`${PREF_CUSTOM_ID_PREFIX}:`)) {
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

  // /looking-for and /offering used to land here; both are now
  // posted via the web Signal Builder at /?signals=new. The slash
  // commands have been dropped from registration. Existing live
  // posts from those commands keep working — their Cancel and
  // Specify-variant buttons route through `signal:*` custom_ids
  // which are still handled below.

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
    } else if (subcommand?.name === 'trade') {
      // /swutrade trade @user — Phase B3 entry point. Creates a
      // shared trade session between the clicker and the named
      // target, DMs the target with the session link, and returns
      // an ephemeral followup with the link for the clicker.
      const userOpt = subcommand.options?.find(o => o.type === OPTION_TYPE_USER && o.name === 'user');
      const targetDiscordId = userOpt ? String(userOpt.value) : undefined;
      const resolvedTarget = targetDiscordId ? data?.resolved?.users?.[targetDiscordId] : undefined;
      const targetUsername = resolvedTarget?.global_name ?? resolvedTarget?.username;
      return await handleTradeSlashCommand({
        payload,
        targetDiscordId,
        targetUsername,
        deps,
      });
    } else {
      return {
        content: 'Unknown command. Try `/swutrade settings` or `/swutrade trade @user`.',
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

  // Per-trader settings have no entries after the prefs hygiene pass
  // (the only peer-scoped pref, `communicationPref`, was retired with
  // the proposal flow). Surface a friendly explanation instead of an
  // empty selector — the user-context menu still pipes here.
  void peerRow;
  return {
    content: 'No per-trader preferences are available right now — only global defaults. Use `/swutrade settings` to adjust those.',
    flags: MESSAGE_FLAG_EPHEMERAL,
  };
}

/**
 * /swutrade trade @user dispatch. Phase B3 — bot's session-creation
 * entry point. Both clicker and target must be real SWUTrade users
 * (have rows in `users` keyed on `discord_id`). On success:
 *   - Creates a session via `createOrGetActiveSession` (idempotent
 *     for an existing-active-pair).
 *   - DMs the target (subject to their `dmSessionInvited` pref via
 *     `sendSessionCreateInviteDm`).
 *   - Returns an ephemeral followup to the clicker with the session
 *     URL so they can land directly on the canvas.
 *
 * Self-invite is rejected with a friendly message. Either party
 * being signed-out of SWUTrade routes them to a sign-up CTA.
 */
async function handleTradeSlashCommand(args: {
  payload: Record<string, unknown>;
  targetDiscordId: string | undefined;
  targetUsername: string | undefined;
  deps: BotDeps;
}): Promise<Record<string, unknown>> {
  const { payload, targetDiscordId, targetUsername, deps } = args;
  if (!targetDiscordId) {
    return {
      content: 'Pick someone to trade with: `/swutrade trade @user`.',
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  const maybeMember = payload.member as { user?: { id?: string } } | undefined;
  const maybeUser = payload.user as { id?: string } | undefined;
  const clickerDiscordId = maybeMember?.user?.id ?? maybeUser?.id;
  if (!clickerDiscordId) {
    return {
      content: 'Could not identify you. Try the command again.',
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }
  if (clickerDiscordId === targetDiscordId) {
    return {
      content: "You can't start a trade with yourself.",
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  const db = getDb();
  // Both participants must already be on SWUTrade (have a real
  // users row). The slash command isn't the right place to mint a
  // ghost — the QR / share-link flow is. Surface a sign-up CTA
  // instead so non-users know what to do.
  const [clickerRow] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.discordId, clickerDiscordId))
    .limit(1);
  if (!clickerRow) {
    return {
      content: 'Sign in with Discord at <https://swutrade.com> first, then come back and run the command.',
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  const [targetRow] = await db
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(eq(users.discordId, targetDiscordId))
    .limit(1);
  if (!targetRow) {
    const targetMention = `<@${targetDiscordId}>${targetUsername ? ` (@${targetUsername})` : ''}`;
    return {
      content: `${targetMention} isn't on SWUTrade yet — they'd have to sign in at <https://swutrade.com> before you can start a trade with them.`,
      flags: MESSAGE_FLAG_EPHEMERAL,
    };
  }

  const result = await createOrGetActiveSession(db, {
    creatorUserId: clickerRow.id,
    counterpartUserId: targetRow.id,
  });

  // DM the target — same pref-respecting helper B1 added on the web
  // create path. Skip silently if there's no bot configured (test
  // environments without DISCORD_BOT_TOKEN); the slash followup
  // still gives the clicker a working link.
  const bot = deps.bot
    ?? (process.env.DISCORD_BOT_TOKEN ? createDiscordBotClient() : null);
  if (bot && result.created) {
    const appBaseUrl = deps.origin ?? process.env.SWUTRADE_PUBLIC_URL ?? 'https://beta.swutrade.com';
    await sendSessionCreateInviteDm(db, {
      sessionId: result.id,
      inviterUserId: clickerRow.id,
      targetUserId: targetRow.id,
      bot,
      appBaseUrl,
    });
  }

  const baseUrl = deps.origin ?? process.env.SWUTRADE_PUBLIC_URL ?? 'https://beta.swutrade.com';
  const sessionUrl = `${baseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(result.id)}`;
  return {
    content: result.created
      ? `Started a shared trade with @${targetRow.handle}. They've been DM'd. Open it: ${sessionUrl}`
      : `You already have a shared trade in flight with @${targetRow.handle}. Open it: ${sessionUrl}`,
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


// --- autocomplete handler --------------------------------------------------

/**
 * Discord-side autocomplete. Currently no registered command
 * uses autocomplete callbacks (the /swutrade settings `user`
 * arg uses Discord's native user picker, no server callback).
 * Reserved as a placeholder so the dispatcher branch in
 * `handleInteraction` doesn't need a code change when we add a
 * new autocompleted command.
 */
async function handleAutocomplete(
  _payload: Record<string, unknown>,
  res: VercelResponse,
): Promise<void> {
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
  // group id (for cancel / fulfilled / trade). Single-card signals
  // have groupId === rowId so both lookups work the same way for
  // those.
  const id = parts[1];
  const action = parts[2];

  // Public action — no auth, no SWUTrade-account check. The
  // ephemeral response carries a deep link that the web side
  // handles sign-in for. Discord users without a SWUTrade account
  // are exactly the audience this button is converting.
  if (action === 'trade') {
    return handleTradeWithAuthor({ groupId: id, res });
  }

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

  // Group-scoped actions: cancel, fulfilled. Both author-only.
  // Row-scoped actions: variant-open, variant-pick.
  const isGroupAction = action === 'cancel' || action === 'fulfilled';

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
      data: { content: 'This post no longer exists.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }
  if (signal.userId !== clicker.id) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: `Only the post's author can change the printing.`, flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }
  if (signal.status !== 'active') {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: `This post is already ${signal.status}.`, flags: MESSAGE_FLAG_EPHEMERAL },
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
 * Group-scoped button actions on a live signal post. Today only
 * `cancel` lands here; the slash-flow draft actions were retired
 * when the web Signal Builder replaced the slash command.
 *
 * Auth check: the clicker must own the group's signals. Every row
 * in a group has the same userId, so the first row is canonical.
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
      data: { content: 'This post no longer exists.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  const ownerId = groupRows[0].userId;
  if (ownerId !== clickerUserId) {
    const verb = action === 'fulfilled' ? 'mark this fulfilled' : 'cancel it';
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: {
        content: `Only the post's author can ${verb}.`,
        flags: MESSAGE_FLAG_EPHEMERAL,
      },
    });
    return;
  }

  if (action === 'cancel') {
    return handleCancelLive(groupId, groupRows, res, deps);
  }
  if (action === 'fulfilled') {
    return handleMarkFulfilled(groupId, groupRows, res, deps);
  }
  res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
}

/**
 * Public "Trade with @author" button. No auth — anyone in the channel
 * can click. Returns an ephemeral with a deep link to the web trade
 * builder, which reads `?seedFromSignal=<groupId>` and pre-fills the
 * counterpart + cards from the signal payload. Sign-in (or ghost
 * mint) happens at the web boundary, not here.
 */
async function handleTradeWithAuthor(args: {
  groupId: string;
  res: VercelResponse;
}): Promise<void> {
  const { groupId, res } = args;
  const db = getDb();

  const [row] = await db
    .select({ userId: cardSignals.userId, status: cardSignals.status })
    .from(cardSignals)
    .where(eq(cardSignals.groupId, groupId))
    .limit(1);
  if (!row) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'This post no longer exists.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }
  if (row.status !== 'active') {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: `This post is already ${row.status}.`, flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  const [author] = await db
    .select({ handle: users.handle })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  const handle = author?.handle ?? 'them';

  const origin = process.env.SWUTRADE_PUBLIC_URL ?? 'https://swutrade.com';
  const url = `${origin}/?seedFromSignal=${encodeURIComponent(groupId)}`;

  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
    data: {
      content: `Open the trade builder, pre-filled with @${handle}'s signal: ${url}`,
      flags: MESSAGE_FLAG_EPHEMERAL,
    },
  });
}

/**
 * "Mark fulfilled" button — author-only. Flips every row in the
 * group to fulfilled, PATCHes the embed (green badge, no buttons),
 * locks the response thread so stragglers don't keep replying.
 *
 * Auth note: ownership is already enforced by handleSignalGroupAction
 * before we land here — non-owners get an ephemeral error one layer
 * up. This function just runs the state transition.
 */
async function handleMarkFulfilled(
  groupId: string,
  groupRows: Array<typeof cardSignals.$inferSelect>,
  res: VercelResponse,
  deps: BotDeps,
): Promise<void> {
  if (groupRows.some(r => r.status !== 'active')) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: `This post is already ${groupRows[0].status}.`, flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }

  const db = getDb();
  const fulfilledAt = new Date();
  await db.update(cardSignals)
    .set({ status: 'fulfilled', fulfilledAt })
    .where(eq(cardSignals.groupId, groupId));

  const [signaler] = await db
    .select({ id: users.id, handle: users.handle, avatarUrl: users.avatarUrl, discordId: users.discordId })
    .from(users)
    .where(eq(users.id, groupRows[0].userId))
    .limit(1);

  const resolvedCards = await resolveSignalCardsBatch(db, groupRows);
  const cards = groupRows.map((row) => {
    const r = resolvedCards.get(row.id);
    if (!r) return null;
    const { family, variantSpec } = r;
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
  });
  const firstRow = groupRows[0];
  const fulfilledEmbed = buildSignalPost({
    groupId,
    kind: firstRow.kind,
    status: 'fulfilled',
    cards: cards.filter(c => c !== null) as Array<NonNullable<typeof cards[number]>>,
    note: firstRow.signalNote,
    requester: {
      discordId: signaler?.discordId ?? null,
      handle: signaler?.handle ?? '?',
      avatarUrl: signaler?.avatarUrl ?? null,
    },
    expiryHint: '',
  });

  // Lock the response thread (best-effort — Discord may have
  // already auto-archived if the thread idled past 24h, in which
  // case the lock still succeeds and re-archive is a no-op).
  if (firstRow.threadId) {
    const bot = deps.bot ?? createDiscordBotClient();
    try {
      await bot.lockThread(firstRow.threadId);
    } catch (err) {
      console.error('handleMarkFulfilled: lockThread failed', err);
    }
  }

  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_UPDATE_MESSAGE,
    data: fulfilledEmbed,
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
      data: { content: `This post is already ${groupRows[0].status}.`, flags: MESSAGE_FLAG_EPHEMERAL },
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

  const resolvedCards = await resolveSignalCardsBatch(db, groupRows);
  const cards = groupRows.map((row) => {
    const r = resolvedCards.get(row.id);
    if (!r) return null;
    const { family, variantSpec } = r;
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
  });

  const firstRow = groupRows[0];
  const cancelledEmbed = buildSignalPost({
    groupId,
    kind: firstRow.kind,
    status: 'cancelled',

    cards: cards.filter(c => c !== null) as Array<NonNullable<typeof cards[number]>>,
    note: firstRow.signalNote,
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


async function handleVariantOpen(
  signal: typeof cardSignals.$inferSelect,
  res: VercelResponse,
): Promise<void> {
  const family = await resolveSignalFamily(getDb(), signal);
  if (!family) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'Couldn\'t find the card for this post.', flags: MESSAGE_FLAG_EPHEMERAL },
    });
    return;
  }
  res.status(200).json({
    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
    data: buildVariantPickerEphemeral({
      signalId: signal.id,
      familyName: family.name,
      kind: signal.kind,
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
  const family = await resolveSignalFamily(getDb(), signal);
  if (!family || !family.variants.some(v => v.variant === pickedVariant)) {
    res.status(200).json({
      type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
      data: { content: 'That printing doesn\'t exist for this card.', flags: MESSAGE_FLAG_EPHEMERAL },
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
      content: `Set to **${pickedVariant}** only. Updated above.`,
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

  // Active-expiry sweep: walk active signals past their expires_at.
  // Group by groupId so we handle multi-card signals atomically —
  // the public message represents the whole group; we only PATCH
  // it once.
  const overdue = await db
    .select()
    .from(cardSignals)
    .where(and(
      eq(cardSignals.status, 'active'),
      sql`${cardSignals.expiresAt} < now()`,
    ));

  if (overdue.length === 0) {
    res.status(200).json({ ok: true, expired: 0 });
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

    const resolvedCards = await resolveSignalCardsBatch(db, rows);
    const cards = rows.map((row) => {
      const r = resolvedCards.get(row.id);
      if (!r) return null;
      const { family, variantSpec } = r;
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
    });

    const expiredEmbed = buildSignalPost({
      groupId,
      kind: firstRow.kind,
      status: 'expired',
  
      cards: cards.filter(c => c !== null) as Array<NonNullable<typeof cards[number]>>,
      note: firstRow.signalNote,
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

  res.status(200).json({ ok: true, expired, patchFailures });
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

  // Self-scope is the only surface left after the prefs hygiene pass
  // (peer-scope existed only for `communicationPref`, retired with the
  // proposal flow). Parse `pref:{key}:{action}[:{value}]`. Legacy
  // `comm-pref:*` clicks fall through to the unknown-button branch.
  if (parts[0] !== PREF_CUSTOM_ID_PREFIX) {
    res.status(200).json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_UPDATE });
    return;
  }
  const defKey = parts[1] ?? '';
  const action = parts[2] ?? '';
  const rawValue = parts[3];

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
  // Typed column accessor throws if `def.key` is unregistered or
  // its column drifted off the schema — runtime property lookup
  // protected at the boundary instead of crashing in the SQL
  // builder.
  const column = getUserPrefColumn(def.key);

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
    .select({
      categoryId: botInstalledGuilds.categoryId,
      tradesChannelId: botInstalledGuilds.tradesChannelId,
      postsChannelId: botInstalledGuilds.postsChannelId,
      announcementsChannelId: botInstalledGuilds.announcementsChannelId,
      discussionChannelId: botInstalledGuilds.discussionChannelId,
    })
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

  // Skip auto-create only when the full SWUTrade category + four
  // child channels are already in place. If any piece is missing,
  // ensureSwutradeCategory fills only what's missing (idempotent),
  // which is how we migrate legacy installs that have a
  // trades_channel_id but no category yet.
  const categoryComplete = priorRow
    && priorRow.categoryId
    && priorRow.tradesChannelId
    && priorRow.postsChannelId
    && priorRow.announcementsChannelId
    && priorRow.discussionChannelId;
  if (categoryComplete) {
    return;
  }

  try {
    const bot = deps.bot ?? createDiscordBotClient();
    await ensureSwutradeCategory(db, guildId, bot);
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

