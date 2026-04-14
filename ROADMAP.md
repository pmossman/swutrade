# Roadmap

Living document: long-term vision, phased plan, design decisions, and parked ideas. Not commitments — just so we don't lose them.

---

## Vision

SWUTrade began as a trade balancer — two parties, two sides, price math. The next horizon is making it a **trading hub**: users curate what they want and have, trades pull from personal and social sources, and a Discord community layer turns individual lists into matchmaking.

Three invariants we protect through all of this:

1. **Anonymous mode stays first-class.** The core trade calculator works without an account, forever. Accounts are strictly additive — cloud sync and community features. A new player should be able to use the site for the first time, balance a trade, and share the link, all without signing in.
2. **The trade window is the center of gravity.** Lists, shared links, Discord matches — all of it feeds cards INTO the trade. The trade UI is the destination, not the side feature.
3. **Variant semantics are asymmetric.** Wants are predicates (`any` / specific variants). Available is concrete (exact productId). Matchmaking only works if we honor this everywhere.

---

## Phases

### Phase 1 — Personal lists + anonymous sharing *(in progress)*

Local-first wants and available lists. Anonymous URL-encoded sharing is a complete feature on its own — accounts (Phase 2) layer persistence and identity on top, they don't gate the core sharing UX.

**Shipped:**
- [x] Data model + Zod persistence (`swu.wants.v2`, `swu.available.v1`)
- [x] Lists drawer shell (Radix Dialog + Tabs)
- [x] List rows with qty, priority toggle (wants), delete
- [x] Embedded card picker for adding items (reuses `CardSearchBrowser`)
- [x] Inline variant restriction editor
- [x] swuapi.com enrichment at build time (`baseCardId`, `cardType`, aspects, traits)
- [x] Cross-printing family-id so "any variant" wants match Standard / Hyperspace / Showcase
- [x] Empty-state integration in trade search (with shared-link sender-list section)
- [x] URL encoding (`?w=…&a=…`) — anonymous, copy-link sharing
- [x] Phase-3-style "From the shared link" section in recipient's empty state
- [x] Quantity-aware to-do semantics (rows count down as cards get added to trade)

**Open — anonymous list-sharing polish:**
- [ ] **Landing banner on shared link** — recipient lands and sees a dismissible "Someone shared their lists with you" notice rather than having to discover it inside the add-card overlay.
- [ ] **OG image for shared lists** — extend `api/og.ts` so a `?w=…&a=…` URL gets a Discord/Slack/iMessage unfurl rendering the cards as a grid. We already have the resvg pipeline.
- [ ] **Dedicated `/list` (or `?view=list`) view** — a full-page rendering of just the shared lists, not gated behind the add-card overlay. Click "Start trade" to flip into trade mode with the shared lists pre-loaded.

### Phase 2 — Accounts + sync (upgrade path, not gate)

Discord OAuth (single provider — matches the eventual community layer), Neon Postgres via Vercel Marketplace, lists sync to the server when signed in, local-first while anonymous.

Phase 2 is **purely additive** — it doesn't change what's possible anonymously. It enables:
- Cross-device sync (no localStorage boundary)
- Stable handle URLs (`swutrade.com/u/<handle>/wants`) instead of URL-encoded params
- The identity layer for Phase 4 Discord features

Anonymous users continue using URL-encoded shares. When they sign in, their existing local lists migrate to the server.

- Data model: `users`, `wants_items`, `available_items`, `list_share_tokens`, `discord_guild_memberships`
- Public profile URLs: `swutrade.com/u/<handle>` for a user's wants (available stays private by default — see *Privacy defaults* below)
- Conflict resolution: last-write-wins per item (lists are small, not collaborative)

### Phase 3 — Shared trade links carry sender context

- Trade links gain `?from=<handle>` (signed-in sender) or `?wl=<shortcode>` (anonymous embed). Recipient sees a new source in the add-card empty state: *"What @handle wants"*.
- Signed-in recipient sees a further slice: *"From @handle's wants that you have available"* — inline match preview for the pair.

### Phase 4 — Discord community layer

**4a. Discovery (web app):** Discord OAuth with `guilds` scope; surface "cards from people in your mutual servers" as another section in the add-card empty state. Per-guild opt-in toggle so users control where they appear.

**4b. The bot:** HTTP Interactions model (signed webhooks, no persistent WebSocket) so it runs on Vercel Functions alongside the web app. Slash commands: `/wants`, `/offer`, `/matches @user`. Optional match-notification channels per server.

---

## Design decisions log

Append-only record of choices we made and why. Entries are dated and terse — full reasoning lives in the PR / commit description, this is the "remember why" file.

### 2026-04-14 — Empty-state drives add-card, not a separate surface

Rejected: adding a "Quick picks" bar or a second tab to the add-card overlay.
Chose: **the empty state (before any query) is where personal + social sources surface.** Search is one tool; lists, sender wants, and Discord matches are peer sources that all render in the empty state. Typing reveals TCGPlayer results.

Why: scales cleanly to Phase 3 (sender wants slot into the same place) and Phase 4 (community matches join the same stack). Avoids fragmenting "add to trade" across multiple paths. Lists Drawer stays as the management surface.

### 2026-04-14 — Wants carry an `isPriority` flag (boolean, not scalar)

Community feedback surfaced the need to flag "really want" cards distinctly from the rest of the list. Boolean keeps the data model simple; matchmaking in Phase 3/4 can rank priority higher and potentially trigger higher-urgency bot pings. Easier to widen to a tier enum later than to narrow it.

### 2026-04-14 — HTTP Interactions bot over gateway bot

Standard Discord bots need a persistent WebSocket, which doesn't fit Vercel Functions. HTTP Interactions runs as signed webhooks on the same platform as the web app — one infra surface, no second deployment target. Trade-off: bot can't passively read messages, which is fine for our use case (slash-command-driven trading, not chat analysis).

### 2026-04-14 — Discord OAuth only (no email fallback at launch)

Niche community; Discord is already central to the vision. Skipping a second auth provider simplifies the stack and avoids a lifetime of "which account is mine" confusion. Will revisit if non-Discord users ask.

### 2026-04-14 — `cardType` drives leader/landscape rendering

Legacy heuristic was "any variant is Showcase → treat as Leader." Enrichment populates `cardType` per variant now, so we use it directly for Leader/Base detection. Showcase heuristic stays as a fallback for unmatched cards. Fixes the Unit-with-Showcase-printing case (Darth Vader - Unstoppable rendered landscape incorrectly).

### 2026-04-14 — Anonymous sharing is a complete feature, not a prerequisite for Phase 2

Earlier framing implied that the rich shared-list UX (dedicated views, OG image unfurls, prominent landing experience) needed accounts to land. Wrong. URL-encoded params already carry everything needed for a full sharing experience — recipient sees, browses, and pulls cards from the sender's lists. Accounts are an *upgrade path* (cross-device sync + stable handles), not a gate.

Practical consequence: the landing banner, dedicated `/list` view, and OG image generation move into Phase 1 polish. Phase 2 still owns persistence + identity, but doesn't block any user-visible sharing capability.

### 2026-04-14 — Dropped: save-to-list affordance on search tiles

Considered: a bookmark icon on each search tile so users could save cards to wants/available without leaving the trade overlay.

Rejected. Trader feedback: lists tend to be stable references built when organizing a collection, not something updated in the heat of an active trade. The "closed loop" framing was theoretical — in practice most users just want to *consume* their lists during trade-building, not modify them. Dropped to keep the trade flow uncluttered.

### 2026-04-14 — Privacy defaults for Phase 2

Wants: public by default (makes discovery meaningful), togglable to private per user.
Available: private by default (supply is leverage), shared only to users in mutual opted-in Discord guilds once Phase 4 lands.

---

## Parked technical improvements

### Decouple price refresh from deploys

**Today:** Prices are baked into the build (`public/data/*.json`). A 2h GitHub Actions cron pokes a Vercel deploy hook with `?buildCache=false` to force a re-fetch. Each refresh = a full ~5min production deploy.

**Better:** Move price data into Vercel Blob (or KV) and have a Vercel Cron Job hit `/api/refresh-prices` to rewrite it. App reads from the live store. No redeploys for price updates; updates propagate in seconds.

Sketch:
- `api/refresh-prices.ts` runs the fetch logic, writes each set's JSON to Vercel Blob (`access: 'public'`)
- App fetches from `https://<store>.public.blob.vercel-storage.com/data/{slug}.json`
- `vercel.json` cron: `{ path: '/api/refresh-prices', schedule: '0 */2 * * *' }`
- Deploys still seed an initial copy via `scripts/fetch-prices.ts` for first-load before any cron fires
- Delete `.github/workflows/refresh-prices.yml`

Trade: adds a Blob dependency, but prices update without redeploys and we stop burning a 5min build every 2h.

### Leader card images are portrait-padded

TCGPlayer serves all card images as 5:7 portrait. Leaders are landscape in-game, so their portrait-padded thumbnails get cropped when rendered in landscape tiles. swuapi exposes `frontImageUrl` which might be the real landscape image; worth investigating when we do another visual pass.

### Other pending UX notes

- Allow replacing cards in trade list (in-place edit)
- Keep search open + Done button + qty shown inline in search
- Creator credit footer refinement
