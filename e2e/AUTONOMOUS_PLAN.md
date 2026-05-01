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
- [x] A3: `e2e/helpers/session-seed.ts` Drizzle helpers (2aee40b · run 25204081829)
- [x] A4: CI auth-e2e sharded across 4 runners (c69c81d · run 25204239301) — each shard ~1-1.5 min
- [x] A5: SKIPPED — sharding alone is fast enough; within-shard parallelism risks StrictMode issues for marginal gain.

## Phase B — Ghost-only specs (broaden coverage)
- [x] B1: `session-edits.auth.spec.ts` — qty +/− regression + cross-side sync (b940368 · run 25204427148; race-fix 7e98efb · run 25204903857)
- [x] B2: `session-suggestions-extended.auth.spec.ts` (e701908 · run 25204903857)
- [ ] B2: `session-suggestions-extended.auth.spec.ts` — multi-card add/remove, swap, dismiss, card-lock UX, max-10, auto-merge
- [x] B3: `session-revert.auth.spec.ts` (f9f98c9 · run 25205061663)
- [x] B4: `session-chat.auth.spec.ts` (55c6766 + 2d0fb93 · run 25205427020 rerun)
- [x] B5: `session-mobile.auth.spec.ts` (4281f38 · run 25205985365)
- [x] B6: `session-cross-device.auth.spec.ts` — same Discord user across two browsers + ghost variant (ddbd1a5 + 2334705 · run 25206337925)

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
| 2026-04-30 22:42 | A3 seed helpers | 2aee40b | 25204081829 | ✅ green |
| 2026-04-30 22:51 | A4 CI sharding | c69c81d | 25204239301 | ✅ green (4 shards × ~1.5min) |
| 2026-04-30 22:58 | B1 session-edits | b940368 | 25204427148 | ✅ green |
| 2026-04-30 23:08 | B2 + B1 flake fix | 7e98efb | 25204903857 | ✅ green |
| 2026-04-30 23:14 | B3 session-revert | f9f98c9 | 25205061663 | ✅ green |
| 2026-05-01 00:02 | B4 session-chat + 429 filter | 2d0fb93 | 25205427020 (rerun) | ✅ green (1 infra cancel on shard 2 first run) |
| 2026-05-01 00:08 | B5 session-mobile | 4281f38 | 25205985365 | ✅ green |
| 2026-05-01 00:18 | B6 cross-device + helper fix | 2334705 | 25206337925 | ✅ green |
