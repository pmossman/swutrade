# Autonomous E2E Hardening — Working Plan

Started: 2026-04-30 evening
Branch: `beta`
Author: Claude (Opus 4.7) under standing autonomy authorization from parker

This document is read at the start of every iteration so progress
survives auto-compaction. Update it in the same commit as each
milestone — it IS the source of truth for "where are we."

## Standing rules
- Push only to `beta`. Never to `main`. Never `--force`. Never skip hooks.
- One milestone = one commit = one CI verification. Wait for green before the next milestone.
- 3 consecutive CI failures on the same milestone → mark `[B]` BLOCKED. Skip to next non-dependent milestone or stop.
- 3 BLOCKED milestones total → stop entirely.
- No `vercel --prod`. No drizzle migrations against shared DBs.
- Phase E (real Discord OAuth) is deferred — write a runbook only.
- All new e2e specs must follow anti-flakiness checklist (bottom of file).

## Status legend
- `[ ]` not started
- `[~]` in progress
- `[x]` done — annotate with `(<sha> · run <id>)`
- `[B]` blocked — annotate with reason

## Phase A — Infrastructure
- [x] A1: Shared `e2e/helpers/sessions.ts` library (e268beb · run 25203930211)
- [x] A2: SKIPPED — existing `signIn()` helper in `e2e/helpers/auth.ts` already mints sealed Discord cookies via iron-session, no new endpoint needed.
- [~] A3: `e2e/helpers/session-seed.ts` Drizzle helpers for direct DB seeding
- [ ] A4: CI auth-e2e sharded across 4 workers
- [ ] A5: Playwright workers raised in `playwright.auth.config.ts` (CI only)

## Phase B — Ghost-only specs (broaden coverage)
- [ ] B1: `session-edits.auth.spec.ts` — qty +/− (incl. hyphenated set slugs), remove, swap variant, empty side
- [ ] B2: `session-suggestions-extended.auth.spec.ts` — multi-card add/remove, swap, dismiss, card-lock UX, max-10, auto-merge
- [ ] B3: `session-revert.auth.spec.ts` — multiple candidates, dismiss, latest-state kebab hidden, satisfied auto-dismiss
- [ ] B4: `session-chat.auth.spec.ts` — rate limit, char limit, empty trim, mark-read on visibility, chat-only badge
- [ ] B5: `session-mobile.auth.spec.ts` — split-view toggle, iOS keyboard panel sizing, no-zoom on input
- [ ] B6: `session-cross-device.auth.spec.ts` — same ghost cookie in two contexts sees consistent state

## Phase C — Frozen-fixture regression (Tier 2)
- [ ] C1: `tests/e2e-fixtures/sessions/` library + Drizzle loader
- [ ] C2: 3 fixtures: pre-suggestions, pre-diff-payload, pre-snapshot-pairing
- [ ] C3: `session-frozen-fixtures.auth.spec.ts` — load each, render, edit, verify no console errors

## Phase D — Discord-identity specs (Tier 3a, uses `/api/test/auth-login`)
- [ ] D1: `session-discord-handles.auth.spec.ts` — sender-handle, @mention in chat
- [ ] D2: `session-discord-to-discord.auth.spec.ts` — full session between two Discord users
- [ ] D3: `session-anon-to-discord.auth.spec.ts` — anon claims session created by Discord user

## Phase E — Real Discord OAuth (DEFERRED — runbook only)
- [ ] E0: Write `e2e/DISCORD_OAUTH_RUNBOOK.md` with setup steps for parker. No code. Stop after writing.

## Anti-flakiness checklist (applied to every new spec)
- Each test creates its own session (no cross-test state)
- `expect(...).toBeVisible({ timeout: 8_000 })` for cross-side observations (covers 2.5s poll); 5s for in-page
- Zero `waitForTimeout` except where modeling polling cadence
- Random handle suffixes (`Date.now()` / `crypto.randomUUID().slice(0, 6)`) to avoid worker collisions
- `getByRole` + aria-label everywhere; `getByText` only as last resort
- Test-only CSS injection: `* { animation-duration: 0s !important; transition-duration: 0s !important }`
- Tour suppression: `localStorage.setItem('swu.tour.dismissedAt', 'suppressed-by-e2e')` in `addInitScript`
- Per-test cleanup in `finally` to close contexts even on failure
- Trace + video on first failure (already configured)
- 2 retries in CI, 0 locally

## Run log

(newest first — append after each iteration)

| When | Milestone | SHA | CI Run | Result |
|------|-----------|-----|--------|--------|
| 2026-04-30 22:35 | A1 helpers | e268beb | 25203930211 | ✅ green |
