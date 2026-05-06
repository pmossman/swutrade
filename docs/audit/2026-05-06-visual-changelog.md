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
