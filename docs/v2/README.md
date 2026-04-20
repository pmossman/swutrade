# SWUTrade v2 workspace

This directory is where the v2 rewrite effort lives.

## For the agent doing the rewrite

Read **[`brief.md`](./brief.md)** first. It is self-contained — you need no other context to start.

## For humans reviewing the work

Expected artifacts as the rewrite progresses:

- **`brief.md`** — the mission + constraints + deliverables spec. Do not edit without explicit reason; the agent reads this as its source of truth.
- **`design.md`** — the Phase 1 deliverable. Full design document. This is the review gate before any implementation begins.
- **`changelog.md`** — per-phase log of what shipped. One entry per implementation phase.
- **`progress.md`** — running log + open questions for the human. Lighter weight than changelog.

## Branch model

- v2 work lives on the **`v2`** branch, forked from `beta`.
- New code lives in **`app-v2/`** at the repo root.
- The existing app (`src/`, `api/`, `lib/`) continues to serve at `beta.swutrade.com` unchanged.
- The v2 app deploys to a separate Vercel project at `next.swutrade.com` (user provisions when Phase 2 starts).

## Review flow

1. Agent produces `design.md` → STOPS.
2. User reads + reviews. Optionally asks for a red-team critique from another agent before approving.
3. User tells the v2 agent to proceed.
4. Agent ships Phase 1 → STOPS.
5. User reviews the phase + tells the agent to proceed or iterate.
6. Repeat through remaining phases.

At no point should the v2 agent merge into `beta` or `main`. That is a human decision, made after v2 is feature-complete.
