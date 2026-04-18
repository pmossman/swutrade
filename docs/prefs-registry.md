# Prefs registry — design proposal

**Status:** proposal, not yet implemented.
**Motivation:** the manual wire-up for `communicationPref` (schema column + web `SettingsView` field + `/api/me/settings` PATCH schema + Discord `⚙ Prefs` button handler + tests) touched five surfaces. Doing that five more times for five more settings is mechanical work that will drift out of sync. A single registry can drive all five — *and* extend naturally to prefs scoped to other entities (peers, guilds) so the first "default to threads when trading with @alice" feature doesn't need a parallel architecture.

---

## Principles

1. **Web is canonical. Discord is convenience.**
   The web app is strictly more capable — every pref can be managed there, including rich enum descriptions, free text, multi-select, and per-peer batch operations. Discord's value is *not* parity; it's "tweak one relevant setting on the fly without going back to the app" when you're already in the flow of a proposal DM or a user interaction.
   - Every pref that has a Discord surface **must** also have a web surface.
   - The reverse is not required. A pref can be web-only if it doesn't render cleanly in Discord (free text, large enum spaces, batch editing).
   - The two surfaces share validation, storage, and the decision-matrix consumers — they only differ in *rendering*.

2. **Scope is a first-class field.**
   A pref is not just "what value" but "what value *for what target*." Self, peer, and guild scopes all need to flow through the same registry so the next multi-row pref doesn't trigger a redesign.

3. **Cascade resolution keeps consumers pure.**
   Downstream consumers (`threadConsent.ts`, matchmaker gating, etc.) always receive an *already-resolved* value. They never reach into storage to decide scope precedence. One lookup function handles that for every consumer.

---

## Which settings should the registry own?

Not all settings fit. The registry owns preferences that meet **all** of:

1. Single scalar value (boolean or small enum) at each scope.
2. Value is meaningful without surrounding selection state (no dependence on a list or freeform input).
3. Small enough option space to render as Discord buttons (≤ 5 options per row) or a Discord select (≤ 25 options) *if* Discord is a target surface.
4. Safe to change from a low-friction surface (no destructive-action confirm flow).

### In-scope today

| Column                | Scope         | Type                                                          | Today                      |
| --------------------- | ------------- | ------------------------------------------------------------- | -------------------------- |
| `communicationPref`   | self          | enum(prefer, auto-accept, allow, dm-only)                     | ✅ Discord button, no web yet |
| `communicationPref`   | peer (override) | enum(prefer, auto-accept, allow, dm-only) + `inherit`         | 🚧 new — this proposal       |
| `dmTradeProposals`    | self          | boolean                                                       | ✅ Web, not Discord          |
| `dmMatchAlerts`       | self          | boolean                                                       | ✅ Web, not Discord          |
| `dmMeetupReminders`   | self          | boolean                                                       | ✅ Web, not Discord          |
| `wantsPublic`         | self          | boolean                                                       | Not in Settings; set at signup |
| `availablePublic`     | self          | boolean                                                       | Not in Settings; set at signup |
| `profileVisibility`   | self          | enum(public, discord, private)                                | ✅ Web, not Discord          |

### Out of scope (stays bespoke)

- **Handle / username / avatar** — free text or image; Discord can't edit these cleanly.
- **Per-guild enrollment toggles** (`enrolled`, `includeInRollups`, `appearInQueries`) — already scope=guild, but they're coupled to the enrollment flow (affirmative opt-in + cascade rules on enrolled=false) that doesn't fit the generic per-field UI. Revisit once the registry is proven on self + peer.
- **Wants / available list management** — object management, not a preference.
- **Destructive account actions** (delete, purge) — web keeps confirmation affordances honest.
- **Billing / auth** — web-only for the safety properties.

---

## Scopes

```ts
type PrefScope =
  | { kind: 'self' }
  | { kind: 'peer' }    // targetId = peer user id
  | { kind: 'guild' }   // targetId = guild id (reserved; not migrated yet)
```

### Storage per scope

- **self**: columns on `users`. Existing.
- **peer**: new table `user_peer_prefs (user_id, peer_user_id, …columns, updated_at)`, primary key `(user_id, peer_user_id)`.
- **guild**: columns on `user_guild_memberships`. Existing.

### Peer rows are nullable overrides, not full records

A missing row means "no override for this peer; inherit from self." A null column in an existing row means the same. This matters for the cascade and the UX:

- Storage is sparse — no row for peers you've never touched. A community view with 10k members doesn't generate 10k pref rows.
- The UI renders "Inherit (currently: <self value>)" as the default chip state so users see the inherited value without special lookup.

### Survive-on-unenroll

Peer pref rows are **not** cleaned up when the viewer leaves a mutual guild. Rationale:
- If @alice and I co-reside in multiple guilds, leaving one shouldn't clear my prefs about her in the others.
- If I re-enroll later, my prefs are still there.
- Orphan rows (peer deleted their account) get cleaned up via a foreign-key cascade on `users`.

The storage cost is bounded by "peers I've explicitly configured," which is small.

---

## Proposed shape

### Types (lib/prefsRegistry.ts)

```ts
type PrefType =
  | { kind: 'boolean' }
  | { kind: 'enum'; options: ReadonlyArray<PrefOption> };

interface PrefOption {
  value: string;
  label: string;          // shown on the control
  description?: string;   // optional long-form (web <select> title, Discord follow-up)
}

type PrefSurface = 'web' | 'discord';

type PrefScope =
  | { kind: 'self' }
  | { kind: 'peer' }
  | { kind: 'guild' };

interface PrefDefinition<Value extends boolean | string = boolean | string> {
  /** Stable identifier. For peer-scoped prefs, keys can collide with
   *  self-scoped keys of the same column (e.g. 'communicationPref')
   *  because scope disambiguates. */
  key: string;
  scope: PrefScope;
  /** Column on the scope's backing table (`users` / `user_peer_prefs`
   *  / `user_guild_memberships`). Strict type in impl: Drizzle's
   *  inferred select keys for the appropriate table. */
  column: string;
  type: PrefType;
  label: string;
  description: string;
  /** For scope=self, the fallback if the column is null at read time.
   *  For scope=peer/guild, null means "no override, inherit from self."
   *  The registry validates that any peer-scoped pref has a matching
   *  self-scoped entry with the same column + type. */
  default: Value | null;
  surfaces: ReadonlyArray<PrefSurface>;
  /** Web-side grouping. */
  section?: 'privacy' | 'notifications' | 'communication';
  discord?: {
    /** Header on the ephemeral selector. Defaults to `label`. */
    prompt?: string;
    /** Order in the `/swutrade settings` list. Lower = earlier. */
    order?: number;
  };
}
```

### Registry (module-level const)

```ts
export const PREF_DEFINITIONS = [
  // Self-scoped default. Applies to every proposal unless a peer
  // override exists for the specific counterpart.
  definePref({
    key: 'communicationPref',
    scope: { kind: 'self' },
    column: 'communicationPref',
    type: { kind: 'enum', options: [
      { value: 'prefer',      label: 'Prefer threads' },
      { value: 'auto-accept', label: 'Auto-accept requests' },
      { value: 'allow',       label: 'Allow (ask each time)' },
      { value: 'dm-only',     label: 'DM only' },
    ]},
    label: 'Thread conversations',
    description: 'Default behavior when any trader proposes a trade with you.',
    default: 'allow',
    surfaces: ['web', 'discord'],
    section: 'communication',
  }),
  // Peer override. Same column, different table, nullable default.
  definePref({
    key: 'communicationPref',
    scope: { kind: 'peer' },
    column: 'communicationPref',
    type: { kind: 'enum', options: [
      { value: 'prefer',      label: 'Prefer threads' },
      { value: 'auto-accept', label: 'Auto-accept requests' },
      { value: 'allow',       label: 'Allow (ask each time)' },
      { value: 'dm-only',     label: 'DM only' },
    ]},
    label: 'Thread conversations (override)',
    description: 'Override your default for this specific trader.',
    default: null,
    surfaces: ['web', 'discord'],
    section: 'communication',
  }),
  definePref({
    key: 'dmTradeProposals',
    scope: { kind: 'self' },
    column: 'dmTradeProposals',
    type: { kind: 'boolean' },
    label: 'Trade proposals sent to me',
    description: "Bot DM when someone proposes a trade with you specifically.",
    default: true,
    surfaces: ['web', 'discord'],
    section: 'notifications',
  }),
  // ...
] as const;
```

---

## Cascade resolution

One read function for every consumer:

```ts
async function resolvePref<T>(opts: {
  key: string;
  viewerUserId: string;
  peerUserId?: string;     // required if the registry has a peer entry
  guildId?: string;        // required if the registry has a guild entry
}): Promise<T> {
  const peerDef = PREF_DEFINITIONS.find(d => d.key === opts.key && d.scope.kind === 'peer');
  const selfDef = PREF_DEFINITIONS.find(d => d.key === opts.key && d.scope.kind === 'self');
  if (!selfDef) throw new Error(`No self-scoped pref for key ${opts.key}`);

  if (peerDef && opts.peerUserId) {
    const peerRow = await db.select({ value: /* dynamic column */ })
      .from(userPeerPrefs)
      .where(and(
        eq(userPeerPrefs.userId, opts.viewerUserId),
        eq(userPeerPrefs.peerUserId, opts.peerUserId),
      ))
      .limit(1);
    const override = peerRow[0]?.value;
    if (override != null) return override as T;
  }

  const selfRow = await db.select({ value: /* dynamic column */ })
    .from(users)
    .where(eq(users.id, opts.viewerUserId))
    .limit(1);
  return (selfRow[0]?.value ?? selfDef.default) as T;
}
```

Consumers like `threadConsent.ts` never call `resolvePref` themselves — their callers pre-resolve both parties' prefs and pass them in. `threadConsent.ts` stays pure: `deliveryForPair(proposer: CommunicationPref, recipient: CommunicationPref)`. The `handlePropose` handler is the one that does the two `resolvePref({ peerUserId: other })` calls.

---

## HTTP endpoints (registry-driven)

`GET /api/me/prefs` → every self-scoped pref.
`GET /api/me/prefs?peer={peerUserId}` → peer overrides for that specific peer; response merges with the resolved values so the client can render "inherit (currently: X)" without a second call.
`PATCH /api/me/prefs` body:
  - self: `{ key, value }`
  - peer: `{ key, scope: 'peer', peerUserId, value: value | null }` (null clears the override)

Validation happens against the registry — look up the def, check type/enum membership, write the appropriate table. Replaces the hand-maintained Zod schemas.

---

## Web surface

### Self-scoped prefs: `SettingsView`

Iterates `PREF_DEFINITIONS.filter(d => d.scope.kind === 'self' && d.surfaces.includes('web'))`, groups by `section`, renders per-kind:

```tsx
function PrefField({ def, value, onChange }: {...}) {
  if (def.type.kind === 'boolean') return <ToggleField .../>;
  if (def.type.kind === 'enum')    return <SelectField options={def.type.options} .../>;
}
```

Existing bespoke `VisibilityField` / `ToggleField` become these two generic renderers.

### Peer-scoped prefs: directory view

**This is the canonical surface for peer prefs** — it's stronger than Discord's one-user-at-a-time context menu.

`CommunityView` (`/?community=1`) already enumerates members of mutually-enrolled guilds with per-row overlap metrics and sort modes. Extend it:

- New sort mode: "has override" (configured peers surface first).
- New per-row control: compact chip showing the resolved `communicationPref` value, with a popover to change it (or clear the override back to inherit).
- Server-side: `handleCommunityMembers` grows a `peerPrefs` field per member, joined from `user_peer_prefs`.

The web surface wins for scan + compare + batch:
- "Which of my trading partners have I set overrides for?" — sort by has-override, get an answer in one glance.
- "Set threads-prefer for my 5 trusted partners" — 5 clicks in one session, zero context-switching.

### Why web is canonical

The web app can render anything: long enum descriptions, free text, per-relationship notes, multi-select, batch actions, filters, sort modes, search across 10k members. Discord is physically constrained to buttons + selects + modals within Discord's component limits. Whenever those limits bite, web is the fallback *and* the better answer. So the registry treats web as the required surface and Discord as an opt-in enhancement.

---

## Discord surface

Three entry points, all dispatching into a shared `handlePrefsInteraction` that reads the registry:

1. **Inline `⚙ Prefs` button** on proposal DMs (already shipped for self.communicationPref; post-registry, extends to every Discord-surface-able self pref + the peer override for that specific counterpart).
2. **User context menu** (Discord's `APPLICATION_COMMAND` type 2): right-click a user → "SWUTrade prefs for @user" → ephemeral with peer-scoped prefs.
3. **`/swutrade settings`** slash command: no target → self prefs. `user:@alice` → peer prefs for alice.

`custom_id` format:

```
pref:self:{key}:open            → show selector for self pref
pref:self:{key}:set:{value}     → commit new self value
pref:peer:{peerId}:{key}:open   → show selector for peer override
pref:peer:{peerId}:{key}:set:{value}      → commit peer override
pref:peer:{peerId}:{key}:set:inherit      → clear peer override (back to self)
pref:index                      → top-level "pick a pref" list
```

Rendering rules:
- **Boolean** → two buttons (`On` / `Off`); current highlighted.
- **Enum ≤ 5 options** → one button per option; current highlighted. Peer-scoped prefs add a 5th "Inherit from default" button.
- **Enum 6–25 options** → string-select menu.
- **Enum > 25** → registry build-time assertion fails if `surfaces` includes `'discord'`. Only web surface allowed.

### Discord is strictly a subset of web

For every preference + scope the Discord surface exposes, the same control exists on web. Discord's value proposition is "you're in-flow and don't want to tab out" — not feature completeness.

---

## Migration plan

Eight small PRs, each independently shippable. **Status: all eight shipped as of 2026-04-18.**

1. ✅ **Add the registry module** (`lib/prefsRegistry.ts`) with `definePref` + type definitions. Unit test asserts every `column` exists on the scope's backing table and `default` matches the Drizzle default (for self-scoped). *(commit `731b8fb`)*
2. ✅ **Register the 4 current self-scoped prefs** (`communicationPref`, `dmTradeProposals`, `dmMatchAlerts`, `dmMeetupReminders`). No consumer changes yet. *(commit `731b8fb`)*
3. ✅ **Migrate `/api/me/settings` → `/api/me/prefs`** (self scope only, registry-driven). Keep the old path rewriting to the new one for one release. *(commit `7e57ce4`)*
4. ✅ **Refactor `SettingsView.AccountSection`** to render from registry. `profileVisibility` folded in via `label — description` options on the generic `EnumSelectField` — bespoke `VisibilityField` retired. *(commit `70c67fa`)*
5. ✅ **Rewrite the `⚙ Prefs` Discord button** on top of the registry. Match both `pref:*` and the existing `comm-pref:*` for one release; drop `comm-pref:*` after. *(commit `4dfb1bc`)*
6. ✅ **Add `user_peer_prefs` table + migration.** Composite PK on `(user_id, peer_user_id)` + cascade FKs. *(commit `aea2f8b`)*
7. ✅ **Register `communicationPref` at peer scope + `resolvePref` cascade.** `handlePropose` + `handleThreadFlowButton` now always resolve via the cascade. `threadConsent.ts` stays pure. *(commit `9014f4d`)*
8. ✅ **Web CommunityView directory editing** + `/api/me/prefs?peer=<id>` extension + **Discord `/swutrade settings` slash command + user context menu** + peer-scope button handler. *(commits `fdb4add`, `8cf579d`, `31dbb2f`)*

Steps 1–5 shipped the self-scoped refactor (abstraction, no new features). Steps 6–8 unlocked per-peer overrides across both web (`CommunityView` row selects) and Discord (slash + context menu + ephemeral selectors).

**Registering the Discord commands:**
Commands are declared in `scripts/register-discord-commands.mjs` and registered via one-off PUTs to `/applications/{CLIENT_ID}/commands`. Guild-scoped registration is instant and recommended for testing (`node scripts/register-discord-commands.mjs guild <id>`); global registration takes up to an hour to propagate and is for production rollout.

---

## Open questions

- **Long-form enum descriptions** on web (`profileVisibility`'s current UI includes "Public — anyone with the URL" etc). The generic select renderer would drop these. Proposed answer: `option.description` composes as `label — description` on web; Discord uses `label` only. One data shape, two renderings.
- **Per-guild scope migration.** The existing enrollment toggles fit `scope: 'guild'` conceptually but have cascade logic (enrolling flips `includeInRollups` + `appearInQueries` to true; unenrolling flips them to false). That's imperative flow, not declarative preference. Leave them out of the registry for now; revisit if a pure-preference guild field emerges.
- **UI for "has override" signal in CommunityView.** A small dot beside the resolved value is probably enough; don't want a full "overridden" chip on every row where most are inherited. Design detail for the implementation PR.
- **Bulk operations on web.** "Set all my enrolled-guild-members' comm pref to X" is tempting but probably footgun territory — overrides become invisible at scale. Deferred; revisit after usage data.
