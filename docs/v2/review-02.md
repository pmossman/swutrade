# Review of `docs/v2/design.md` — round 2 (approval + nits)

Reviewer: user (with independent oversight from another agent). Round 1 revisions (R1–R6 in `review-01.md`) all landed cleanly.

## Verdict

**Approved.** Proceed to Phase 1 implementation after fixing the two mechanical nits below (N1, N2). No round 3 review gate.

## What landed well

- **R1 (solo→live race)** — eager server-creation, explicit offline-start trade-off, no 404 window. Clean.
- **R2 (pricing)** — `§4.3.1` tap-to-expand `PriceSheet` is the most thoughtful addition in the revision. Balance strip stays scannable; full pricing one tap away; missing prices get a loud visual (danger bar + exclude action) instead of silently contributing $0; spread warnings in sheet only (diagnostic, not first-order). Persistence semantics match v1. Exactly the right Apple-minimal pattern for a load-bearing feature.
- **R3** — `§5.3` and `§7.5` now agree. Zustand for UI-only singletons (dismissed banners, toast queue, tab scroll memory, onboarding-seen flags). Rationale against alternatives is concrete.
- **R4** — `§10.5` is operational, not aspirational: DNS swap, warm v1 project for 90 days, 5-min rollback ETA, no-data-rollback-story because no schema breakage. Runbook flagged for Phase 4.
- **R5** — all three walk-backs landed in Phase 2 with honest defending paragraphs. Edit-in-place pencil affordance, `/list?w=&a=` route, bulk multi-select via long-press. Each names the v1 incident or UX reason the original kill was wrong.
- **R6** — `§7.10` accessibility is the unexpected win. WCAG AA contrast audit as a Phase 1 unit test that parses CSS custom properties and asserts per-pair ratios makes the palette lock in compliance by construction. That's better than "audit once at launch and hope."

## Nits (fix before starting implementation)

### N1. Missing `§4.4 Card picker` heading

Inserting `§4.3.1 Pricing on the canvas` dropped the header for `§4.4`. Design-doc lines ~258–279 describe the Card picker (purpose, sketch, scope chips) but have no section heading above them — they read as continuation of §4.3.1, which breaks the section numbering through §4.12.

**Fix**: add `### 4.4. Card picker (bottom sheet, full-height)` before the `**Purpose**: find a card, add it. Nothing else.` line. Nothing else in §4.4 needs to change.

### N2. State-tones table says "(5)" but lists six rows

`§6.1` → "State tones (5) — for trade-state badges" header, but the table has six rows: `state-shared`, `state-attention`, `state-settled`, `state-declined`, `state-countered`, `state-neutral`.

**Fix**: update the header to "(6)".

## Observations (not blockers — address in implementation)

1. **`§7.10` segmented-control height** flagged as "40px, under baseline, considering bumping to 44". Just commit to 44. Accessibility minimums aren't a decision to defer to implementation-time; they're a design-doc lock-in.

2. **J1 tap count math** — "3 (Alice) + 1 (Bob)" is off by one for Alice (opening the app isn't a tap; the sheet slides up automatically after FAB). Actual: 2 Alice + 1 Bob. Minor; fix in passing if you revise, otherwise leave.

3. **`R1` offline-start trade-off** — "Tapping the FAB requires a network call." Document what happens when `POST /api/sessions/create-open` fails (bad cell at an LGS is the canonical case): retry affordance? Inline error + hold-for-offline queue? Fold into sub-phase **1d** exit criteria so implementation doesn't improvise a pattern.

4. **Phase 2 scope is packed** (10 items: community directory, settings, profile editing, ghost-merge banner, counter-offer, suggest-a-trade, Web Push, edit-in-place, `/list` URLs, bulk decline). Per the one-arc direction this is fine, but flag it in `progress.md` at Phase 2 kickoff rather than discovering mid-stream that it's a second MVP's worth of work.

## Next step

1. Fix **N1** and **N2** in `docs/v2/design.md`.
2. Optionally address observations 1–3 (commit to 44px, document FCreate-open failure, flag Phase 2 density).
3. Post a one-line confirmation in `docs/v2/progress.md` naming the nits fixed.
4. Commit as `docs(v2): nits from review-02`.
5. Then begin Phase 1 implementation as one continuous arc — the seven sub-phases from `§10` are your work plan, not review gates. Post progress updates in `progress.md` asynchronously. I'll check in without you stopping.

No further design doc review required unless implementation surfaces a design-invalidating issue.

Begin when ready.
