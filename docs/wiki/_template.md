# <Area name>

> **Owner scope**: list every file this page covers (bulletized if long). A future agent reads *this section first* to know if they're on the right page.

## Overview

2–4 sentences. What does this subsystem do? How does it fit in the whole app? What's the ONE sentence you'd give a new teammate?

## Key concepts / glossary

Domain terms readers will hit. Be concrete — not "user preferences" but "prefs registry (lib/prefsRegistry.ts) — typed schema with scope={self,peer,guild} that drives Settings UI and proposal DM ⚙ Prefs button."

- **Term** — one-line definition, with `file:line` pointer when helpful.

## File map

Every file in the area, grouped logically. One line per file — what it does, not its exports.

**`path/to/file.ts`** — Short description. Anchors the subsystem / is the primary state / etc.

## Data model

Shapes that flow through this area. Include:
- Schema tables owned by this area (or "reads X from area Y")
- TypeScript types with non-obvious invariants
- Cache shapes / storage keys
- Any normalization layer between storage and render shapes

Non-obvious invariants get called out explicitly (e.g., "`user_a_id < user_b_id` canonical ordering", "`is_anonymous=true` implies `discord_id IS NULL`").

## Public surface

What this area exposes to the rest of the app. Organize by kind:

### Exports
- `functionName(args) → Return` — one-line description. Cite call sites if non-obvious.

### Endpoints
- `GET /api/...` — what it returns, auth requirement.
- `POST /api/...` — body shape, success + error cases.

### Hooks / components (frontend areas)
- `useX()` — what state it owns, what it re-fetches, optimistic-update behavior.
- `<Y />` — where it mounts, what props it requires.

## State + data flow

Narrate the happy path and one or two edge cases. Where does state originate? What mutates it? Where are the optimistic updates, the polls, the mutex locks? Where does cache invalidation happen?

If the flow has side effects across primitives (e.g., proposal → session promotion), diagram it in prose or ASCII. Drop the ceremony — just enough to be understood.

## UI/UX patterns

Frontend areas: accent colors (emerald/blue/cyan/gold), layout rules, state badges, empty states, mobile-vs-desktop adaptations. If backend-only: skip this section.

## Tech debt + known gaps

Things that are fragile, incomplete, or deliberately deferred. Cite `file:line` and say why. Examples: "`@ts-expect-error` on X because Y", "polling cadence hardcoded at 2500ms, should be env-tunable", "no coverage for edge-case Z".

Don't hide problems here — this section is the map that tells future readers where to look when they hit weirdness.

## Decisions worth remembering

Why X not Y. These are the judgment calls that aren't in the code. Cite commits / ROADMAP / NEXT when useful.

- **Decision X over Y** — context, trade-off, why X won.

## Cross-references

Adjacent areas this one touches. Link by wiki path.

- [`g-auth.md`](./g-auth.md) — for the ghost-user merge we depend on.
- [`b-proposals.md`](./b-proposals.md) — for the promote-to-session surface.

---

## Guidelines for the author

Delete this section in the final doc. These are rules for whoever writes this page:

1. **500–1500 lines target.** Thin docs don't pay back the read-time; 3000-line docs nobody reads. Aim to inform, not to catalog.
2. **Read every assigned file.** If a behavior exists, it's your job to know it. Skim tests to find invariants the implementation alone doesn't reveal.
3. **Write for a reader who has NOT read the code.** Assume they can `cd` and open a file you cite, but start cold. Jargon is fine if defined in the glossary.
4. **WHY over WHAT.** Code explains what happens; docs explain why *this* approach, what the alternatives were, and what's fragile.
5. **No code rewrites.** You're documenting, not refactoring. If you find a bug, note it in Tech Debt — don't fix it.
6. **Cite file:line.** Makes pointers click-through in GitHub's rendered view.
7. **Honesty > polish.** Tech debt, gotchas, and half-finished flows get *named*. This doc's value is making invisible things visible.
