import type { DiscordMessageBody, DiscordEmbed } from './discordBot.js';
import type { TradeCardSnapshot } from './schema.js';
import type { PrefDefinition, PrefValue } from './prefsRegistry.js';

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
/** Namespace for registry-driven preference controls surfaced on
 *  proposal DMs and (future) the /swutrade settings slash command.
 *  Format: `pref:{key}:open` or `pref:{key}:set:{value}`. The `key`
 *  resolves against `PREF_DEFINITIONS` (self-scope, discord-surfaced).
 *  See api/bot.ts handlePrefsButton. */
export const PREF_CUSTOM_ID_PREFIX = 'pref';
/** Namespace for the "SWUTrade just landed in {server}" invite DM's
 *  action buttons. Format: `server-invite:{guildId}:{action}`. Handler
 *  dispatch in api/bot.ts (`handleServerInviteButton`). */
export const SERVER_INVITE_CUSTOM_ID_PREFIX = 'server-invite';
/** Legacy prefix for the comm-pref button shipped before the registry
 *  existed. The dispatcher accepts this during the transition and
 *  infers the key as `communicationPref`; new DMs emit the `pref:*`
 *  form instead. Remove once deployed DM buttons have had a release
 *  to roll over. */
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

// Discord caps embed field values at 1024 characters; sends with a
// field over the cap return 400 and fail the WHOLE message, which
// manifests to users as "I sent the proposal but the bot never DMed
// the recipient." Truncate at a safe margin below the cap + reserve
// room for a summary line so large lists gracefully degrade to
// "N shown + X more — open the web app."
const EMBED_FIELD_MAX = 1024;
// Overflow summary line is ~54 chars at worst ("+999 more — …").
// Reserve 70 for it + 4 for the joining newline + 20 buffer.
const EMBED_FIELD_SOFT_CAP = EMBED_FIELD_MAX - 94;

function formatCardList(cards: TradeCardSnapshot[]): string {
  if (cards.length === 0) return '_none_';
  const lines: string[] = [];
  let runningLength = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const price = c.unitPrice != null && c.unitPrice > 0 ? ` — $${c.unitPrice.toFixed(2)}` : '';
    const line = `• ${c.qty}× ${c.name} (${c.variant})${price}`;
    // Cost of adding this line: the line itself + a joining newline
    // when the list isn't empty.
    const cost = (lines.length === 0 ? 0 : 1) + line.length;
    if (runningLength + cost > EMBED_FIELD_SOFT_CAP) {
      const remaining = cards.length - i;
      // Markdown `_..._` = italics. The pair is balanced so underscores
      // in the interpolated number can't break parsing.
      lines.push(`• _+${remaining} more — open the web app for the full list_`);
      return lines.join('\n');
    }
    lines.push(line);
    runningLength += cost;
  }
  return lines.join('\n');
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
  /** SWUTrade user id of the proposer — baked into the ⚙ Prefs
   *  button's custom_id so clicking it opens a combined view with
   *  both the viewer's default AND their override-for-this-proposer.
   *  Without this id the button could only ever open self-scope. */
  proposerUserId: string;
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
 *  When `nudgeNote` is set, a "Nudge from @proposer" prefix embed is
 *  prepended so the recipient sees the optional note and realises
 *  the re-post is a bump rather than a fresh proposal.
 */
export function buildProposalMessage(
  ctx: ProposalMessageContext,
  opts: {
    includeRequestThreadButton?: boolean;
    includePrefsButton?: boolean;
    nudgeNote?: string;
  } = {},
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

  // Nudge prefix embed — small, gold-bordered callout that anchors
  // the re-post as a bump rather than a new proposal. Sits ABOVE the
  // main embed so the user scanning Discord sees "@alice bumped this"
  // before the two-column card list they already skimmed once.
  const nudgeEmbed: DiscordEmbed | null = opts.nudgeNote !== undefined
    ? {
        title: `👋 Nudge from @${ctx.proposerHandle}`,
        description: opts.nudgeNote ? `> ${opts.nudgeNote}` : 'Still open on their end — circling back.',
        color: COLORS.gold,
      }
    : null;

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
          // Opens a COMBINED view: the viewer's global default +
          // their override-for-this-proposer in one ephemeral. The
          // `combo` variant is the right default here — the user is
          // staring at a proposal from this specific person, which
          // is the highest-value moment to scope a peer pref.
          custom_id: `${PREF_CUSTOM_ID_PREFIX}:combo:${ctx.proposerUserId}:open`,
        },
      ],
    });
  }

  return {
    embeds: nudgeEmbed ? [nudgeEmbed, embed] : [embed],
    components: rows,
  };
}

/**
 * Ephemeral body shown when the user opens a pref selector — enum
 * prefs render one button per option, boolean prefs render On/Off.
 * The currently-active value is SUCCESS (green) so the user sees
 * where they stand at a glance; other values stay SECONDARY. Click
 * dispatch is `handlePrefsButton` in api/bot.ts.
 */
export function buildPrefOptionsMessage(
  def: PrefDefinition,
  currentValue: PrefValue,
): DiscordMessageBody {
  if (def.type.kind === 'boolean') {
    const cur = currentValue as boolean;
    return {
      content: `**${def.label}** — ${def.description}`,
      components: [{
        type: COMPONENT_TYPE_ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE_BUTTON,
            style: cur === true ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
            label: 'On',
            custom_id: `${PREF_CUSTOM_ID_PREFIX}:${def.key}:set:true`,
          },
          {
            type: COMPONENT_TYPE_BUTTON,
            style: cur === false ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
            label: 'Off',
            custom_id: `${PREF_CUSTOM_ID_PREFIX}:${def.key}:set:false`,
          },
        ],
      }],
    };
  }
  // Enum — registry guarantees ≤ 5 options for Discord-surfaced defs
  // (enforced in the registry unit test), so the single action row
  // never overflows.
  return {
    content: `**${def.label}** — ${def.description}\nYour current setting is highlighted.`,
    components: [{
      type: COMPONENT_TYPE_ACTION_ROW,
      components: def.type.options.map(opt => ({
        type: COMPONENT_TYPE_BUTTON,
        style: opt.value === currentValue ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
        label: opt.label,
        custom_id: `${PREF_CUSTOM_ID_PREFIX}:${def.key}:set:${opt.value}`,
      })),
    }],
  };
}

/**
 * Peer-scoped variant of `buildPrefOptionsMessage`. Renders an extra
 * leading "Inherit" button alongside the enum/boolean options; picking
 * Inherit clears the override so the viewer's self value takes over
 * via the cascade. `currentOverride` is the raw `user_peer_prefs`
 * value (null = no row or null column); `currentEffective` is what
 * `resolvePref` currently returns so the highlighted button matches
 * the value the matrix is actually seeing.
 */
export function buildPeerPrefOptionsMessage(
  def: PrefDefinition,
  peerUserId: string,
  peerHandle: string,
  currentOverride: PrefValue,
  currentEffective: PrefValue,
): DiscordMessageBody {
  // Inherit button — no override stored when selected.
  const inheritButton = {
    type: COMPONENT_TYPE_BUTTON,
    // Highlight inherit when there's no override; otherwise secondary.
    style: currentOverride == null ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
    // Button copy is "Use my default" — end-user readable vs the
    // dev-jargon "Inherit". The custom_id action stays `:set:inherit`
    // (internal contract with the handler) to avoid a migration.
    label: 'Use my default',
    custom_id: `${PREF_CUSTOM_ID_PREFIX}:peer:${peerUserId}:${def.key}:set:inherit`,
  };
  if (def.type.kind === 'boolean') {
    const cur = currentOverride as boolean | null;
    return {
      content: `**${def.label}** for <@${peerUserId}> (@${peerHandle}) — ${def.description}\nCurrent effective value: **${currentEffective ? 'On' : 'Off'}**`,
      components: [{
        type: COMPONENT_TYPE_ACTION_ROW,
        components: [
          inheritButton,
          {
            type: COMPONENT_TYPE_BUTTON,
            style: cur === true ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
            label: 'On',
            custom_id: `${PREF_CUSTOM_ID_PREFIX}:peer:${peerUserId}:${def.key}:set:true`,
          },
          {
            type: COMPONENT_TYPE_BUTTON,
            style: cur === false ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
            label: 'Off',
            custom_id: `${PREF_CUSTOM_ID_PREFIX}:peer:${peerUserId}:${def.key}:set:false`,
          },
        ],
      }],
    };
  }
  // Enum — max 4 options to fit alongside the leading Inherit button
  // in a single 5-button action row. Registry invariant enforces ≤ 4
  // option enums for peer-scoped Discord surfaces (see peer def for
  // communicationPref — 4 options + inherit = 5 total).
  return {
    content: `**${def.label}** for <@${peerUserId}> (@${peerHandle}) — ${def.description}\nCurrent effective value is highlighted.`,
    components: [{
      type: COMPONENT_TYPE_ACTION_ROW,
      components: [
        inheritButton,
        ...def.type.options.map(opt => ({
          type: COMPONENT_TYPE_BUTTON,
          style: opt.value === currentOverride ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
          label: opt.label,
          custom_id: `${PREF_CUSTOM_ID_PREFIX}:peer:${peerUserId}:${def.key}:set:${opt.value}`,
        })),
      ],
    }],
  };
}

/**
 * Top-level index shown when a user runs `/swutrade settings` with
 * no target user — one button per Discord-surfaced self-scoped pref
 * where the label is the human pref name and the button click opens
 * that pref's selector. Buttons fit in a single action row today (4
 * Discord-surfaced self prefs); if we register a 6th, the caller
 * will need to split across multiple action rows.
 */
export function buildSelfPrefsIndexMessage(
  defs: ReadonlyArray<PrefDefinition>,
): DiscordMessageBody {
  return {
    content:
      "**SWUTrade preferences** — choose a setting to change. " +
      "These apply globally; per-trader overrides live on `/swutrade settings user:@someone`.",
    components: [{
      type: COMPONENT_TYPE_ACTION_ROW,
      components: defs.map(def => ({
        type: COMPONENT_TYPE_BUTTON,
        style: BUTTON_STYLE_SECONDARY,
        label: def.label,
        custom_id: `${PREF_CUSTOM_ID_PREFIX}:${def.key}:open`,
      })),
    }],
  };
}

/**
 * Peer-scoped index rendered when the user invokes `/swutrade settings
 * user:@alice` or the "SWUTrade prefs" user context menu on someone.
 * One button per Discord-surfaced peer-scoped pref; each click opens
 * that pref's selector with the peer id baked in. The content line
 * names the target user via an `@` mention so the user sees who
 * they're setting prefs for.
 */
export function buildPeerPrefsIndexMessage(
  defs: ReadonlyArray<PrefDefinition>,
  peerUserId: string,
  peerHandle: string,
): DiscordMessageBody {
  if (defs.length === 0) {
    return {
      content:
        `**SWUTrade preferences for <@${peerUserId}> (@${peerHandle})** — ` +
        "no per-trader settings are available yet. Your global defaults apply.",
    };
  }
  return {
    content:
      `**SWUTrade preferences for <@${peerUserId}> (@${peerHandle})** — ` +
      `choose a setting to override specifically for this trader. ` +
      `"Use my default" = no override, your global setting applies.`,
    components: [{
      type: COMPONENT_TYPE_ACTION_ROW,
      components: defs.map(def => ({
        type: COMPONENT_TYPE_BUTTON,
        style: BUTTON_STYLE_SECONDARY,
        label: def.label,
        custom_id: `${PREF_CUSTOM_ID_PREFIX}:peer:${peerUserId}:${def.key}:open`,
      })),
    }],
  };
}

/**
 * Ephemeral update body shown after a pref is committed. Drops the
 * button row (decision is locked for this interaction) and echoes
 * the human-readable value back so the confirmation is specific.
 */
export function buildPrefConfirmationMessage(
  def: PrefDefinition,
  newValue: PrefValue,
): DiscordMessageBody {
  let humanValue: string;
  if (def.type.kind === 'boolean') {
    humanValue = (newValue as boolean) ? 'on' : 'off';
  } else {
    const option = def.type.options.find(o => o.value === newValue);
    humanValue = option?.label ?? String(newValue);
  }
  return {
    content: `Saved. **${def.label}** is now **${humanValue}**.`,
    components: [],
  };
}

/**
 * Two-row ephemeral shown when the viewer clicks ⚙ Prefs on a
 * proposal DM. The top row sets their GLOBAL default; the bottom
 * row sets an OVERRIDE specifically for the proposer on this DM.
 * Both rows carry the existing per-scope `pref:*:set:*` custom_ids
 * so clicks land on the already-tested self + peer write paths —
 * this is purely a layout over primitives that already ship.
 *
 * After either button fires the ephemeral gets PATCHed to the
 * single-click confirmation message; the user closes the ephemeral
 * and re-clicks ⚙ Prefs if they want to tweak more. That's a minor
 * friction, but keeping confirmation behaviour consistent with the
 * standalone flows wins more than a stateful dashboard would.
 */
export function buildCombinedPrefsMessage(
  def: PrefDefinition,
  peerUserId: string,
  peerHandle: string,
  currentSelf: PrefValue,
  currentOverride: PrefValue,
  currentEffective: PrefValue,
): DiscordMessageBody {
  const humanize = (value: PrefValue): string => {
    if (def.type.kind === 'boolean') {
      return value === true ? 'On' : value === false ? 'Off' : 'unset';
    }
    const opt = def.type.kind === 'enum'
      ? def.type.options.find(o => o.value === value)
      : undefined;
    return opt?.label ?? String(value ?? 'unset');
  };

  // Self row: one button per option, current highlighted. Writes go
  // to users.<column> via the existing self handler.
  const selfButtons = def.type.kind === 'enum'
    ? def.type.options.map(opt => ({
        type: COMPONENT_TYPE_BUTTON,
        style: opt.value === currentSelf ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
        label: opt.label,
        custom_id: `${PREF_CUSTOM_ID_PREFIX}:${def.key}:set:${opt.value}`,
      }))
    : [];

  // Peer row: Use-my-default + per-option. "Use my default" is always
  // styled success when there's no override; otherwise the current
  // override option is highlighted. Writes go to user_peer_prefs.
  const peerButtons = [
    {
      type: COMPONENT_TYPE_BUTTON,
      style: currentOverride == null ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
      label: 'Use my default',
      custom_id: `${PREF_CUSTOM_ID_PREFIX}:peer:${peerUserId}:${def.key}:set:inherit`,
    },
    ...(def.type.kind === 'enum'
      ? def.type.options.map(opt => ({
          type: COMPONENT_TYPE_BUTTON,
          style: opt.value === currentOverride ? BUTTON_STYLE_SUCCESS : BUTTON_STYLE_SECONDARY,
          label: opt.label,
          custom_id: `${PREF_CUSTOM_ID_PREFIX}:peer:${peerUserId}:${def.key}:set:${opt.value}`,
        }))
      : []),
  ];

  const overrideDescription = currentOverride == null
    ? `using your default (${humanize(currentEffective)})`
    : `**${humanize(currentOverride)}**`;

  return {
    content: [
      `**${def.label}** — ${def.description}`,
      ``,
      `**Your default** (top row, applies to everyone): **${humanize(currentSelf)}**`,
      `**For <@${peerUserId}> (@${peerHandle})** (bottom row): ${overrideDescription}`,
    ].join('\n'),
    components: [
      { type: COMPONENT_TYPE_ACTION_ROW, components: selfButtons },
      { type: COMPONENT_TYPE_ACTION_ROW, components: peerButtons },
    ],
  };
}

/**
 * Peer-scope variant of the confirmation. `newValue == null` means
 * the override was cleared (inherit path); show the effective value
 * the cascade now resolves to so the user sees the new answer, not
 * just "removed."
 */
export function buildPeerPrefConfirmationMessage(
  def: PrefDefinition,
  peerUserId: string,
  peerHandle: string,
  newValue: PrefValue,
  effectiveAfter: PrefValue,
): DiscordMessageBody {
  if (newValue == null) {
    let humanEffective: string;
    if (def.type.kind === 'boolean') {
      humanEffective = effectiveAfter ? 'on' : 'off';
    } else {
      const opt = def.type.kind === 'enum'
        ? def.type.options.find(o => o.value === effectiveAfter)
        : undefined;
      humanEffective = opt?.label ?? String(effectiveAfter ?? 'unset');
    }
    return {
      content: `Override cleared for <@${peerUserId}> (@${peerHandle}). **${def.label}** now uses your default: **${humanEffective}**.`,
      components: [],
    };
  }
  let humanValue: string;
  if (def.type.kind === 'boolean') {
    humanValue = newValue ? 'on' : 'off';
  } else if (def.type.kind === 'enum') {
    humanValue = def.type.options.find(o => o.value === newValue)?.label ?? String(newValue);
  } else {
    humanValue = String(newValue);
  }
  return {
    content: `Saved. **${def.label}** for <@${peerUserId}> (@${peerHandle}) is now **${humanValue}**.`,
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
 * Coalesced notification DM'd to a proposer when their recipient
 * bulk-declines several of their proposals in one action. One
 * summary DM replaces N per-proposal notifications — Discord
 * rate-limits DM-channel creation (error code 40003, "You are
 * opening direct messages too fast") separately from the usual
 * 429, and rapidly firing per-row DMs trips it.
 *
 * Contract: at least one declined id is implied. `sampleTradeIds`
 * is clamped to the first 3 for embed brevity — the full list
 * lives in the web history view.
 */
export function buildBulkDeclineNotification(opts: {
  recipientHandle: string;
  recipientUsername: string;
  declinedCount: number;
  sampleTradeIds: string[];
}): DiscordMessageBody {
  const n = opts.declinedCount;
  const title = `${n} of your proposal${n === 1 ? ' was' : 's were'} declined`;
  const samples = opts.sampleTradeIds.slice(0, 3);
  const sampleList = samples
    .map(id => `• \`${id.slice(0, 8)}\``)
    .join('\n');
  const remainder = n - samples.length;
  const sampleValue = remainder > 0
    ? `${sampleList}\n_…and ${remainder} more — open SWUTrade to see the rest._`
    : sampleList || '_none_';

  return {
    embeds: [{
      title: `❌ ${title}`,
      description: `@${opts.recipientHandle} (${opts.recipientUsername}) declined ${n === 1 ? 'a proposal' : `${n} proposals`} you sent them.`,
      color: COLORS.red,
      fields: [
        { name: n === 1 ? 'Trade' : 'Trades', value: sampleValue },
      ],
      footer: { text: 'SWUTrade bulk response' },
    }],
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

// --- Server invite DM (bot-install outreach to existing members) -----------

export interface ServerInviteContext {
  guildId: string;
  guildName: string;
  /** Full Discord CDN URL for the guild icon, if any. Used as the
   *  embed's thumbnail — the "who is this server" signal matters
   *  more than any SWUTrade chrome for this message. */
  guildIconUrl?: string | null;
  /** Where the "Open SWUTrade" link takes the user. Falls back to
   *  the beta preview when not supplied (e.g. local testing). */
  webAppUrl?: string;
}

const SERVER_INVITE_GOLD = 0xD4AF37;
const SERVER_INVITE_GREEN = 0x34D399;
const DEFAULT_WEB_APP_URL = 'https://beta.swutrade.com';

/**
 * Invitational DM sent when the bot lands in a guild the user is
 * already in. Sized to be both useful to someone who's never seen
 * SWUTrade AND skimmable for someone who's already using it in three
 * other servers. The "Enroll in …" button completes the decision in
 * one tap — no web detour, no multi-step flow — while the link
 * button preserves the "I want to poke around first" path.
 */
export function buildServerInviteMessage(ctx: ServerInviteContext): DiscordMessageBody {
  const webApp = ctx.webAppUrl ?? DEFAULT_WEB_APP_URL;
  return {
    embeds: [{
      title: `SWUTrade just landed in ${ctx.guildName}`,
      description: "The bot's here. If you're ready to start trading with other members, one tap below gets you in.",
      color: SERVER_INVITE_GOLD,
      thumbnail: ctx.guildIconUrl ? { url: ctx.guildIconUrl } : undefined,
      fields: [
        {
          name: '🔍  Match with traders',
          value: "See who in this server wants cards you'd trade — and who has cards you're hunting for.",
        },
        {
          name: '💬  One-tap proposals',
          value: "Compose a trade in the web app; SWUTrade DMs it to the recipient with Accept / Counter / Decline buttons right here in Discord.",
        },
        {
          name: '🧭  You stay in control',
          value: `Your wants and available lists stay private until you enroll. Change this any time in [Settings](<${webApp}/?settings=1>) → Server membership.`,
        },
      ],
      footer: {
        text: "Opt out of these DMs in Settings → Preferences → Bot notifications.",
      },
    }],
    components: [{
      type: COMPONENT_TYPE_ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE_BUTTON,
          style: BUTTON_STYLE_SUCCESS,
          label: `Enroll in ${truncateForButton(ctx.guildName)}`,
          custom_id: `${SERVER_INVITE_CUSTOM_ID_PREFIX}:${ctx.guildId}:enroll`,
        },
        {
          type: COMPONENT_TYPE_BUTTON,
          style: 5, // LINK
          label: 'Open SWUTrade',
          url: webApp,
        },
      ],
    }],
  };
}

/**
 * Variant DM for users who had `autoEnrollOnBotInstall = true` — they
 * explicitly asked for the aggressive flow, so this message confirms
 * enrollment instead of prompting for it. "Manage" button deep-links
 * into the Settings server-detail in case they want to tune consent
 * axes individually or back out.
 */
export function buildServerAutoEnrolledMessage(ctx: ServerInviteContext): DiscordMessageBody {
  const webApp = ctx.webAppUrl ?? DEFAULT_WEB_APP_URL;
  const manageUrl = `${webApp}/?settings=1&tab=servers&guild=${encodeURIComponent(ctx.guildId)}`;
  return {
    embeds: [{
      title: `You're enrolled in ${ctx.guildName}`,
      description: "SWUTrade just landed in this server — and because you had auto-enroll on, you're in the community already. Your wants + available lists are now visible to other enrolled members here.",
      color: SERVER_INVITE_GREEN,
      thumbnail: ctx.guildIconUrl ? { url: ctx.guildIconUrl } : undefined,
      fields: [
        {
          name: 'Manage this server',
          value: `Turn off individual consent axes (rollups, who-has queries) or leave the community entirely in [Settings](<${manageUrl}>).`,
        },
      ],
      footer: {
        text: "You can disable auto-enroll in Settings → Preferences → Server membership.",
      },
    }],
  };
}

/**
 * Replacement body for the invite DM after the user taps "Enroll".
 * The original message gets PATCHed (via INTERACTION_RESPONSE_TYPE 7)
 * so the button disappears and the state of the DM matches the
 * state of the world — no "does it know I clicked?" confusion.
 */
export function buildServerEnrollConfirmationMessage(ctx: ServerInviteContext): DiscordMessageBody {
  const webApp = ctx.webAppUrl ?? DEFAULT_WEB_APP_URL;
  const manageUrl = `${webApp}/?settings=1&tab=servers&guild=${encodeURIComponent(ctx.guildId)}`;
  return {
    embeds: [{
      title: `✅ Enrolled in ${ctx.guildName}`,
      description: "You're in. Your wants + available lists are now visible to other enrolled members of this server, and you'll show up in their trade matches.",
      color: SERVER_INVITE_GREEN,
      thumbnail: ctx.guildIconUrl ? { url: ctx.guildIconUrl } : undefined,
      fields: [
        {
          name: 'Next steps',
          value: [
            `• [Manage your lists](<${webApp}/>) if you haven't yet — your visibility depends on what's on them.`,
            `• [Tune this server's settings](<${manageUrl}>) — individual rollup / who-has toggles.`,
            `• Run \`/swutrade settings\` in this server to tweak global preferences.`,
          ].join('\n'),
        },
      ],
      footer: { text: "You can leave the community any time in Settings → Discord servers." },
    }],
    components: [],
  };
}

/** Discord button labels cap at 80 chars; some guild names blow past
 *  that. Preserve the prefix ("Enroll in …") and truncate the name. */
function truncateForButton(name: string): string {
  const MAX = 70; // leaves room for "Enroll in " prefix
  return name.length > MAX ? `${name.slice(0, MAX - 1)}…` : name;
}

// --- Shared-trade handle invite DM ----------------------------------------

/**
 * DM body sent to a user when someone invites them by handle to an
 * open shared trade (Phase 5b invite-by-handle flow). Intentionally
 * minimal — the session itself carries the trade detail; this DM just
 * points the recipient at the URL so a single tap lands them on the
 * join screen.
 *
 * Uses a link embedded in the description rather than a LINK button
 * so the message stays readable in clients (mobile, watch previews)
 * that don't render interactive components consistently.
 */
export function buildSessionInviteMessage(opts: {
  inviterHandle: string;
  sessionUrl: string;
}): DiscordMessageBody {
  return {
    embeds: [{
      title: 'Shared trade invite',
      description: [
        `@${opts.inviterHandle} invited you to join a shared trade on SWUTrade.`,
        '',
        `[Open shared trade](<${opts.sessionUrl}>)`,
      ].join('\n'),
      color: COLORS.gold,
      footer: { text: 'SWUTrade shared trade' },
    }],
  };
}
