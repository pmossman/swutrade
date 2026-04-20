# SWUTrade v2 — Progress

Running log + open questions for the human. Lighter weight than `changelog.md`; this is where async status updates land between review gates.

---

## 2026-04-20 — Design round 1 revised

Applied all six revisions from `docs/v2/review-01.md` to `docs/v2/design.md`. R1 resolved by picking eager server-session creation on FAB-tap (§3 J3, §5.2) — no client-only draft state, no 404 race on early-scanned QR. R2 added a full `§4.3.1 Pricing on the canvas` covering the tap-to-expand PriceSheet with market/low toggle, percentage presets, per-card price breakdown, missing-price handling (danger left-bar + inline chip + exclude-from-total action), and spread-warning Δ% pills. R3 resolved the Zustand contradiction — allowed for UI-only singletons, rationale added in §7.5. R4 added `§10.5 Cutover plan` covering URL compatibility (DNS swap, old shared-list redirects), in-flight state (server rows survive, client drafts don't), beta-tester rollout, and DNS-rollback fallback. R5 walked back all three kills the reviewer pushed on (edit-in-place, shared-list URLs, bulk multi-select decline) into Phase 2 with explicit defending paragraphs. R6 closed five minor gaps (new §7.10 accessibility, v1 test disposition in §7.8, state-tone palette split in §6.1, ghost-user state on Cards tabs §4.5/§4.6, priority-star visible affordance §4.6). Folded reviewer answers to all six open questions into the doc body and removed the appendix. Scope note in §10 now treats Phase 1's seven sub-phases as one implementation arc with no user-review gate between them. Appended a `Revisions — round 1` section at the bottom of `design.md` listing every change with section references. Stopping here per the brief — no implementation code until round-2 approval.

## 2026-04-20 — Review-02 nits fixed

Fixed N1 (missing `§4.4 Card picker` heading) and N2 (state-tones "(5)" → "(6)"). Folded all three optional observations in passing: Obs 1 locked segmented-control height at 44px in §7.10 (accessibility floors are design-time locks, not implementation-time negotiations); Obs 2 fixed the J1 tap-count math (2 Alice + 1 Bob); Obs 3 documented `POST /api/sessions/create-open` failure handling in sub-phase 1d exit criteria (inline Retry affordance, no offline-queue, Playwright coverage) and flagged Phase 2's ten-item density in §10 so it gets re-scoped at kickoff. Approved. Beginning Phase 1 implementation as one continuous arc — seven sub-phases are the work plan, not review gates.
