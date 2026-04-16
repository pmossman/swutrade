# Continuation — Feature development session

## Where we are

Phase 1 (foundation) and Phase 2 (accounts + sync) are complete on the `beta` branch. Phase 3a (matchmaker) is also done. Beta is ~36 commits ahead of main. CI is green (177 vitest + 30 Playwright e2e).

All code lives on `beta`. Push directly to beta for feature work — no PRs. When ready, promote to main with a tag.

## What to build next

Pick from any of these — ask me which I'd like to tackle:

### Phase 3b — Sender context in trade links
Trade links gain `?from=<handle>`. Recipient sees "What @handle wants" as a source chip. Signed-in recipient sees cross-referenced matches. See ROADMAP.md Phase 3 section.

### Delight features (independent, ship anytime)
- **Popular wants badges** — "3 people want this" on available cards. One-directional matching: query public wants that overlap with the user's available list. Compelling reason to sign in. No new tables — aggregate query on `wants_items`. See ROADMAP.md "Matchmaking preview" section.
- **Price movers** — biggest gainers/losers this week. Needs `price_snapshots` table + cron infra. See ROADMAP.md "Price movers + history" section.
- **Collection value tracker** — sum available list's market value. "Your collection: $247 (+$12 this week)." Builds on price snapshot infra.

### Phase 4 — Discord community layer
- Guild-scoped discovery ("cards from people in your servers")
- Discord bot (HTTP Interactions on Vercel Functions)
- LGS tags for local trading

### Phase 5 — Trading network
- Trade proposals (send to @user, frozen price snapshot)
- Counter-offers + negotiation threading
- Auto-update lists on completion
- Trader relationships + trust signals

## Key context for the new session

1. Read `ROADMAP.md` for full vision + design decisions log
2. Read `lib/schema.ts` for DB schema (4 tables: users, wants_items, available_items, trades)
3. Read `src/hooks/useServerSync.ts` for sync architecture
4. Read `src/utils/matchmaker.ts` for the greedy balancing algorithm
5. Stack: Vite 8 + React 19 SPA, Vercel API functions, Neon Postgres, Discord OAuth, Playwright e2e
6. Memory files have env var gotchas, deploy model, palette rules, CI pipeline details
