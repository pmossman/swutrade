# SWUTrade Wiki

Reference documentation for the SWUTrade codebase — one page per subsystem. Written so a human or an agent can land on any area cold and understand how it works without reading every file.

## How to use this wiki

- Working on a feature → read the area page for the subsystem you're touching.
- Unsure which area something lives in → check the **File map** section of each area page; every file in `src/`, `api/`, `lib/` is claimed by exactly one area doc.
- Need the big picture → **[`architecture.md`](./architecture.md)** — system topology, state model, data-flow patterns, cross-cutting decisions. Read this when a question crosses more than one subsystem.
- Found something out of date → update the area page in the same PR that changed the code. Stale docs are worse than no docs.

## Area index

| # | Page | What it covers |
|---|------|------|
| A | [Trade sessions (live/shared)](./a-sessions.md) | `/s/:id` canvas, QR handoff, session primitives, session ↔ open-slot invite, ghost users as session participants |
| B | [Proposals lifecycle](./b-proposals.md) | Async Discord-DM trade proposals, accept/decline/counter/edit/nudge/cancel, proposal → session promotion |
| C | [Trade builder + balance](./c-trade-builder.md) | Two-panel calculator, URL codec, auto-balance, matchmaking composer bars, forceBalance |
| D | [Lists / inventory / matching](./d-lists.md) | Wants + available, drawer, priority stars, popular-wants, shared-list URLs, match math, filters |
| E | [Home, navigation, routing, contexts](./e-home-nav.md) | HomeView, AppHeader/Breadcrumbs/NavMenu/AccountMenu, view router, global contexts |
| F | [Community / profile / settings](./f-community-profile.md) | Per-guild community pages, profile views, drill-down settings hub, handle picker |
| G | [Auth + identity (incl. ghost users)](./g-auth.md) | Discord OAuth, iron-session cookies, ghost → real user merge, auth guards |
| H | [Card data + pricing](./h-cards-pricing.md) | Card index, variants/enrichment, TCGPlayer prices, price refresh cron, pricing context |
| I | [Discord bot + webhooks](./i-discord-bot.md) | Bot client, signature verification, slash commands, interaction handler, prefs registry, error reporter |
| J | [Infra — build, deploy, CI, testing](./j-infra.md) | Vercel function topology, vercel.json rewrites, CI pipeline, vitest + playwright config, migrations |

## Conventions

- **"Why not what"** — docs explain non-obvious invariants, trade-offs, and history. Self-evident code (e.g., `saveWants()` persists wants) isn't documented.
- **Tech debt is named** — each page has a **Tech debt + known gaps** section. Real limitations get cited, not hidden.
- **File citations** use `path/to/file.ts:LINE` so readers can jump directly.
- **Cross-references** at the bottom of each page link to adjacent areas.

## Staleness guard

When you ship a non-trivial change, update the affected wiki page(s) in the same commit. The index above lists which page owns what. If you're not sure which page, grep for the filename in `docs/wiki/` — the page that references it is the owner.
