/**
 * Discord embed builders for `/looking-for` + `/offering` signal posts.
 *
 * In PR 1 the signal post is the public surface (channel message
 * with embed + Cancel button). PR 2 adds a thread + response button;
 * the embed shape is forward-compatible — the response counter is
 * already there, just shows 0 today.
 */

import type { DiscordMessageBody, DiscordComponent } from './discordBot.js';
import type { CardSignalKind, CardSignalStatus } from './schema.js';

/** Custom-id prefix for signal-related button interactions. The
 *  bot's component dispatcher branches on this prefix the same way
 *  it branches on `trade-proposal:*`, `pref:*`, etc. */
export const SIGNAL_CUSTOM_ID_PREFIX = 'signal';

const COMPONENT_TYPE_ACTION_ROW = 1;
const COMPONENT_TYPE_BUTTON = 2;
const BUTTON_STYLE_DANGER = 4;

// Brand palette: blue for "wanted" (one side of a trade), emerald
// for "offering" (the other side). Matches the trade builder's
// reserved colours so the visual cue carries across surfaces.
const COLOR_WANTED = 0x3B82F6;
const COLOR_OFFERING = 0x10B981;
// Strike-through tone for cancelled / expired states. Muted so the
// post doesn't compete visually with active signals.
const COLOR_INACTIVE = 0x6b7280;

export interface SignalEmbedContext {
  signalId: string;
  kind: CardSignalKind;
  /** Status drives the colour + badge. PR 1 only ever calls with
   *  'active' or 'cancelled' / 'expired'; 'fulfilled' lands in PR 3. */
  status: CardSignalStatus;
  card: {
    /** Human-friendly card name without the variant suffix. */
    name: string;
    /** TCGPlayer product id — used to fetch the thumbnail. */
    productId: string;
    /** Variant label, e.g. "Standard", "Hyperspace". */
    variant: string;
    /** Set name for the description line. Optional — passes through
     *  to the embed if present. */
    setName?: string;
  };
  qty: number;
  /** Inline note from the signaler. Up to ~50 chars in the slash. */
  note?: string | null;
  /** Optional max unit price the signaler is willing to pay /
   *  accept for this signal. Surfaced under the qty line. */
  maxUnitPrice?: number | null;
  requester: {
    /** Discord user id — used for the @mention. */
    discordId: string | null;
    /** SWUTrade handle. */
    handle: string;
    /** Avatar url — optional, used as embed author icon if present. */
    avatarUrl?: string | null;
  };
  /** Number of responders so far. PR 1 always shows 0; PR 2 PATCHes
   *  the embed to bump this when a response lands. */
  responseCount: number;
  /** Friendly relative-time hint, e.g. "Expires in 6 days". The
   *  caller computes this so the builder stays pure. */
  expiryHint: string;
}

/**
 * The public signal post. Posts in the channel where the user typed
 * the slash; the bot's `application_id` owns the message so we can
 * PATCH it later (status transitions, response-count bumps, etc.).
 */
export function buildSignalPost(ctx: SignalEmbedContext): DiscordMessageBody {
  const isActive = ctx.status === 'active';
  const titleVerb = ctx.kind === 'wanted' ? '🔍 Looking for' : '💱 Offering';
  const color = !isActive
    ? COLOR_INACTIVE
    : ctx.kind === 'wanted'
      ? COLOR_WANTED
      : COLOR_OFFERING;

  const statusBadge = (() => {
    switch (ctx.status) {
      case 'cancelled': return '· **Cancelled**';
      case 'expired':   return '· **Expired**';
      case 'fulfilled': return '· **Fulfilled**';
      default:          return null;
    }
  })();

  const lines: string[] = [
    `**${ctx.qty}×** · ${ctx.card.variant}${ctx.card.setName ? ` · ${ctx.card.setName}` : ''}`,
  ];
  if (ctx.maxUnitPrice && ctx.maxUnitPrice > 0) {
    const verb = ctx.kind === 'wanted' ? 'Max' : 'Asking';
    lines.push(`${verb} **$${ctx.maxUnitPrice.toFixed(2)}** per copy`);
  }
  if (ctx.note) {
    // Single-line quote — Discord renders `>` as a blockquote.
    lines.push(`> ${ctx.note}`);
  }
  lines.push('');
  if (isActive) {
    lines.push(`💬 **${ctx.responseCount}** ${ctx.responseCount === 1 ? 'response' : 'responses'}`);
    lines.push(`⏱ ${ctx.expiryHint}`);
  } else if (statusBadge) {
    lines.push(statusBadge);
  }

  // The wordmark title style mirrors trade proposals. Strike-through
  // applied to inactive signals via Discord's `~~text~~` syntax so
  // the post visually retires without disappearing from the channel.
  const titleText = `${titleVerb} · ${ctx.card.name}`;
  const title = isActive ? titleText : `~~${titleText}~~`;

  // Card thumbnail from TCGPlayer's CDN (same source the trade
  // builder uses). Skip when productId is empty — defensive against
  // a future code path that posts without a real card.
  const thumbnail = ctx.card.productId
    ? { url: `https://product-images.tcgplayer.com/fit-in/200x279/${ctx.card.productId}.jpg` }
    : undefined;

  return {
    embeds: [{
      title,
      description: lines.join('\n'),
      color,
      thumbnail,
      author: {
        name: `@${ctx.requester.handle}`,
        ...(ctx.requester.avatarUrl ? { icon_url: ctx.requester.avatarUrl } : {}),
      },
      footer: { text: 'SWUTrade · /looking-for or /offering to post your own' },
    }],
    components: isActive ? [buildActionRow(ctx)] : [],
  };
}

/** PR 1: just the Cancel button. PR 2 will add "I have this!" /
 *  "I want this!" alongside it. */
function buildActionRow(ctx: SignalEmbedContext): DiscordComponent {
  const cancelBtn: DiscordComponent = {
    type: COMPONENT_TYPE_BUTTON,
    style: BUTTON_STYLE_DANGER,
    label: 'Cancel post',
    custom_id: `${SIGNAL_CUSTOM_ID_PREFIX}:${ctx.signalId}:cancel`,
  };
  return {
    type: COMPONENT_TYPE_ACTION_ROW,
    components: [cancelBtn],
  };
}

export interface MatchPingContext {
  kind: CardSignalKind;
  card: { name: string; variant: string };
  signalerHandle: string;
  qty: number;
  /** Deep link into the signal post in the channel. Built by the
   *  caller from guildId + channelId + messageId. */
  signalUrl: string;
  /** Optional note from the signaler. */
  note?: string | null;
}

/**
 * DM body sent to a matched user when a signal posts. Brief —
 * the signal post itself is where the action happens; the DM is a
 * tap-to-jump notification. Settings buttons piggyback on the DM
 * so the matched user can opt out of future match alerts in one
 * click.
 */
export function buildMatchAlertDm(ctx: MatchPingContext): DiscordMessageBody {
  const intro = ctx.kind === 'wanted'
    ? `@${ctx.signalerHandle} is **looking for ${ctx.qty}× ${ctx.card.name}** (${ctx.card.variant}) — and SWUTrade noticed you have it listed.`
    : `@${ctx.signalerHandle} is **offering ${ctx.qty}× ${ctx.card.name}** (${ctx.card.variant}) — and SWUTrade noticed you want it.`;

  const lines = [intro];
  if (ctx.note) lines.push(`> ${ctx.note}`);
  lines.push('');
  lines.push(`[Open the post →](${ctx.signalUrl})`);
  lines.push('');
  lines.push('— Don\'t want match alerts? `/swutrade settings` → Match alerts.');

  return {
    content: lines.join('\n'),
    // No buttons — keep the DM lightweight; user can act from the
    // public post itself in PR 2.
  };
}

/** Friendly "Expires in N days/hours" string from a future date.
 *  Pure helper kept colocated with the embed builder so the wording
 *  stays consistent across the post + any followup PATCHes. */
export function formatExpiryHint(expiresAt: Date, now: Date = new Date()): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return 'Expired';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor(ms / (60 * 1000));
  if (days >= 2) return `Expires in ${days} days`;
  if (days === 1) return 'Expires in 1 day';
  if (hours >= 2) return `Expires in ${hours} hours`;
  if (hours === 1) return 'Expires in 1 hour';
  if (minutes >= 5) return `Expires in ${minutes} minutes`;
  return 'Expires soon';
}
