# Audit Sprint 5 — autonomous execution

Started: 2026-05-02 (after Sprint 4 closed)
Branch: `beta`
Source: `docs/audit-2026-05-01/SYNTHESIS.md` (Sprint 5 = mid-size
correctness: M3 + M5 + N6 + N12 + N18 + N19)

This doc is the resume document if compaction hits during execution.
Each milestone is one commit; one CI verification gates the next.

## Standing rules (same as Sprints 1–4)

- Push only to `beta`. Never `main`. Never `--force`. Never skip hooks.
- One milestone = one commit = one CI verification.
- 3 consecutive CI fails on the same milestone → mark `[B]` BLOCKED.
- 3 BLOCKED milestones total → stop entirely.
- No `vercel --prod`. No drizzle migrations. No schema changes that
  require a DB migration. Adding a string-array enum value (M3's
  `'promoted'`) is type-only and ships safely.
- Type-checked + relevant-test-passing locally before push (`npx tsc -b --force`).
- Auto-push after commit so CI verifies.
- Watch CI in background with `gh run watch <id> --exit-status`.
- Always `gh run list --limit 1` before pushing — never stack on a still-failing run.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done — annotate `(<sha> · run <id>)` · `[B]` blocked

## Milestones — XS sweep → S behavior changes

Order chosen so cheap mechanical wins clear before the higher-risk
correctness fixes that require integration testing.

- [x] **S5.1** — N18: KebabMenu aria
      (a490a00 · run 25255171822). `open` threaded into trigger;
      `aria-haspopup="menu"` + `aria-expanded={open}` +
      `aria-controls={useId()}` matched to menu list id.
- [x] **S5.2** — N12: typed prefs-registry accessors
      (5dd1806 · run 25255269351). 5 sites in api/bot.ts + 2 in
      lib/prefsResolver.ts migrated. Cast confined to two consts at
      the top of prefsRegistry; helpers throw on unknown keys.
- [x] **S5.3** — N19: convert tile `<div role="button">` to `<button>`
      (02b4995 · run 25255381537). CardTile + FamilyRow migrated;
      manual onKeyDown removed. Nested QtyAdjuster pill is invalid
      HTML per spec but works in browsers; revisit if support shifts.
- [x] **S5.4** — N6: move signal-row resolvers to `lib/signalMatching`
      (ddbd28b · run 25255509604). 3 helpers moved; dynamic-import
      workaround dropped; api/signals.ts and api/bot.ts pass `db`
      explicitly to match findMatches contract.
- [x] **S5.5** — M5: `useServerSync` writingBackRef race
      (85edf19 · run 25255620001). Replaced flag with
      `serverWriteGenRef` + `lastSeenWriteGenRef` gen-counter pair;
      items-changed effect now correctly distinguishes writeback
      from real local edit.
- [x] **S5.6** — M3: `promote-to-shared` race-guard + `'promoted'`
      status (d636026 · run 25255786207). Status + event-type enums
      gain `'promoted'`; UPDATE returns rows for race detection;
      cyan StatusBadge variant + frontend branches added across 9
      sites.

## Sprint 5 complete — 6/6 milestones shipped

The mid-size correctness cluster is live on beta. Summary:
- **N18** — KebabMenu trigger gains aria-haspopup / aria-expanded
  / aria-controls. SR users now hear menu disclosure state.
- **N12** — `getUserPrefColumn` / `getPeerPrefColumn` typed
  accessors. 5 sites in api/bot.ts + 2 in lib/prefsResolver.ts
  migrated; the dynamic-cast escape hatch is now confined to two
  module-level constants.
- **N19** — CardTile + FamilyRow tiles converted from
  `<div role="button">` to `<button>`. Hand-rolled onKeyDown
  handlers removed; browser handles Enter/Space.
- **N6** — `resolveSignalFamily` / `resolveSignalVariantSpec` /
  `resolveSignalCardsBatch` moved to `lib/signalMatching.ts`.
  Dynamic-import workaround dropped; api/* call sites pass `db`
  explicitly to match the existing findMatches contract.
- **M5** — useServerSync's writingBackRef synchronous-clear race
  replaced with a gen-counter pair. Items-changed effect now
  correctly distinguishes a server writeback from a real local
  edit; spurious-PUT-after-every-foreground-pull regression closed.
- **M3** — promote-to-shared race-guard + new `'promoted'` status.
  Misclassification of promoted proposals as 'countered' fixed;
  optimistic-concurrency check via .returning() rolls back the
  session insert when the proposal raced off `pending`.

Next: Sprint 6 (the big splits — H9 sessions, H10 bot, H11 trades,
H12 SessionView, H13 TradeBuilderContext) when parker green-lights.

## Run log

| When | Milestone | SHA | CI Run | Result |
|------|-----------|-----|--------|--------|
| — | — | — | — | starting S5.1 |

## Notes for the executor

- S5.1, S5.2, S5.3 are XS each — knock them out fast.
- S5.4 is mostly mechanical (move helpers + drop dynamic imports);
  the tricky part is the bot.ts and signals.ts still need to import
  the moved helpers. Verify with the existing 26-test signals suite.
- S5.5 is the trickiest of the cheap-S milestones. The audit's
  proposed fix is `queueMicrotask` or a generation-counter ref. Pick
  whichever lands the cleanest test surface — Sprint 1's gen-counter
  pattern (useGuildMemberships.updateGuild) is the documented
  precedent, so probably that.
- S5.6 needs a status enum addition + frontend rendering paths +
  event type addition. It's the most surface-touching milestone.
  StatusBadge has its own handling; TradesHistoryView's status
  filtering needs an explicit `'promoted'` case; useTradeDetail's
  TradeStatus union picks up the new value. Build error per missing
  exhaustive case is a feature here — it'll list every site that
  needs an update.
- After all 6 land green: append a closing entry to `SYNTHESIS.md`
  summarizing what shipped, then move to Sprint 6 (the big splits)
  when parker green-lights.

## References

- `02-trades.md` — drives S5.6.
- `06-lists.md` — drives S5.5.
- `03-discord.md` — drives S5.2 + S5.4.
- `11-accessibility.md` — drives S5.1 + S5.3.
