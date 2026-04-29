/**
 * Discord embed builders for signal posts. Signals are authored on
 * the web (`/?signals=new`); the bot posts the embed and owns the
 * post-level button interactions (Cancel, Specify variant).
 *
 * Multi-card aware: a signal can be a single card or a group of up
 * to 20. The embed format flexes for both — single-card stays tight,
 * multi-card becomes a bulleted list with per-card match listings.
 *
 * Match listings are public — the post lists which guild members
 * have the inventory the signaler is looking for / offering, gated
 * on those members' `appearInQueries=true` consent. Mentions are
 * rendered with `allowed_mentions: { parse: [] }` so listed users
 * aren't pinged automatically; the signaler can manually @ them in
 * a reply if they want to nudge.
 */

import type { DiscordMessageBody, DiscordComponent } from './discordBot.js';
import type { CardSignalKind, CardSignalStatus } from './schema.js';
import type { VariantSpec } from './signalMatching.js';

/** Custom-id prefix for signal-related button interactions. */
export const SIGNAL_CUSTOM_ID_PREFIX = 'signal';

const COMPONENT_TYPE_ACTION_ROW = 1;
const COMPONENT_TYPE_BUTTON = 2;
const COMPONENT_TYPE_STRING_SELECT = 3;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_STYLE_DANGER = 4;

// Brand palette: blue for "wanted" (one side of a trade), emerald
// for "offering" (the other side). Matches the trade builder's
// reserved colours.
const COLOR_WANTED = 0x3B82F6;
const COLOR_OFFERING = 0x10B981;
// Strike-through tone for cancelled / expired states.
const COLOR_INACTIVE = 0x6b7280;

/** Cap on rendered match mentions per card before truncating to "+N more". */
const MATCH_RENDER_LIMIT = 5;

export interface MatchedMember {
  discordId: string;
  handle: string;
  qty?: number;
}

export interface SignalEmbedCard {
  /** card_signals row id — used for per-row buttons (variant
   *  picker) when the group is single-card. */
  signalId: string;
  /** Family-level display name. */
  name: string;
  /** Set code, e.g. "JTL". */
  setCode: string;
  /** Card type, e.g. "Leader". Optional. */
  cardType?: string;
  /** Representative TCGPlayer product id — used for the embed
   *  thumbnail (single-card mode only; multi-card drops the
   *  thumbnail to make room for the list). */
  productId: string;
  variantSpec: VariantSpec;
  qty: number;
  /** Guild members who have the inverse inventory listed. */
  matchedUsers: MatchedMember[];
}

export interface SignalEmbedContext {
  /** Group id — same as the single row's id for 1-card signals. */
  groupId: string;
  kind: CardSignalKind;
  status: CardSignalStatus;
  cards: SignalEmbedCard[];
  note?: string | null;
  maxUnitPrice?: number | null;
  requester: {
    discordId: string | null;
    handle: string;
    avatarUrl?: string | null;
  };
  /** Friendly relative-time hint, e.g. "Expires in 6 days". */
  expiryHint: string;
  /** Absolute URL to the OG-style composite card image rendered by
   *  `api/og.ts?signal=<groupId>`. When provided + status is 'active',
   *  the embed gets a poster-style image header showing every card.
   *  Cancelled / expired posts drop this so the retired state reads
   *  cleanly. */
  imageUrl?: string;
  /** Origin to use when generating clickable signup links in the
   *  embed (e.g. `https://swutrade.com`). Falls back to a hard-
   *  coded production origin when omitted. */
  origin?: string;
}

/**
 * The signal embed. Single-card uses a tighter layout with the
 * thumbnail and a single match-list line. Multi-card collapses
 * each card into a bullet:
 *
 *   • 3× Luke Skywalker — Hero of Yavin [JTL] (Leader) · any printing
 *     📦 In this server: <@123>, <@456>
 */
export function buildSignalPost(ctx: SignalEmbedContext): DiscordMessageBody {
  const isActive = ctx.status === 'active';
  const titleVerb = ctx.kind === 'wanted' ? '🔍 Looking for' : '💱 Offering';

  const color = !isActive
    ? COLOR_INACTIVE
    : ctx.kind === 'wanted' ? COLOR_WANTED : COLOR_OFFERING;

  const statusBadge = (() => {
    switch (ctx.status) {
      case 'cancelled': return '· **Cancelled**';
      case 'expired':   return '· **Expired**';
      case 'fulfilled': return '· **Fulfilled**';
      default:          return null;
    }
  })();

  // Build the description block. Layout differs between single-
  // and multi-card.
  const lines: string[] = [];
  if (ctx.cards.length === 1) {
    const c = ctx.cards[0];
    lines.push(`**${c.qty}×** · ${formatCardLabel(c)}`);
    if (ctx.maxUnitPrice && ctx.maxUnitPrice > 0) {
      const verb = ctx.kind === 'wanted' ? 'Max' : 'Asking';
      lines.push(`${verb} **$${ctx.maxUnitPrice.toFixed(2)}** per copy`);
    }
    const matchLine = formatMatchLine(c.matchedUsers, ctx.kind);
    if (matchLine) lines.push(matchLine);
  } else {
    for (const c of ctx.cards) {
      lines.push(`• **${c.qty}×** ${c.name} \`[${c.setCode}]\`${c.cardType === 'Leader' ? ' (Leader)' : ''}`);
      if (c.variantSpec.mode === 'restricted') {
        lines.push(`  ${c.variantSpec.variants.join(' / ')} only`);
      }
      const matchLine = formatMatchLine(c.matchedUsers, ctx.kind);
      if (matchLine) lines.push(`  ${matchLine}`);
      lines.push('');
    }
    if (ctx.maxUnitPrice && ctx.maxUnitPrice > 0) {
      const verb = ctx.kind === 'wanted' ? 'Max' : 'Asking';
      lines.push(`${verb} **$${ctx.maxUnitPrice.toFixed(2)}** per copy`);
    }
  }
  if (ctx.note) {
    lines.push(`> ${ctx.note}`);
  }
  lines.push('');
  if (isActive) {
    lines.push(`⏱ ${ctx.expiryHint}`);
    // Clickable sign-up CTA — Discord viewers who aren't on
    // SWUTrade yet can tap straight into the OAuth flow without
    // hunting for the link. The Discord link-unfurl shows the
    // OAuth handshake's redirect target so it reads as friendly
    // ("Sign in with Discord on swutrade.com").
    const origin = ctx.origin ?? 'https://swutrade.com';
    lines.push(`✨ [Join SWUTrade with Discord →](${origin}/api/auth/discord)`);
  } else if (statusBadge) {
    lines.push(statusBadge);
  }

  // Title — single-card uses the card name; multi-card uses a
  // generic "N cards" header so the title doesn't pretend the
  // first card is the only one.
  const titleText = ctx.cards.length === 1
    ? `${titleVerb} · ${ctx.cards[0].name}`
    : `${titleVerb} · ${ctx.cards.length} cards`;
  const title = !isActive ? `~~${titleText}~~` : titleText;

  // Thumbnail: only when there's no image header AND we're a single-
  // card post. The big poster image (when present) is doing the
  // visual identification work; doubling up a thumbnail makes the
  // embed noisy. Multi-card without an image still has no thumbnail
  // since the bullet list is the focal element there.
  const thumbnail = !ctx.imageUrl && ctx.cards.length === 1 && ctx.cards[0].productId
    ? { url: `https://product-images.tcgplayer.com/fit-in/200x279/${ctx.cards[0].productId}.jpg` }
    : undefined;

  // Poster image header — only on active posts. Retired posts drop
  // the field so the status badge + strike-through title carry the
  // visual cue rather than competing with a colourful poster.
  const image = ctx.imageUrl && isActive ? { url: ctx.imageUrl } : undefined;

  return {
    embeds: [{
      title,
      // url makes the title clickable in Discord — points at the
      // sign-up flow so a tap from a curious onlooker lands on the
      // OAuth-with-Discord screen, not a generic landing page.
      url: isActive ? `${ctx.origin ?? 'https://swutrade.com'}/api/auth/discord` : undefined,
      description: lines.join('\n'),
      color,
      thumbnail,
      image,
      author: {
        name: `@${ctx.requester.handle}`,
        ...(ctx.requester.avatarUrl ? { icon_url: ctx.requester.avatarUrl } : {}),
      },
      footer: { text: 'SWUTrade · build your own at swutrade.com' },
    }],
    components: buildActionRow(ctx),
    // Suppress automatic pings for the listed mentions — the post
    // is a discovery surface, not a notification firehose. The
    // author can manually @ matched users in a reply if they want
    // to nudge specific people.
    allowed_mentions: { parse: [] },
  } as DiscordMessageBody;
}

function formatCardLabel(c: SignalEmbedCard): string {
  const variantLabel = c.variantSpec.mode === 'restricted'
    ? `${c.variantSpec.variants.join(' / ')} only`
    : 'any printing';
  const leader = c.cardType === 'Leader' ? ' (Leader)' : '';
  return `\`[${c.setCode}]\`${leader} · ${variantLabel}`;
}

/** Render the per-card "people in this server who can help" line.
 *  Returns `null` (omit the line entirely) when there are no
 *  matches — the empty-state copy was noisy in posts where most
 *  cards have no matches yet. */
function formatMatchLine(matches: MatchedMember[], kind: CardSignalKind): string | null {
  if (matches.length === 0) return null;
  const verb = kind === 'wanted' ? 'Has it' : 'Wants it';
  const visible = matches.slice(0, MATCH_RENDER_LIMIT);
  const overflow = matches.length - visible.length;
  const mentions = visible.map(m => {
    const qtySuffix = m.qty != null && m.qty > 1 ? ` (${m.qty}×)` : '';
    return `<@${m.discordId}>${qtySuffix}`;
  });
  if (overflow > 0) mentions.push(`+${overflow} more`);
  return `${verb}: ${mentions.join(', ')}`;
}

function buildActionRow(ctx: SignalEmbedContext): DiscordComponent[] {
  if (ctx.status !== 'active') return [];

  // Live: Cancel post + (single-card with variant=any) Specify
  // variant. Multi-card defers per-card variant pinning to a
  // follow-up.
  const buttons: DiscordComponent[] = [];
  if (ctx.cards.length === 1 && ctx.cards[0].variantSpec.mode === 'any') {
    buttons.push({
      type: COMPONENT_TYPE_BUTTON,
      style: BUTTON_STYLE_SECONDARY,
      label: 'Pick a printing',
      custom_id: `${SIGNAL_CUSTOM_ID_PREFIX}:${ctx.cards[0].signalId}:variant-open`,
    });
  }
  buttons.push({
    type: COMPONENT_TYPE_BUTTON,
    style: BUTTON_STYLE_DANGER,
    label: 'Cancel post',
    custom_id: `${SIGNAL_CUSTOM_ID_PREFIX}:${ctx.groupId}:cancel`,
  });
  return [{
    type: COMPONENT_TYPE_ACTION_ROW,
    components: buttons,
  }];
}

/**
 * Ephemeral message body shown to the author after they click
 * "Pick a printing". A string-select listing every variant in the
 * family.
 */
export function buildVariantPickerEphemeral(args: {
  signalId: string;
  familyName: string;
  kind: CardSignalKind;
  variants: Array<{ productId: string; variant: string; market: number | null }>;
}): Record<string, unknown> {
  const options = args.variants.slice(0, 25).map(v => ({
    label: v.variant.slice(0, 100),
    value: v.variant.slice(0, 100),
    description: v.market != null ? `~$${v.market.toFixed(2)}` : undefined,
  }));
  const prompt = args.kind === 'wanted'
    ? `Which printing of **${args.familyName}** are you after?`
    : `Which printing of **${args.familyName}** do you have?`;
  return {
    content: `${prompt} Only that printing will count for matches.`,
    flags: 64,
    components: [{
      type: COMPONENT_TYPE_ACTION_ROW,
      components: [{
        type: COMPONENT_TYPE_STRING_SELECT,
        custom_id: `${SIGNAL_CUSTOM_ID_PREFIX}:${args.signalId}:variant-pick`,
        placeholder: 'Pick a variant',
        options,
        min_values: 1,
        max_values: 1,
      }],
    }],
  };
}

/** Friendly "Expires in N days/hours" string. */
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
