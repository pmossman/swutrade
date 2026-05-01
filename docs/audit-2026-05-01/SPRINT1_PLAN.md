# Audit Sprint 1 — autonomous execution

Started: 2026-05-01
Branch: `beta`
Source: `docs/audit-2026-05-01/SYNTHESIS.md` (revised post-12-agent audit)

This doc is the resume document if compaction hits during execution.
Each milestone is one commit; one CI verification gates the next.

## Standing rules (same as the overnight run)

- Push only to `beta`. Never `main`. Never `--force`. Never skip hooks.
- One milestone = one commit = one CI verification.
- 3 consecutive CI fails on the same milestone → mark `[B]` BLOCKED.
  Skip to next non-dependent or stop.
- 3 BLOCKED milestones total → stop entirely.
- No `vercel --prod`. No drizzle migrations. No schema changes (defer to RFC).
- Type-checked + relevant-test-passing locally before push (`npx tsc -b --force`).
- Auto-push after commit so CI verifies.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done — annotate `(<sha> · run <id>)` · `[B]` blocked

## Milestones

- [x] **S1.1** — Delete dead code (daab55d · run 25225054981)
- [x] **S1.2** — `handleLogout` POST-only method gate (01194fd · run 25225372369)
- [~] **S1.3** — Clear OAuth `swu_oauth_state` + `swu_oauth_verifier` cookies on every error path in `handleCallback`
- [ ] **S1.4** — Replace `created as unknown as Item` with throw-on-null in `useWants.ts:155` + `useAvailable.ts:92`
- [ ] **S1.5** — `countUnreadEvents` → `COUNT(*)` query (regression: full-table SELECT every 2.5s poll)
- [ ] **S1.6** — `tradeActions.post` calls `apiPost`; delete duplicated `failure()` + `__mapFailureForTradeActions` re-export
- [ ] **S1.7** — Centralize `restrictionKey` + `normalizeRestriction`; normalize at server-pull boundary; align restriction-label divergence between editor / read-only / dedup-key
- [ ] **S1.8** — Mutation-race fix in `useGuildMemberships.updateGuild` (gen-counter ref + drop-stale-response in setState)
- [ ] **S1.9** — Mutation-race fix in `useAccountSettings.update` + `useCommunityMembers.setPeerPref` (shared `/me/prefs` shape)
- [ ] **S1.10** — Mutation-race fix in `useTradeDetail.nudge`; rename `mutationInFlightRef` → `pollPauseRef`; extract `withMutationLock` helper for the new race-aware shape
- [ ] **S1.11** — Replace `familyId.split('::')` parsing with map-lookup at 3 sites; fix CommunityView's lossy slug-titlecase fallback (user-visible: "Luke Skywalker (Hero of Yavin)" loses lowercase "of" + parens today)
- [ ] **S1.12** — Consolidate `extractVariant` (3 copies in `api/og.ts`, `api/search.ts`, `ShareLiveTradeButton.tsx`); 2 of them miss the canonical `Regional` regex so OG-image + share-link payloads currently render TCGPlayer collector-numbers as variant labels

## Run log

| When | Milestone | SHA | CI Run | Result |
|------|-----------|-----|--------|--------|
| — | — | — | — | starting S1.1 |

## Notes for the executor

- Most commits should be XS (<1hr). S1.7-S1.10 are S (1-3hr each).
- S1.10 is the biggest — it's the mutation-mutex rename + the `withMutationLock` extraction in addition to the race-fix. Save for after the others to avoid blocking on conceptual work.
- S1.8-S1.10 share a fix shape (gen-counter + drop-stale-response). Once we ship the first one, the others are mechanical applications of the same pattern.
- S1.11 has a user-visible bug attached (CommunityView title-casing) — verify the visible fix in a manual smoke after deploy.
- After all 12 land green: append a closing entry to `SYNTHESIS.md` summarizing what shipped, then move to Sprint 2 (foundational type safety) when parker green-lights.
