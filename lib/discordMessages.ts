import type { DiscordMessageBody, DiscordComponent } from './discordBot.js';
import type { PrefDefinition, PrefValue } from './prefsRegistry.js';

/**
 * Builders for the Discord messages SWUTrade sends from the bot —
 * preference selectors, server-invite outreach, and session-lifecycle
 * DMs. Centralised here so every surface that emits a DM stays
 * visually cohesive: tune the color scheme or copy in one place.
 *
 * Colors mirror SWUTrade's web palette (see project_swutrade_palette):
 *   - gold: primary chrome / informational
 *   - emerald: success / accepted
 *   - red/crimson: declined / cancelled
 *
 * Button custom_id format: `{prefix}:{...}` — parsed in api/bot.ts to
 * dispatch to the right interaction handler. Each surface gets its
 * own prefix namespace so handlers can route by string match.
 */

/** Namespace for registry-driven preference controls surfaced via the
 *  `/swutrade settings` slash command + the SWUTrade-prefs user
 *  context menu. Format: `pref:{key}:open` or `pref:{key}:set:{value}`.
 *  The `key` resolves against `PREF_DEFINITIONS` (self-scope,
 *  discord-surfaced). See api/bot.ts handlePrefsButton. */
export const PREF_CUSTOM_ID_PREFIX = 'pref';
/** Namespace for the "SWUTrade just landed in {server}" invite DM's
 *  action buttons. Format: `server-invite:{guildId}:{action}`. Handler
 *  dispatch in api/bot.ts (`handleServerInviteButton`). */
export const SERVER_INVITE_CUSTOM_ID_PREFIX = 'server-invite';
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
    components: chunkButtonsIntoActionRows(
      defs.map(def => ({
        type: COMPONENT_TYPE_BUTTON,
        style: BUTTON_STYLE_SECONDARY,
        label: def.label,
        custom_id: `${PREF_CUSTOM_ID_PREFIX}:${def.key}:open`,
      })),
    ),
  };
}


/**
 * Discord caps action rows at 5 components and a single message at
 * 5 action rows (so up to 25 buttons total). The prefs index has
 * grown past 5 buttons; chunk into rows of 5 each so the message
 * still validates. Throws if the total exceeds the per-message cap
 * — that's a registry-design problem we'd rather catch at build/
 * test time than have Discord 400 in production.
 */
function chunkButtonsIntoActionRows(
  buttons: DiscordComponent[],
): DiscordComponent[] {
  if (buttons.length === 0) return [];
  if (buttons.length > 25) {
    throw new Error(
      `Too many buttons for one Discord message (${buttons.length} > 25). Split across two messages or reduce the surfaced pref count.`,
    );
  }
  const rows: DiscordComponent[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({
      type: COMPONENT_TYPE_ACTION_ROW,
      components: buttons.slice(i, i + 5),
    });
  }
  return rows;
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

/**
 * DM body sent to the counterpart of a shared trade when the viewer
 * explicitly clicks the "Ping @counterpart" button in the session
 * canvas. Phase B2 — explicit user-triggered nudge, not an automatic
 * edit notification. Optional free-form note included verbatim if
 * the user supplied one.
 *
 * Same minimal embed shape as the invite DM — title, one-line who +
 * action context, optional note, link out. The recipient acts on the
 * web, not in Discord.
 */
/**
 * DM body sent to the SENDER of a session that the recipient
 * explicitly declined. B5 — the recipient hit the Decline action
 * (vs the bilateral Cancel), so the language reads as a rejection
 * of the offer rather than a mutual "let's drop it." Optional
 * free-form note ("not at this price" / "already traded for these
 * cards" / etc.) is rendered verbatim if supplied.
 *
 * Recipient's `dmSessionDeclined` pref gates whether this fires —
 * the helper layer handles that, this template is pure formatting.
 */
export function buildSessionDeclinedMessage(opts: {
  declinerHandle: string;
  sessionUrl: string;
  note?: string;
}): DiscordMessageBody {
  const lines: string[] = [
    `@${opts.declinerHandle} declined your trade.`,
  ];
  if (opts.note && opts.note.trim().length > 0) {
    lines.push('', `> ${opts.note.trim()}`);
  }
  lines.push('', `[View the trade](<${opts.sessionUrl}>)`);
  return {
    embeds: [{
      title: 'Trade declined',
      description: lines.join('\n'),
      color: COLORS.gold,
      footer: { text: 'SWUTrade shared trade' },
    }],
  };
}

/**
 * Auto-DM fired when a counterpart triggers any session activity
 * (chat, edit, confirm, suggestion). Generic copy intentionally —
 * the recipient sees the specific events when they tap through. The
 * cooldown (~10 min per session per recipient) means a burst of
 * activity collapses into one DM, so this is a "go look" pointer
 * rather than a per-event firehose.
 */
export function buildSessionActivityMessage(opts: {
  counterpartHandle: string;
  sessionUrl: string;
}): DiscordMessageBody {
  return {
    embeds: [{
      title: 'New activity in your trade',
      description: [
        `@${opts.counterpartHandle} has new activity in your shared trade — chat, edit, or suggestion.`,
        '',
        `[Open shared trade](<${opts.sessionUrl}>)`,
      ].join('\n'),
      color: COLORS.gold,
      footer: { text: 'SWUTrade shared trade · adjust in /swutrade settings' },
    }],
  };
}
