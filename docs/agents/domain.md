# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root (created lazily by `/grill-with-docs` as terms get resolved).
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.
- **`docs/wiki/`** — the existing 10-page area wiki. `docs/wiki/architecture.md` is the cross-cutting overview; pages `a-sessions.md` through `k-signals.md` are area deep-dives. Use as the deep-dive source when `CONTEXT.md`'s glossary points you at an area.

If `CONTEXT.md` or `docs/adr/` don't exist yet, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md                       ← lazy; created by /grill-with-docs
├── docs/
│   ├── adr/                         ← lazy; created when a decision lands
│   └── wiki/                        ← already present; area deep-dives
└── src/, api/, lib/                 ← the code
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md` or `docs/wiki/`. Don't drift to synonyms the glossary explicitly avoids.

Domain primitives already documented in `docs/wiki/architecture.md`: **Card**, **CardVariant**, **familyId**, **User** (real or ghost), **WantsItem**, **AvailableItem**, **Session**, **signal**. The colour reservations (emerald / blue / cyan / gold / amber / crimson / red / purple) are load-bearing — don't repurpose.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
