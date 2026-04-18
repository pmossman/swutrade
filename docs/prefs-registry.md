# Prefs registry — design proposal

**Status:** proposal, not yet implemented.
**Motivation:** the manual wire-up for `communicationPref` (schema column + web `SettingsView` field + `/api/me/settings` PATCH schema + Discord `⚙ Prefs` button handler + tests) touched five surfaces. Doing that five more times for five more settings is mechanical work that will drift out of sync. A single registry can drive all five.

---

## Which settings should the registry own?

Not all settings fit. The registry owns user-scoped preferences that meet **all** of:

1. Single scalar value (boolean or small enum).
2. Value is meaningful without surrounding context (no list/selection state).
3. Small enough option space to render as Discord buttons (≤ 5 options) or a Discord select (≤ 25 options).
4. Safe to change from a low-friction surface (no destructive-action confirm flow).

### In-scope today

| Column                | Type                                                          | Today                      |
| --------------------- | ------------------------------------------------------------- | -------------------------- |
| `communicationPref`   | enum(prefer, auto-accept, allow, dm-only)                     | ✅ Discord button, no web yet |
| `dmTradeProposals`    | boolean                                                       | ✅ Web, not Discord          |
| `dmMatchAlerts`       | boolean                                                       | ✅ Web, not Discord          |
| `dmMeetupReminders`   | boolean                                                       | ✅ Web, not Discord          |
| `wantsPublic`         | boolean                                                       | Not in Settings; set at signup |
| `availablePublic`     | boolean                                                       | Not in Settings; set at signup |
| `profileVisibility`   | enum(public, discord, private)                                | ✅ Web, not Discord          |

### Out of scope (stays bespoke)

- **Handle / username / avatar** — free text or image; Discord can't edit these cleanly.
- **Per-guild enrollment toggles** (`enrolled`, `includeInRollups`, `appearInQueries`) — multi-row, needs guild list context.
- **Wants / available list management** — object management, not a preference.
- **Destructive account actions** (delete, purge) — web keeps confirmation affordances honest.
- **Billing / auth** — web-only for the safety properties.

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

interface PrefDefinition<Value extends boolean | string = boolean | string> {
  /** Stable identifier used in API payloads and Discord custom_ids. */
  key: string;
  /** Corresponding column on the `users` Drizzle table. */
  column: keyof typeof users.$inferInsert;
  type: PrefType;
  label: string;
  description: string;
  default: Value;
  surfaces: ReadonlyArray<PrefSurface>;
  /** Web-side grouping. Unused when web is not in `surfaces`. */
  section?: 'privacy' | 'notifications' | 'communication';
  /** Optional Discord-specific tuning. */
  discord?: {
    /** Header shown on the ephemeral selector. Defaults to `label`. */
    prompt?: string;
    /** Order in the `/swutrade settings` list. Lower = earlier. */
    order?: number;
  };
}
```

### Registry (module-level const)

```ts
export const PREF_DEFINITIONS = [
  definePref({
    key: 'communicationPref',
    column: 'communicationPref',
    type: { kind: 'enum', options: [
      { value: 'prefer',      label: 'Prefer threads' },
      { value: 'auto-accept', label: 'Auto-accept requests' },
      { value: 'allow',       label: 'Allow (ask each time)' },
      { value: 'dm-only',     label: 'DM only' },
    ]},
    label: 'Thread conversations',
    description: 'How SWUTrade handles Discord thread creation for new trade proposals.',
    default: 'allow',
    surfaces: ['web', 'discord'],
    section: 'communication',
  }),
  definePref({
    key: 'dmTradeProposals',
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

`definePref` is the identity helper — it exists only so the `const` literal carries through with strict types (e.g. enum `value` narrows from `string` to the union).

---

## Shared plumbing

### One HTTP endpoint, registry-driven

`GET /api/me/prefs` → `{ key: value }` for every `PREF_DEFINITIONS` entry (values pulled from `users` via the column mapping).

`PATCH /api/me/prefs` body `{ key: string, value: unknown }`:
- Look up the def by `key`; 404 if unknown.
- Validate `value` against `def.type` (boolean coercion, enum membership).
- `UPDATE users SET <def.column> = value WHERE id = session.userId`.

Replaces the hand-maintained Zod schema + per-column plumbing in `handleSettings` (`api/me.ts`).

### Shared validator

```ts
export function validatePrefValue(def: PrefDefinition, value: unknown): { ok: true; value: PrefValue } | { ok: false; reason: string } {
  if (def.type.kind === 'boolean') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: 'expected boolean' };
  }
  const allowed = def.type.options.map(o => o.value);
  return typeof value === 'string' && allowed.includes(value)
    ? { ok: true, value }
    : { ok: false, reason: `expected one of ${allowed.join(',')}` };
}
```

Used by:
- `PATCH /api/me/prefs` (reject bad body).
- Discord button handler (belt-and-suspenders against malformed `custom_id`).

---

## Web surface

`SettingsView` iterates `PREF_DEFINITIONS.filter(d => d.surfaces.includes('web'))`, groups by `section`, and renders per-kind:

```tsx
function PrefField({ def, value, onChange }: {...}) {
  if (def.type.kind === 'boolean') return <ToggleField .../>;
  if (def.type.kind === 'enum')    return <SelectField options={def.type.options} .../>;
}
```

The existing bespoke `VisibilityField` + `ToggleField` become the two component implementations. No custom per-field code per setting.

---

## Discord surface

Two entry points, both backed by the same dispatcher:

1. **Inline `⚙ Prefs` button** on proposal DMs (already shipped). Post-registry, the button opens an ephemeral listing the user's `discord`-surface-able prefs, not just comm pref.
2. **`/swutrade settings` slash command** — registers a top-level command so users can reach the same prefs without waiting for a proposal DM.

Both dispatch into a shared `handlePrefsInteraction` that reads the registry. `custom_id` format becomes:

```
pref:{key}:open              → show selector for this pref
pref:{key}:set:{value}       → commit new value
pref:index                   → top-level "pick a pref" list (from slash command)
```

Rendering rules:
- **Boolean** → two buttons (`On` / `Off`); current highlighted with `SUCCESS` style.
- **Enum ≤ 5 options** → one button per option; current highlighted.
- **Enum 6–25 options** → string-select menu (not needed today but forward-compatible).
- **Enum > 25** → not allowed on Discord; def will fail a build-time assertion if it sets `surfaces: ['discord']`.

---

## Migration plan

Six small PRs, each independently shippable:

1. **Add the registry module** (`lib/prefsRegistry.ts`) with the `definePref` helper + type definitions. No consumers yet.
2. **Register the 4 boolean/enum prefs** (`communicationPref`, `dmTradeProposals`, `dmMatchAlerts`, `dmMeetupReminders`). Validate via a unit test that every entry's `column` exists on `users` and `default` matches the schema's `.default(...)`.
3. **Migrate `/api/me/settings` → `/api/me/prefs`** (registry-driven). Keep the old path rewriting to the new one for one release to avoid client breakage.
4. **Refactor `SettingsView.AccountSection`** to render from registry. `profileVisibility` stays as a manual `VisibilityField` for now (its enum labels + descriptions are more bespoke than the generic renderer supports; add a richer enum renderer later).
5. **Rewrite the `⚙ Prefs` button handler** on top of the registry. Start matching `pref:*` alongside the existing `comm-pref:*` for one release; remove `comm-pref:*` after.
6. **Add `/swutrade settings`** slash command pointing at the same dispatcher.

Total scope: ~200 LOC added net (the registry + two renderers), ~150 LOC deleted (hand-written schemas + bespoke button handler).

---

## Open questions

- **Long-form enum descriptions** on web (`profileVisibility`'s current UI includes "Public — anyone with the URL" etc). The generic select renderer would drop these. Proposed answer: add `option.description`, and the renderer composes `label — description`. But that visual density might not fit Discord (buttons are short). Solution: Discord uses `label` only; web renderer concatenates. No extra def work.
- **Rate limits on Discord setting changes.** Users clicking through all 4 comm-pref options in a second is fine, but a bulk `/settings toggle-all` is not a thing we want. Proposed answer: no rate limit at registry level; per-interaction dedupe is implicit because each click is an ephemeral commit.
- **Per-guild settings.** Explicit non-goal for v1 — those live on `user_guild_memberships` and have fundamentally different cardinality (one row per guild). A future "per-scope registry" could extend this, but not worth designing for until we have a second multi-row preference.
