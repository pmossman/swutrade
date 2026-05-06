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

_(none yet — populated as commits land)_

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
