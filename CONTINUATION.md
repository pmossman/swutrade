# Continuation — fresh session bootstrap

Last updated: 2026-04-17. Keep this current at any hand-off point.

## Where we are

Phase 4c fully shipped on the `beta` branch. The trade proposal
lifecycle is end-to-end live: compose → bot DM with Accept / Counter
/ Decline → button interactions edit the DM in place + notify the
proposer → history + detail views for both parties → proposer can
cancel pending. Community directory, counter chains, delivery-
failure handling, optional proposer notes — all shipped with
integration + e2e coverage.

**Status:** CI green, ~282 vitest tests + ~30 Playwright specs, beta
production-live at `beta.swutrade.com`. Main is unchanged from the
last promotion; beta is ahead and ready for dogfooding but not yet
promoted.

**Workflow:** push directly to `beta`, no PRs. Pre-commit hook runs
`tsc -b --force`. CI runs on every push (types + tests + build,
anonymous e2e, Vercel deploy wait, authenticated e2e against the
preview URL). Promotion to main is manual when the user says so.

## Where the docs are

Read these in order for a fresh session:

1. **`NEXT.md`** — sequenced work queue. The literal next slice to
   build, with per-slice gate criteria. **Start here.**
2. **`ROADMAP.md`** — long-term vision + phase breakdown +
   append-only design-decisions log.
3. **`CODE_REVIEW_2026_04_17.md`** — post-Phase-4c architectural
   review. Critical / architectural / polish findings.
4. **`UX_REVIEW_2026_04_17.md`** — UX review of every major flow.
   Critical / core friction / polish findings.
5. **`PHASE4_TESTING.md`** — three-tier test strategy + Tier 3
   manual runbook.
6. **`PHASE4C_COUNTER_DESIGN.md`** — counter-flow architecture
   (mostly implemented; lives on as reference for chain viz +
   expiry follow-ups).

## What's actually next

See `NEXT.md` — top of the Queue is "Security + correctness
quickies" (Ed25519 timestamp window, test-key env gate, counter-
cleanup logging). Then DB indexes, then a11y foundation, then the
design-system primitives extraction, then copy fixes, then test
dedup. Each slice has explicit done-when boxes.

Foundation + polish bundle derives from the two review docs. It
does NOT add new user-visible features — it's the quality-
investment pass before Phase 4 v2 (LGS directory, visits) or the
rest of Phase 5 (expiry, reputation, completion flow).

## Stack facts

- Vite 8 + React 19 SPA, dark "space" palette + gold accents
- Vercel serverless functions (Fluid Compute), Hobby plan (12-fn
  ceiling; currently 10 functions)
- Neon Postgres via Drizzle ORM, migrations in `drizzle/`
- iron-session encrypted cookies for auth
- Arctic library for Discord OAuth
- Bot: HTTP Interactions + Event Webhooks (no gateway). Signed
  payloads verified via Ed25519 (node:crypto) with a dual-key
  fallback for the synthetic-interaction e2e
- Playwright for e2e; vitest for unit + integration. Auth e2e
  runs on a single worker to avoid React StrictMode + parallel
  worker DB contention (see PHASE4_TESTING.md for why)

## Key schema surfaces

- `users`, `wants_items`, `available_items` — Phase 1/2
- `trades` (distinct from `trade_proposals`) — personal "save a
  trade" snapshots from Phase 2, single-user
- `user_guild_memberships`, `bot_installed_guilds` — Phase 4a/4b
- `trade_proposals` (13 columns) — Phase 4c proposal lifecycle,
  with `counter_of_id` self-FK for chains, `delivery_status` as a
  second axis distinct from `status`

## Sensitive workflow rules

- **Check prior CI before every push** — `gh run list --limit 1`.
  If red, fix that before stacking new commits. (Saved as memory
  entry `feedback_check_prior_ci`.)
- **`tsc -b --force` not `tsc --noEmit`** — CI is strict and the
  weak local check has leaked errors to CI twice. Pre-commit hook
  enforces this.
- **Don't auto-deploy** — user controls when to promote beta →
  main. Never run `vercel --prod` between cron cycles.
- **Env vars with newlines** — use `printf`, not `echo`, when
  piping into `vercel env add`.

## Live Discord integration

The dev Discord app (SWUTrade Dev) is installed in the user's test
server. Beta is the interactions + events endpoint. Real users:
currently just the developer; no production users yet. The Tier 2
nightly contract probe is deferred until there's real traffic
worth monitoring.

## Recent shipped slices (commit refs in NEXT.md Done section)

- Slice 5: trade history + detail + cancel (`5f944dc`)
- Slice 4: counter flow (`0a8e759`)
- Slice 3: Discord DM + Accept/Decline (`aaf8894`)
- Slice 2: propose composer + backend (`fd5efa7`, `531ad3c`)
- Slice 1: community directory (`5cd743e`)
- Phase 4b general guild refresh + settings UX cleanup (`120924f`)

All detail + commit hashes in NEXT.md Done. ROADMAP.md has the
design-decision log for anything architectural.
