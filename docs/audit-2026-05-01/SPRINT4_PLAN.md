# Audit Sprint 4 — autonomous execution

Started: 2026-05-02 (after Sprint 3 closed)
Branch: `beta`
Source: `docs/audit-2026-05-01/SYNTHESIS.md` (Sprint 4 = UX primitive
consolidation: U1 + U2 + U3 + D3 + D4 + N15 + N16)

This doc is the resume document if compaction hits during execution.
Each milestone is one commit; one CI verification gates the next.

## Standing rules (same as Sprints 1–3)

- Push only to `beta`. Never `main`. Never `--force`. Never skip hooks.
- One milestone = one commit = one CI verification.
- 3 consecutive CI fails on the same milestone → mark `[B]` BLOCKED.
  Skip to next non-dependent or stop.
- 3 BLOCKED milestones total → stop entirely.
- No `vercel --prod`. No drizzle migrations. No schema changes (defer to RFC).
- Type-checked + relevant-test-passing locally before push (`npx tsc -b --force`).
- Auto-push after commit so CI verifies.
- Watch CI in background with `gh run watch <id> --exit-status`.
- Always `gh run list --limit 1` before pushing — never stack on a still-failing run.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done — annotate `(<sha> · run <id>)` · `[B]` blocked

## Milestones — foundational → mechanical → UI

Order chosen so cheap, low-risk dedup work clears first; the medium-risk
behavior-changing extractions come last.

- [x] **S4.1** — N15: `LoadingState` `inline` variant
      (d3426a5 · run 25246901896). 4 composer bars + ProfileView's
      centered case migrated.
- [x] **S4.2** — N16: `ErrorState` `variant: 'card' | 'line' | 'banner'`
      (43a424e · run 25247001225). 4 near-byte-identical sites folded
      onto `line`; SettingsView's `ErrorLine` (5 call sites + local
      component) folded onto `banner`.
- [x] **S4.3** — D4: single `relativeTime` helper
      (dba85be · run 25247094988). 5 reimplementations replaced; 30d
      threshold + NaN-safe.
- [x] **S4.4** — D3: adopt `formatPrice` everywhere
      (61e03d9 · run 25247203858). 13+ inline sites migrated;
      TradeBalance's local `formatDollars` deleted. SignalBuilderView
      `~$` estimate prefix + spread tooltips skipped per intent.
- [x] **S4.5** — U3: extract `ui/CardThumb` (f150bc8 · run 25247310567).
      TradeRow / ListRows RowShell / FamilyRow CardStack / TradeSummary
      tile migrated. CardTile already had its own landscape detection
      and a parent-coordinated `landscape` prop; left unchanged per
      the audit's "do not flatten coordinated cases."
- [x] **S4.6** — U1: extract `ui/QtyAdjuster` (fd7f1c9 · run 25247403088).
      Split + pill variants; emerald/blue/gold accents. Pill variant
      stops propagation by default since it always nests inside a
      clickable parent.
- [ ] **S4.7** — U2: Radix `Dialog.Root` migration for `NudgeDialog`,
      `HandlePickerDialog`, `TradeImageModal`. Free focus-trap +
      scroll-lock + ESC + `aria-modal`. Page-replacing overlays
      (`TradeSearchOverlay`, `SessionSuggestComposer`, `TradeSummary`)
      stay hand-rolled per the anti-rec.

## Run log

| When | Milestone | SHA | CI Run | Result |
|------|-----------|-----|--------|--------|
| — | — | — | — | starting S4.1 |

## Notes for the executor

- S4.1 + S4.2 are XS/S — knock out fast to set the primitive shape
  before any consumer migrations land elsewhere.
- S4.3 + S4.4 are mechanical sweeps; verify with smoke-test on Home
  (relative-time labels) and on a proposal review (price labels).
- S4.5 (CardThumb) is medium effort but low risk — one canonical
  helper, 6 consumer migrations.
- S4.6 (QtyAdjuster) is the trickiest UI change. Preserve the
  per-call-site aria-label conventions exactly; the audit spec at
  10-ux-primitives.md:39-42 is byte-precise about which sites say
  `'Remove'` vs `'Decrease quantity'` vs `'Decrease quantity of ${name}'`.
- S4.7 (Radix Dialog) is the highest-risk milestone — focus-trap
  behavior change. Verify each migrated dialog still:
  - opens and closes via the existing trigger
  - traps Tab inside the dialog
  - restores focus to the trigger on close
  - blocks page scroll while open
  - announces correctly via VoiceOver-style SR test (`role="dialog"`
    + `aria-labelledby`)
- After all 7 land green: append a closing entry to `SYNTHESIS.md`
  summarizing what shipped, then move to Sprint 5 (mid-size
  correctness) when parker green-lights.

## References

- `10-ux-primitives.md` — agent's UX-primitive sweep (this sprint's
  primary input).
- `12-empty-loading-error-states.md` — empty/loading/error deeper
  pass; drives S4.1 + S4.2.
- `14-domain-rendering.md` — domain-rendering audit; drives S4.3 +
  S4.4.
