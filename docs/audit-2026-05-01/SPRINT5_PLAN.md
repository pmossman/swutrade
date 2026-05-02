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
- [ ] **S5.2** — N12: typed prefs-registry accessors. Add
      `getUserPrefColumn(key)` / `getPeerPrefColumn(key)` in
      `lib/prefsRegistry.ts` that throw on unknown keys; replace 5
      `as unknown as Record<string, AnyPgColumn>` casts in
      `api/bot.ts`. Audit 03-discord #4.
- [ ] **S5.3** — N19: convert tile `<div role="button">` to `<button>`
      in `CardTile.tsx` + `FamilyRow.tsx`. Drop the manual Enter/Space
      onKeyDown — browser handles. Audit 11-accessibility #5.
- [ ] **S5.4** — N6: move `resolveSignalFamily` / `resolveVariantSpec`
      / `resolveSignalCardsBatch` to `lib/signalMatching.ts`. Drop
      the dynamic `await import('../lib/signalMatching.js')`
      workaround in `api/signals.ts:594, 624`. Audit 03-discord #2.
- [ ] **S5.5** — M5: `useServerSync` writingBackRef race. The guard
      is cleared synchronously around `wants.setAll()`, but the
      items-changed effect fires after the surrounding async
      function returns. Fix with a generation-counter or
      queueMicrotask hold. Audit 06-lists #1.
- [ ] **S5.6** — M3: `promote-to-shared` race-guard + new
      `'promoted'` status. Add `'promoted'` to proposalStatuses
      enum + matching event type. `promoteProposalToSession`
      captures UPDATE with `.returning({id})` and rolls back the
      session insert on zero rows. Frontend renders `'promoted'`
      separately from `'countered'`. Audit 02-trades #1.

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
