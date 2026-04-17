import type { DiscordMessageBody, DiscordEmbed } from './discordBot.js';
import type { TradeCardSnapshot } from './schema.js';

/**
 * Builders for the Discord messages that carry a trade proposal
 * through its lifecycle. Keeping the content shapes in one place
 * means the DM-on-propose path, the edit-on-response path, and the
 * proposer-notification path all stay visually cohesive — if we
 * tune the color scheme or copy, one file changes.
 *
 * Colors mirror SWUTrade's web palette (see project_swutrade_palette):
 *   - gold: open proposals (primary chrome)
 *   - emerald: accepted (matches the "offering" side in-app)
 *   - red/crimson: declined
 *
 * Button custom_id format: `trade-proposal:{tradeId}:{action}` —
 * parsed in api/bot.ts to dispatch to the interaction handler.
 * Keep the prefix stable; other feature custom_ids will use their
 * own namespace (e.g., `lgs-visit:*`) when we add them.
 */

export const BUTTON_CUSTOM_ID_PREFIX = 'trade-proposal';

const COLORS = {
  gold: 0xD4AF37,
  emerald: 0x34D399,
  red: 0xEF4444,
  gray: 0x6B7280,
} as const;

// Discord component/button constants — see the docs:
// https://discord.com/developers/docs/interactions/message-components
const COMPONENT_TYPE_ACTION_ROW = 1;
const COMPONENT_TYPE_BUTTON = 2;
const BUTTON_STYLE_SECONDARY = 2; // grey
const BUTTON_STYLE_SUCCESS = 3;   // green
const BUTTON_STYLE_DANGER = 4;    // red

function formatCardList(cards: TradeCardSnapshot[]): string {
  if (cards.length === 0) return '_none_';
  // Keep lines compact — Discord embed fields truncate at 1024
  // chars and proposals could get chunky. If we hit that limit in
  // practice we'll summarize (e.g. "+ 5 more"); for now assume
  // proposals stay small.
  return cards.map(c => {
    const price = c.unitPrice != null && c.unitPrice > 0 ? ` — $${c.unitPrice.toFixed(2)}` : '';
    return `• ${c.qty}× ${c.name} (${c.variant})${price}`;
  }).join('\n');
}

function subtotal(cards: TradeCardSnapshot[]): number {
  return cards.reduce((sum, c) => sum + (c.unitPrice ?? 0) * c.qty, 0);
}

function formatSubtotal(cards: TradeCardSnapshot[]): string {
  const total = subtotal(cards);
  return total > 0 ? `$${total.toFixed(2)}` : '—';
}

/**
 * When the two sides' card subtotals don't match, the difference is
 * the implied cash settlement (no separate cash field is persisted —
 * the trade pricing IS the cash). Returns null when the two sides
 * balance closely enough that surfacing it would feel noisy.
 *
 * Threshold of $0.50 matches user expectations that "close enough"
 * trades don't need a cash-settlement reminder. Anything above that
 * reads as a meaningful residual.
 */
function imbalanceNote(
  offering: TradeCardSnapshot[],
  receiving: TradeCardSnapshot[],
  proposerHandle: string,
): { name: string; value: string } | null {
  const diff = subtotal(offering) - subtotal(receiving);
  if (Math.abs(diff) < 0.5) return null;
  // `diff > 0` means the proposer's offering is higher → they'd
  // typically RECEIVE the residual in cash ("in their favor"). Sign
  // flipped means the recipient's side is higher.
  const favors = diff > 0 ? `@${proposerHandle}` : 'you';
  return {
    name: 'Subtotal difference',
    value: `$${Math.abs(diff).toFixed(2)} in ${favors === 'you' ? 'your' : `${favors}'s`} favor — typically settled in cash.`,
  };
}

export interface ProposalMessageContext {
  tradeId: string;
  proposerHandle: string;
  proposerUsername: string;
  offeringCards: TradeCardSnapshot[];
  receivingCards: TradeCardSnapshot[];
  message?: string | null;
}

/** The initial DM sent to the recipient when a proposal is created. */
export function buildProposalMessage(ctx: ProposalMessageContext): DiscordMessageBody {
  const imbalance = imbalanceNote(ctx.offeringCards, ctx.receivingCards, ctx.proposerHandle);
  const embed: DiscordEmbed = {
    title: `Trade proposal from @${ctx.proposerHandle}`,
    color: COLORS.gold,
    description: ctx.message ? `> ${ctx.message}` : undefined,
    fields: [
      {
        name: `They're offering (${formatSubtotal(ctx.offeringCards)})`,
        value: formatCardList(ctx.offeringCards),
      },
      {
        name: `They're asking for (${formatSubtotal(ctx.receivingCards)})`,
        value: formatCardList(ctx.receivingCards),
      },
      ...(imbalance ? [imbalance] : []),
    ],
    footer: { text: `SWUTrade proposal · ${ctx.tradeId.slice(0, 8)}` },
  };

  return {
    embeds: [embed],
    components: [
      {
        type: COMPONENT_TYPE_ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE_BUTTON,
            style: BUTTON_STYLE_SUCCESS,
            label: 'Accept',
            custom_id: `${BUTTON_CUSTOM_ID_PREFIX}:${ctx.tradeId}:accept`,
          },
          {
            type: COMPONENT_TYPE_BUTTON,
            style: BUTTON_STYLE_SECONDARY,
            label: 'Counter',
            custom_id: `${BUTTON_CUSTOM_ID_PREFIX}:${ctx.tradeId}:counter`,
          },
          {
            type: COMPONENT_TYPE_BUTTON,
            style: BUTTON_STYLE_DANGER,
            label: 'Decline',
            custom_id: `${BUTTON_CUSTOM_ID_PREFIX}:${ctx.tradeId}:decline`,
          },
        ],
      },
    ],
  };
}

/**
 * Variant of the proposal embed used when a proposal comes back as
 * a counter to one the viewer previously sent. Almost identical to
 * a fresh proposal DM — we explicitly keep this focused on "here's
 * what's on the table now" rather than dragging the full chain in.
 * The web detail view owns chain history (see design doc).
 */
export function buildCounterProposalMessage(
  ctx: ProposalMessageContext & { counteredTradeId: string },
): DiscordMessageBody {
  const base = buildProposalMessage(ctx);
  const embed = { ...base.embeds![0] };
  embed.title = `Counter from @${ctx.proposerHandle}`;
  embed.fields = [
    {
      name: 'Context',
      value: `Counter to your earlier proposal. Open the web app for the full history.`,
    },
    ...(embed.fields ?? []),
  ];
  return { ...base, embeds: [embed] };
}

/**
 * Replacement body for the ORIGINAL proposal's DM when a counter is
 * submitted. Strips the action row (the buttons are stale now) and
 * appends a status line pointing at the new counter. The recipient
 * sees their decision sealed; the web app remains the place to see
 * the counter's content.
 */
export function buildCounteredProposalMessage(
  ctx: ProposalMessageContext,
  responderHandle: string,
): DiscordMessageBody {
  const imbalance = imbalanceNote(ctx.offeringCards, ctx.receivingCards, ctx.proposerHandle);
  return {
    embeds: [{
      title: `Trade proposal from @${ctx.proposerHandle}`,
      color: 0x8B5CF6, // purple — distinct from accepted (emerald) / declined (red)
      description: ctx.message ? `> ${ctx.message}` : undefined,
      fields: [
        {
          name: `Offered (${formatSubtotal(ctx.offeringCards)})`,
          value: formatCardList(ctx.offeringCards),
        },
        {
          name: `Asked for (${formatSubtotal(ctx.receivingCards)})`,
          value: formatCardList(ctx.receivingCards),
        },
        ...(imbalance ? [imbalance] : []),
        { name: 'Status', value: `🔁 **Countered** by @${responderHandle} — check your DMs for the new offer.` },
      ],
      footer: { text: `SWUTrade proposal · ${ctx.tradeId.slice(0, 8)}` },
    }],
    components: [],
  };
}

/**
 * Replacement body for editing the recipient's DM after they've
 * accepted or declined. Same card info, but the action row is
 * dropped (empty array in the PATCH means "remove components") and
 * a status field is added.
 */
export function buildResolvedProposalMessage(
  ctx: ProposalMessageContext,
  outcome: 'accepted' | 'declined' | 'cancelled',
  responderHandle: string,
): DiscordMessageBody {
  const color = outcome === 'accepted'
    ? COLORS.emerald
    : outcome === 'declined'
      ? COLORS.red
      : COLORS.gray;
  const verb = outcome === 'accepted'
    ? 'Accepted'
    : outcome === 'declined'
      ? 'Declined'
      : 'Cancelled';
  const emoji = outcome === 'accepted' ? '✅' : outcome === 'declined' ? '❌' : '🚫';
  const actor = outcome === 'cancelled'
    ? `by the proposer (@${responderHandle})`
    : `by @${responderHandle}`;
  const imbalance = imbalanceNote(ctx.offeringCards, ctx.receivingCards, ctx.proposerHandle);

  return {
    embeds: [{
      title: `Trade proposal from @${ctx.proposerHandle}`,
      color,
      description: ctx.message ? `> ${ctx.message}` : undefined,
      fields: [
        {
          name: `Offered (${formatSubtotal(ctx.offeringCards)})`,
          value: formatCardList(ctx.offeringCards),
        },
        {
          name: `Asked for (${formatSubtotal(ctx.receivingCards)})`,
          value: formatCardList(ctx.receivingCards),
        },
        ...(imbalance ? [imbalance] : []),
        { name: 'Status', value: `${emoji} **${verb}** ${actor}` },
      ],
      footer: { text: `SWUTrade proposal · ${ctx.tradeId.slice(0, 8)}` },
    }],
    // Empty components array tells Discord to strip the action row.
    components: [],
  };
}

/**
 * Concise notification DM'd back to the proposer when the recipient
 * accepts or declines. Not the same shape as the recipient's DM —
 * the proposer already knows what they offered; they just need the
 * outcome.
 */
export function buildProposerNotification(opts: {
  tradeId: string;
  recipientHandle: string;
  outcome: 'accepted' | 'declined';
}): DiscordMessageBody {
  const color = opts.outcome === 'accepted' ? COLORS.emerald : COLORS.red;
  const emoji = opts.outcome === 'accepted' ? '✅' : '❌';
  const title = opts.outcome === 'accepted'
    ? `Your proposal was accepted`
    : `Your proposal was declined`;
  const followup = opts.outcome === 'accepted'
    ? 'Coordinate the hand-off directly with them on Discord.'
    : undefined;

  return {
    embeds: [{
      title: `${emoji} ${title}`,
      description: [
        `@${opts.recipientHandle} ${opts.outcome} your trade proposal.`,
        followup,
      ].filter(Boolean).join('\n\n'),
      color,
      footer: { text: `Trade ${opts.tradeId.slice(0, 8)}` },
    }],
  };
}
