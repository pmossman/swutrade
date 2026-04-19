/**
 * Single source of truth for user preferences.
 *
 * Every entry here is rendered on the web Settings page (required)
 * and optionally on Discord via the ⚙ Prefs button, the user context
 * menu, or `/swutrade settings`. See `docs/prefs-registry.md` for
 * the full design — especially the scope model (self / peer / guild)
 * and the web-canonical-Discord-convenience principle.
 *
 * Adding a new pref is a 3-step change:
 *   1. Add the column to `lib/schema.ts` + generate a migration.
 *   2. Register the def here with the matching column name + default.
 *   3. Nothing else — consumers (SettingsView, API, Discord) iterate
 *      the registry.
 *
 * Removing a pref: delete the def + ship a migration that drops the
 * column, same sitting.
 */

// -- types -------------------------------------------------------------------

export interface PrefOption {
  value: string;
  label: string;
  /** Long-form description. Rendered on web; Discord uses `label` only. */
  description?: string;
}

export type PrefType =
  | { kind: 'boolean' }
  | { kind: 'enum'; options: ReadonlyArray<PrefOption> };

export type PrefSurface = 'web' | 'discord';

/** `kind` is all the registry needs for dispatch — targetId is
 *  carried on the interaction payload, not on the def. */
export type PrefScope =
  | { kind: 'self' }
  | { kind: 'peer' }
  | { kind: 'guild' };

export type PrefValue = boolean | string | null;

export interface PrefDefinition {
  /** Stable identifier used in API payloads and Discord custom_ids.
   *  The same key may appear at multiple scopes (e.g. self + peer
   *  both carry `communicationPref`); scope disambiguates. */
  key: string;
  scope: PrefScope;
  /** Column on the scope's backing table. Validated at test time
   *  against the Drizzle schema to catch typos. */
  column: string;
  type: PrefType;
  /** Short human-readable label. Shown on web Settings field and as
   *  the Discord ephemeral selector title. */
  label: string;
  /** Longer one-paragraph explanation. Web uses this above the field;
   *  Discord uses it as ephemeral follow-up text when relevant. */
  description: string;
  /** Baseline value when the user hasn't set one. For scope=self the
   *  DB column carries the same default so the two can't disagree
   *  (see the unit test). For scope=peer/guild, `null` means "no
   *  override, fall back through the resolve cascade." */
  default: PrefValue;
  /** Web is required for every registered pref (see docs). Discord is
   *  opt-in; include it here when the type + option count render
   *  cleanly inside Discord's component limits. */
  surfaces: ReadonlyArray<PrefSurface>;
  /** Web grouping. Settings page renders one section per value. */
  section?: 'privacy' | 'notifications' | 'communication' | 'membership';
  discord?: {
    /** Optional header override on the ephemeral selector. */
    prompt?: string;
    /** Ordering within `/swutrade settings` listings. Lower = earlier.
     *  Implicit 0 when unset; ties broken by registration order. */
    order?: number;
  };
}

/**
 * Identity helper. Narrows the literal at the call site so type
 * inference picks up the enum option union without each entry needing
 * `as const`. The runtime is a straight return — all it's doing is
 * asserting the argument conforms to `PrefDefinition`.
 */
export function definePref(def: PrefDefinition): PrefDefinition {
  return def;
}

// -- definitions -------------------------------------------------------------

/**
 * Discord-renderable enum options reused between the self-scoped
 * default and the future peer-scoped override (step 7 of the
 * migration plan). Kept in one const so the two defs can't drift.
 */
const COMMUNICATION_PREF_OPTIONS: ReadonlyArray<PrefOption> = [
  {
    value: 'prefer',
    label: 'Prefer threads',
    description: 'Start every proposal in a thread when the other side is also opted in.',
  },
  {
    value: 'auto-accept',
    label: 'Auto-accept requests',
    description: "DM first, but instantly approve any thread request from the counterpart.",
  },
  {
    value: 'allow',
    label: 'Allow (ask each time)',
    description: 'DM first, approve or decline thread requests manually per trade.',
  },
  {
    value: 'dm-only',
    label: 'DM only',
    description: "Refuse threads entirely — no Request thread button on your proposal DMs.",
  },
];

export const PREF_DEFINITIONS: ReadonlyArray<PrefDefinition> = [
  definePref({
    key: 'communicationPref',
    scope: { kind: 'self' },
    column: 'communicationPref',
    type: { kind: 'enum', options: COMMUNICATION_PREF_OPTIONS },
    label: 'Thread conversations',
    description:
      'How SWUTrade routes Discord conversation for new trade proposals — ' +
      'private thread with both traders inside, or per-user DMs.',
    default: 'allow',
    surfaces: ['web', 'discord'],
    section: 'communication',
    discord: { order: 0 },
  }),
  // Peer-scoped override. Null default = "no override, inherit from
  // the viewer's self-scoped value." Both enum options and column
  // name MUST match the self-scoped def — the registry unit test
  // asserts this so the cascade resolver never returns a value the
  // schema can't store.
  definePref({
    key: 'communicationPref',
    scope: { kind: 'peer' },
    column: 'communicationPref',
    type: { kind: 'enum', options: COMMUNICATION_PREF_OPTIONS },
    label: 'Thread conversations (override)',
    description:
      'Override your default specifically when trading with this person. ' +
      'Pick Inherit to fall back to your global setting.',
    default: null,
    surfaces: ['web', 'discord'],
    section: 'communication',
    discord: { order: 0 },
  }),
  definePref({
    key: 'profileVisibility',
    scope: { kind: 'self' },
    column: 'profileVisibility',
    type: { kind: 'enum', options: [
      {
        value: 'discord',
        label: 'Discord only',
        description: 'Users in your enrolled servers.',
      },
      {
        value: 'public',
        label: 'Public',
        description: 'Anyone with the URL.',
      },
      {
        value: 'private',
        label: 'Private',
        description: 'Only you.',
      },
    ]},
    label: 'Profile visibility',
    description: 'Who can see your profile page and community rollups.',
    default: 'discord',
    // Web only for now — Discord's button renderer works cleanly for
    // short enum labels; once we surface this via Discord we'll need
    // a string-select (3 options with long descriptions don't fit in
    // a 5-button action row). Deferred to a later migration step.
    surfaces: ['web'],
    section: 'privacy',
  }),
  definePref({
    key: 'dmTradeProposals',
    scope: { kind: 'self' },
    column: 'dmTradeProposals',
    type: { kind: 'boolean' },
    label: 'Trade proposals sent to me',
    description: 'Bot DM when another user proposes a trade with you specifically.',
    default: true,
    surfaces: ['web', 'discord'],
    section: 'notifications',
    discord: { order: 10 },
  }),
  definePref({
    key: 'dmMatchAlerts',
    scope: { kind: 'self' },
    column: 'dmMatchAlerts',
    type: { kind: 'boolean' },
    label: 'Match alerts',
    description: "Unsolicited pings when someone's wants overlap with your available list.",
    default: false,
    surfaces: ['web', 'discord'],
    section: 'notifications',
    discord: { order: 11 },
  }),
  definePref({
    key: 'dmMeetupReminders',
    scope: { kind: 'self' },
    column: 'dmMeetupReminders',
    type: { kind: 'boolean' },
    label: 'Meetup reminders',
    description: "Reminders for LGS visits you've announced.",
    default: false,
    surfaces: ['web', 'discord'],
    section: 'notifications',
    discord: { order: 12 },
  }),
  definePref({
    key: 'dmServerNewInstall',
    scope: { kind: 'self' },
    column: 'dmServerNewInstall',
    type: { kind: 'boolean' },
    label: 'New server invitations',
    description: 'DM me once when SWUTrade lands in a server I\'m already in, with a one-tap enroll button.',
    default: true,
    surfaces: ['web', 'discord'],
    section: 'notifications',
    discord: { order: 13 },
  }),
  definePref({
    key: 'autoEnrollOnBotInstall',
    scope: { kind: 'self' },
    column: 'autoEnrollOnBotInstall',
    type: { kind: 'boolean' },
    label: 'Auto-enroll in new bot-installed servers',
    description: "When SWUTrade lands in a server you're already in, enroll you automatically. Off by default — you stay opt-in.",
    default: false,
    surfaces: ['web', 'discord'],
    section: 'membership',
    discord: { order: 20 },
  }),
  definePref({
    key: 'shareActivityPublicly',
    scope: { kind: 'self' },
    column: 'shareActivityPublicly',
    type: { kind: 'boolean' },
    label: 'Appear in community activity feeds',
    description: "Your trade-accepted and new-member events show up in each mutual server's activity feed. Turning this off hides past and future events from the feed without deleting them.",
    default: true,
    surfaces: ['web', 'discord'],
    section: 'privacy',
    discord: { order: 21 },
  }),
];

// -- lookup + validation -----------------------------------------------------

/** Resolve a definition by (key, scope). Returns undefined if no such
 *  def is registered — callers should treat missing defs as a 400-
 *  class error, not a silent fallthrough. */
export function getPrefDefinition(
  key: string,
  scope: PrefScope['kind'],
): PrefDefinition | undefined {
  return PREF_DEFINITIONS.find(d => d.key === key && d.scope.kind === scope);
}

export type PrefValidationResult =
  | { ok: true; value: boolean | string }
  | { ok: false; reason: string };

/**
 * Check that `value` conforms to `def.type`. Used by the /api/me/prefs
 * PATCH handler and by the Discord button handler as a belt-and-
 * suspenders guard against malformed `custom_id` values. Never trusts
 * the caller to have pre-validated.
 *
 * Does NOT accept `null` — that's a peer-scope "clear override" signal
 * handled separately in the PATCH handler; this validator is strictly
 * for "user is setting a concrete value."
 */
export function validatePrefValue(
  def: PrefDefinition,
  value: unknown,
): PrefValidationResult {
  if (def.type.kind === 'boolean') {
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, reason: 'expected boolean' };
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: 'expected string' };
  }
  const allowed = def.type.options.map(o => o.value);
  return allowed.includes(value)
    ? { ok: true, value }
    : { ok: false, reason: `expected one of ${allowed.join(', ')}` };
}
