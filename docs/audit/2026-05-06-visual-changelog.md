# Visual changelog — 2026-05-06 overnight audit

> Every commit from this session that changes user-visible UX gets an entry below.
> Designed for morning skim: pick which to keep, which to revert.
> Companion file: [`2026-05-06-tech-debt.md`](./2026-05-06-tech-debt.md)

## How to revert

- Single change: `git revert <SHA>`
- Bundle of related changes: see "To revert" line on each entry — sometimes a partial revert is cleaner than `git revert`
- Revert and push: `git revert <SHA> && git push origin beta`

---

## Changes

### `f5150db` — In-app `<ConfirmDialog>` replaces 5 `window.confirm` calls
**Surface(s):**
- Suggest composer (Cancel with staged cards): "Discard this suggestion?"
- Signal builder (Cancel with dirty draft): "Discard this draft?"
- Session view: "Cancel this shared trade?"
- Session view: "Decline this trade?"
- Mobile actions kebab: "Clear all cards?"

**What changed (before → after):** Previously: native OS `window.confirm()` modal — appearance varies per browser, no SWUTrade chrome, no destructive-action visual cue. Now: in-app Radix Dialog with title + body paragraph + Cancel/Confirm buttons. Destructive actions (discard, cancel trade, decline, clear all) get a crimson Confirm button; non-destructive actions get the gold treatment. ESC and overlay-click cancel; focus management + restore handled by Radix.
**Why:** Audit MP-5: three different confirmation patterns coexisted (`window.confirm`, two-tap-confirm, ad-hoc dialogs). Standardising the cross-cutting destructive case onto one primitive. Two-tap-confirm stays for in-row destructives (`<RemoveButton>`, `<ClearAllButton>`).
**Files touched:** `src/components/ui/ConfirmDialog.tsx` (new), `src/main.tsx` (provider mount), `src/components/SessionSuggestComposer.tsx`, `src/components/SignalBuilderView.tsx`, `src/components/SessionView.tsx`, `src/components/MobileActionsKebab.tsx`.
**Screenshots / how to see it:** Open a shared session with cards → tap Cancel → in-app modal. Compose a signal with cards → tap Cancel → in-app modal. Same for the other three flows.
**To revert:** `git revert f5150db`. Note: this re-introduces 5 `window.confirm` calls; if you want to keep the new dialog for some surfaces and not others, do partial reverts per file.

### `711031a` — `<SuccessState>` primitive; ReportProblemDialog success card uses it
**Surface(s):** the green "Thanks — your report was sent." card after submitting a feedback report.
**What changed (before → after):** Visual is byte-identical (same emerald-500/30 border, same emerald-500/5 background, same text-[11px] text-emerald-200, same role="status"). The hand-rolled JSX is now `<SuccessState variant="line">`.
**Why:** Symmetric with the existing ErrorState; convergence target for future transient-success surfaces. Audit F-C10.
**Files touched:** `src/components/ui/states.tsx` (added primitive), `src/components/ReportProblemDialog.tsx` (refactor).
**Screenshots / how to see it:** Help menu → "Report a problem" → submit any message → green success card appears.
**To revert:** `git revert 711031a`

### `1cfe3e1` — NumberStepper +/− 44×44 hit area
**Surface(s):** every list row's qty editor, trade-side qty editors, signal-builder qty + max-price.
**What changed (before → after):** Visual stays identical (24×24 / 20×20 buttons). Touch target on mobile now expands to a centred 44×44 transparent box via `hit-area-44` pseudo-element (already used elsewhere). Desktop unchanged (the visual stays the click target).
**Why:** WCAG 2.1 Target Size minimum; mistaps on mobile qty editors flagged in audit F-J1.
**Files touched:** `src/components/ui/NumberStepper.tsx`.
**Screenshots / how to see it:** mobile view of the wishlist drawer (any qty stepper). The visual button is unchanged; the tap area extends invisibly outwards.
**To revert:** `git revert 1cfe3e1`



<!--
Template for entries:

### `{SHA}` — {short title}
**Surface(s):** {URL paths or component names}
**What changed (before → after):** {1-3 sentences describing the visible change}
**Why:** {what user-facing inconsistency this addresses}
**Files touched:** {comma-separated list}
**Screenshots / how to see it:** {URL path or "open the X dialog from Y"}
**To revert:** `git revert {SHA}` _(or specific instructions if part of a bundle)_

-->
