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
/** Separate namespace for the ⚙ Prefs button surfaced on proposal
 *  DMs. Lives under its own prefix because the action is user-scoped
 *  (update communication_pref) rather than trade-scoped — no tradeId
 *  is carried in the custom_id. See api/bot.ts handleCommPrefButton. */
export const COMM_PREF_CUSTOM_ID_PREFIX = 'comm-pref';

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

/** The initial DM sent to the recipient when a proposal is created.
 *  When `includeRequestThreadButton` is true (the DM-with-request
 *  delivery path — neither side has pre-consented to threads, but
 *  neither has refused either), a fourth secondary-style button is
 *  appended so either party can kick off the mutual-approval flow.
 *  When `includePrefsButton` is true, a second action row carrying a
 *  single `⚙ Prefs` button is appended so users who prefer to tweak
 *  their thread preferences from inside Discord never have to leave.
 */
export function buildProposalMessage(
  ctx: ProposalMessageContext,
  opts: { includeRequestThreadButton?: boolean; includePrefsButton?: boolean } = {},
): DiscordMessageBody {
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

  const baseButtons = [
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
  ];

  const buttons = opts.includeRequestThreadButton
    ? [
        ...baseButtons,
        {
          type: COMPONENT_TYPE_BUTTON,
          style: BUTTON_STYLE_SECONDARY,
          label: 'Request thread',
          custom_id: `${BUTTON_CUSTOM_ID_PREFIX}:${ctx.tradeId}:request-thread`,
        },
      ]
    : baseButtons;

  const rows: DiscordMessageBody['components'] = [
    {
      type: COMPONENT_TYPE_ACTION_ROW,
      components: buttons,
    },
  ];
  if (opts.includePrefsButton) {
    rows!.push({
      type: COMPONENT_TYPE_ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE_BUTTON,
          style: BUTTON_STYLE_SECONDARY,
          label: '⚙ Prefs',
          custom_id: `${COMM_PREF_CUSTOM_ID_PREFIX}:open`,
        },
      ],
    });
  }

  return {
    embeds: [embed],
    components: rows,
  };
}

/**
 * Ephemeral-button body shown when a user clicks ⚙ Prefs. Four
 * secondary-style buttons, one per `CommunicationPref`, with the
 * currently-active pref rendered as success (green) so the user sees
 * where they stand at a glance. The custom_id carries the new pref
 * value; click is handled by `handleCommPrefButton` in api/bot.ts.
 */
export function buildCommPrefOptionsMessage(
  current: 'prefer' | 'auto-accept' | 'allow' | 'dm-only',
): DiscordMessageBody {
  const options: Array<{ pref: typeof current; label: string }> = [
    { pref: 'prefer',      label: 'Prefer threads' },
    { pref: 'auto-accept', label: 'Auto-accept requests' },
    { pref: 'allow',       label: 'Allow (ask each time)' },
    { pref: 'dm-only',     label: 'DM only' },
  ];
  return {
    content: [
      'Choose how SWUTrade should handle thread conversations for new proposals.',
      'Your current setting is highlighted in green.',
    ].join('\n'),
    components: [
      {
        type: COMPONENT_TYPE_ACTION_ROW,
        components: options.map(o => ({
          type: COMPONENT_TYPE_BUTTON,
          style: o.pref === current ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
          label: o.label,
          custom_id: `${COMM_PREF_CUSTOM_ID_PREFIX}:set:${o.pref}`,
        })),
      },
    ],
  };
}

/**
 * Ephemeral update body shown after the user picks a new pref. Drops
 * the button row (the decision is locked in for this interaction) and
 * echoes the human-readable label so the confirmation is specific.
 */
export function buildCommPrefConfirmationMessage(
  pref: 'prefer' | 'auto-accept' | 'allow' | 'dm-only',
): DiscordMessageBody {
  const label = pref === 'prefer'
    ? 'Prefer threads'
    : pref === 'auto-accept'
      ? 'Auto-accept requests'
      : pref === 'allow'
        ? 'Allow (ask each time)'
        : 'DM only';
  return {
    content: `Saved. Your thread preference is now **${label}**.`,
    components: [],
  };
}

/**
 * Variant shown in B's DM after a thread has been requested but not
 * yet approved. Accept/Counter/Decline stay live — the thread
 * decision is orthogonal to the accept decision; B can resolve the
 * trade from DM even while the thread request is pending. The
 * Request-thread button is removed so B doesn't try to re-request.
 */
export function buildThreadRequestedProposalMessage(
  ctx: ProposalMessageContext,
  requesterHandle: string,
): DiscordMessageBody {
  const base = buildProposalMessage(ctx, { includePrefsButton: true });
  const embed: DiscordEmbed = { ...base.embeds![0] };
  embed.color = COLORS.gold;
  embed.fields = [
    ...(embed.fields ?? []),
    {
      name: 'Thread',
      value: `Thread requested by @${requesterHandle} — waiting for response`,
    },
  ];
  return {
    embeds: [embed],
    components: base.components,
  };
}

/**
 * NEW DM sent to the counterpart when a thread is requested. Shows
 * the same two-sided summary as the original proposal so they know
 * what they're agreeing to chat about, plus Approve / Keep-as-DM
 * buttons. `custom_id` uses the `:{tradeId}:approve-thread` suffix
 * so the interaction dispatch can resolve back to the trade row.
 */
export function buildThreadApprovalRequestMessage(
  ctx: ProposalMessageContext,
  requesterHandle: string,
): DiscordMessageBody {
  const imbalance = imbalanceNote(ctx.offeringCards, ctx.receivingCards, ctx.proposerHandle);
  const embed: DiscordEmbed = {
    title: `@${requesterHandle} wants to move this trade to a private thread`,
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
            label: 'Approve',
            custom_id: `${BUTTON_CUSTOM_ID_PREFIX}:${ctx.tradeId}:approve-thread`,
          },
          {
            type: COMPONENT_TYPE_BUTTON,
            style: BUTTON_STYLE_SECONDARY,
            label: 'Keep as DM',
            custom_id: `${BUTTON_CUSTOM_ID_PREFIX}:${ctx.tradeId}:decline-thread`,
          },
        ],
      },
    ],
  };
}

/**
 * Variant used to edit BOTH DMs after a thread has been created. The
 * conversation has moved — there's nothing left to do in DM, so the
 * action row is dropped and a single "Moved to thread" pointer is
 * shown. Uses a purple color to mark the hand-off.
 */
export function buildThreadMovedProposalMessage(
  ctx: ProposalMessageContext,
  threadId: string,
): DiscordMessageBody {
  const imbalance = imbalanceNote(ctx.offeringCards, ctx.receivingCards, ctx.proposerHandle);
  return {
    embeds: [{
      title: `Trade proposal from @${ctx.proposerHandle}`,
      color: 0x8B5CF6, // purple — same hand-off color as countered
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
        { name: 'Status', value: `Moved to thread · <#${threadId}>` },
      ],
      footer: { text: `SWUTrade proposal · ${ctx.tradeId.slice(0, 8)}` },
    }],
    components: [],
  };
}

/**
 * Variant used to edit B's DM after the counterpart declined the
 * thread request. The proposal itself is still live (thread decision
 * is orthogonal), so Accept/Counter/Decline are RESTORED — just the
 * Request-thread button stays off (the request was denied).
 */
export function buildThreadRequestDeclinedMessage(
  ctx: ProposalMessageContext,
): DiscordMessageBody {
  const base = buildProposalMessage(ctx, { includePrefsButton: true });
  const embed: DiscordEmbed = { ...base.embeds![0] };
  embed.color = COLORS.gold;
  embed.fields = [
    ...(embed.fields ?? []),
    {
      name: 'Thread',
      value: 'Thread request declined — continuing in DM',
    },
  ];
  return {
    embeds: [embed],
    components: base.components,
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
