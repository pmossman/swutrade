# Roadmap

Living document: long-term vision, phased plan, design decisions, and parked ideas. Not commitments — just so we don't lose them.

---

## Vision

SWUTrade began as a trade balancer — two parties, two sides, price math. The next horizon is making it a **trading hub** for the local / in-person trading experience: users curate what they want and have, trades pull from personal and social sources, and a Discord community layer plugs into the regional server where a lot of real-world trading is already coordinated.

**Core mission**: make local / in-person trading easier and more delightful. The concrete behaviors we're serving are the ones that already happen in any regional SWU Discord — wants lists posted as plain text that nobody finds a week later, "anyone bringing X to the tournament Saturday?", trade agreements evaporating between Discord and the LGS. SWUTrade is the structured backbone under those conversations.

Four invariants we protect through all of this:

1. **Anonymous mode stays first-class.** The core trade calculator works without an account, forever. Accounts are strictly additive — cloud sync and community features. A new player should be able to use the site for the first time, balance a trade, and share the link, all without signing in.
2. **The trade window is the center of gravity.** Lists, shared links, Discord matches — all of it feeds cards INTO the trade. The trade UI is the destination, not the side feature.
3. **Variant semantics are asymmetric.** Wants are predicates (`any` / specific variants). Available is concrete (exact productId). Matchmaking only works if we honor this everywhere.
4. **The web app authors; Discord converses.** (Phase 4+.) Rich authoring of objects — lists, trade proposals, visit announcements — lives in the web app where the UX can support card pickers, date pickers, and balancer math. The bot is a broadcast transport: it renders those objects into Discord channels and DMs, and accepts one-tap responses to pushed notifications. It does not try to become an authoring surface.

---

## Phases

### Phase 1 — Personal lists + anonymous sharing *(complete — through `v2026.04.15.2-stable`)*

Local-first wants and available lists. Anonymous URL-encoded sharing is a complete feature on its own — accounts (Phase 2) layer persistence and identity on top, they don't gate the core sharing UX.

**Shipped:**
- [x] Data model + Zod persistence (`swu.wants.v2`, `swu.available.v1`)
- [x] Lists drawer (Radix Dialog + Tabs) with color-coded Wants / Available tabs
- [x] List rows with qty stepper, priority toggle, delete, inline variant-restriction editor (only offers variants that actually exist for the card family)
- [x] Embedded card picker with a browse-all default, `@tanstack/react-virtual` virtualization, sticky set header, tap-to-decrement, restriction-aware variant pills, colored variant labels
- [x] Shared Variant + Set filters with per-surface persistence; All / Main / Special presets mutually exclusive with individual set chips
- [x] swuapi.com enrichment at build time (`baseCardId`, `cardType`, aspects, traits) + enrichment-driven filtering that drops non-card SKUs and token/leader id collisions
- [x] Cross-printing family-id so "any variant" wants match Standard / Hyperspace / Showcase (also merges TCGPlayer name typos like Cad vs Cade Bane via `displayName`)
- [x] URL encoding (`?w=…&a=…`) — anonymous sharing
- [x] Share popover: Copy link · Share via… (`navigator.share`) · Save as image · QR code for in-person scanning
- [x] Dense-row OG image for shared-list link previews (matches the web landing view)
- [x] Dedicated `/list` (or `?view=list`) landing view: compact row layout with recipient-side filter controls (search + Variant + Set), surfaces multi-variant restrictions on each row, "Start a trade" CTA
- [x] Trade-side picker source chips that narrow the grid to a personal/shared list instead of separate sidebar sections (Offering: **My available** / **They want**; Receiving: **My wants** / **They have**). Counts are qty-aware and auto-disappear when exhausted
- [x] Start-trade handoff from `/list` auto-opens the Offering search overlay with the "They want" source chip active (and filters reset so old state can't blank the sender's cards)

**Parked follow-ups (not blocking, tracked below):** BarcodeDetector scanner (in-app QR capture); foil variants for SOR / SHD / TWI (TCGPlayer early-set foil-toggle data format).

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

### Phase 3 — Matchmaker + shared trade context

**3a. Trade matchmaker:** Enter another user's handle (or scan their QR) → app fetches their public lists → cross-references both directions (their wants ∩ your available, your wants ∩ their available) → suggests the fairest balanced trade. Pure function, greedy algorithm: sort overlap pools by price, alternately pull from each side until totals balance within the user's percentage threshold. Pre-populates both sides of the trade view.

**3b. Sender context in trade links:** Trade links gain `?from=<handle>` (signed-in sender) or `?wl=<shortcode>` (anonymous embed). Recipient sees a new source chip: *"What @handle wants"*. Signed-in recipient sees *"From @handle's wants that you have available"* — inline match preview for the pair.

### Phase 4 — Discord community layer

Phase 4 exists to serve the actual texture of local in-person trading as it
already plays out in a regional Discord server (e.g. San Diego SWU): someone
drops a wants list in plain text, someone else asks "anyone bringing X to
Game Empire Saturday?", trades get agreed to in DMs and then evaporate by
Tuesday because nobody wrote it down. SWUTrade's job is to be the structured
backbone underneath that conversation — lists, matches, agreements, meetup
intent as first-class data — while Discord stays the conversation.

**Architectural principle — bot as broadcast transport, not input surface.**
All authoring happens in the web app, where the UX can support card pickers,
autocomplete, variant restrictions, calendar inputs, and trade balancing.
Anything the user wants to *publish* to Discord (share a list, announce a
visit, propose a trade) is triggered from the web app; the bot's job is to
render the resulting embed into the right channel or DM. The only input the
bot accepts directly is (1) one-tap button responses to pushed notifications
("Accept" / "Decline" on a trade proposal DM) and (2) eventual read-only
query commands (`/whohas <card>`). It does not author or mutate objects on
its own. See the design-decisions log for the full rationale.

**Three-axis consent model for signed-in users.** Signing in does not imply
opting into community noise. Three orthogonal toggles:

  - **Discoverability**: others in shared servers can see my profile / match
    with me / see my wants in community rollups. *Default on.*
  - **Location & schedule presence**: I tag LGSs, announce visits, appear in
    "who's going to X Saturday" results. *Default off — active opt-in.*
  - **Bot DMs to me**: unsolicited notifications (match alerts, meetup
    reminders). *Default off except for direct transactional pings* (a trade
    proposal addressed specifically to me — that's not spam, it's mail).

Enrollment is per-guild. Signing in does not auto-join any server's trading
community; user picks which shared servers to enroll in. A valid use case is
"sign in, sync my list, never enroll in any server" — passive sync users are
first-class.

---

**v1 scope** (drop-into-a-server demo):

  - Discord OAuth with `guilds` scope; new `user_guild_memberships` table.
  - **Per-guild enrollment UI** on the web: "You're in 3 Discord servers
    with SWUTrade installed; want to join any of their trading communities?"
    with a Maybe-Later that doesn't guilt.
  - **Account-level settings page**: profile visibility (public / Discord-only
    / private), bot-DM category toggles.
  - **Per-guild settings** inside each enrolled server: include in community
    rollups, announce to channel, appear in read-only queries.
  - **Community source** in the card picker's empty state — cards wanted /
    held by members of a shared + enrolled server. Popular-wants badges gain
    guild-scoped variants: "3 in Star Wars SD want this".
  - **"Share my list to Discord"** action in the Lists drawer. User picks
    channel; bot posts a rich embed.
  - **Bot as broadcast transport**: signed HTTP Interactions endpoint for
    button responses, outbound broadcast endpoint invoked by our backend.
  - **Trade proposals** (previously Phase 5) elevate into Phase 4 v1 because
    they're the natural first use of bot DMs: web-authored, bot-delivered,
    accepted/countered/declined via one-tap DM buttons.
  - **No slash commands in v1.** Wait for demonstrated need before building
    read-only query commands.

**v2 scope** (once settings infrastructure is proven):

  - **LGS directory** as a server-admin-managed object. Admins with Discord
    `MANAGE_GUILD` permission can add / rename / deactivate LGSs via a web
    admin page at `/guilds/<id>/admin`. Server-scoped initially; an LGS added
    by admins of N different servers can be promoted to a global entity
    (e.g. a single "Cool Stuff Games" shared across several SoCal Discords).
  - **LGS presence — schedule, not just tag.** Members set a "usually at"
    in profile. Separately, they can announce specific visits
    ("going to Game Empire Sat 6pm") — web-authored, bot-broadcast to the
    server's configured channel. Visits expire when the event passes, so
    there's no stale "I still need this" debris.
  - **Meetup-aware matching**: "4 traders going to Game Empire Sat: Alice
    (wants your Vader), Bob (has your Luke)…" scoped to the visit window.
  - **Match-alert DMs** — the spammiest category. Depends on the
    notifications settings being well-tuned in v1 before we ship.
  - **Read-only query slash commands** (`/whohas <card>`, `/whowants <card>`)
    if users in the live server reach for them. Otherwise skip.

**Non-goals (explicitly):**

  - Slash commands that author or mutate objects (`/goingto`, `/trade`, etc).
    Authoring stays in the web app; the bot relays the output.
  - Gateway bot (persistent WebSocket). HTTP Interactions runs on Vercel
    Functions alongside the web app — one infra surface.
  - The bot reading channel messages or scraping conversation.

**Data-model sketch:**

  - `user_guild_memberships` — `(user_id, guild_id, enrolled, include_in_rollups, announce_visits_channel, appear_in_queries, joined_at)`
  - `user_settings` — `(user_id, profile_visibility ∈ {public, discord, private}, dm_trade_proposals, dm_match_alerts, dm_meetup_reminders)`
  - `lgs` *(v2)* — `(id, name, guild_id, promoted_to_global, address?, …)`
  - `user_lgs` *(v2)* — usual LGS(s) a user plays at
  - `lgs_visits` *(v2)* — `(id, user_id, lgs_id, visit_at, created_at, cancelled_at)`
  - `trade_proposals` — `(id, from_user, to_user, status, your_cards, their_cards, percentage, price_mode, parent_id FK→self, created_at, expires_at)`

### Phase 5 — Trading network (post-Phase-4)

The full **Discover → Match → Propose → Negotiate → Complete → Remember**
lifecycle on top of the Phase 4 primitives. Trade proposals themselves ship
in Phase 4 v1 (web-authored, bot-delivered); Phase 5 layers the longer-lived
relationship features: counter-offer threading, trader reputation,
auto-update of wants/available on completion, and the "preferred traders"
system that feeds back into matchmaker scoring. Trust signals (trade count,
recency, preferred-trader flag) become inputs to the matchmaker so familiar
traders rank higher.

**Data-model additions beyond Phase 4's `trade_proposals`:**

  - `trader_connections` — `(user_a, user_b, trade_count, last_trade_at, is_preferred)`
  - `trade_history` — completed proposals, promoted out of `trade_proposals`
  - `notifications` — `(id, user_id, type, payload JSONB, read, created_at)` — lightweight in-app inbox for users who opted out of bot DMs but still want a record

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

### 2026-04-15 — Source lists are filters on the picker grid, not sidebar sections

The trade-search overlay used to render separate collapsible sections for "From your Available / Wants" and "From the shared link". Those sections sat between the filter bar and the main grid, competing for screen real estate and splintering the add-card action across three surfaces.

Refactored into two source chips (Offering: *My available* / *They want*; Receiving: *My wants* / *They have*) that narrow the **main grid** to that subset. Variant / Set filters still apply on top. Chips carry remaining-qty counts and auto-deactivate when exhausted.

Why: one grid, one mental model. The "add a card to this side" action lives in one place, and source scoping is just another filter dimension. Preserves Phase-3 / Phase-4 scalability — additional sources (sender wants under a signed-in handle, Discord community matches) can land as additional chips without changing the layout.

### 2026-04-15 — Shared-list view optimizes for recipient scan speed, not card browsing

The original `/list` landing rendered a tile grid identical to the picker's. Visually nice, but optimized for the wrong job: a recipient arriving from a share link needs to quickly answer "is there anything I can trade for?", not browse art.

Rewrote as a compact row layout with in-view filter controls (name search + Variant + Set). Many more items fit before scrolling; multi-variant wants surface the full restriction on their row so a recipient sees every printing the sender accepts. OG image follows the same density pattern so link previews match the landing page.

### 2026-04-15 — One Share action with every channel behind it

Split Link / Image buttons consolidated into a single **Share** popover containing Copy link, `navigator.share` (when supported), Save as image, and a QR code. Cleaner drawer header, and new share channels (Discord invite to a handle-based share in Phase 2/4) can land as more menu entries without more chrome. QR being always-visible in the popover is deliberate — the in-person "look at my phone" handoff is a first-class use case, not a buried affordance.

### 2026-04-14 — Privacy defaults for Phase 2

Wants: public by default (makes discovery meaningful), togglable to private per user.
Available: private by default (supply is leverage), shared only to users in mutual opted-in Discord guilds once Phase 4 lands.

### 2026-04-16 — Bot is broadcast transport; authoring stays in the web app

Considered: a Discord-first model where users author via slash commands (`/goingto`, `/trade`, `/mywants edit`, etc). Rejected.

Chose: **the web app is the canonical authoring surface; the bot's primary job is to render structured snapshots of web objects into Discord as rich embeds + DMs.** The bot accepts input in exactly two narrow cases: (1) one-tap button responses to pushed notifications (Accept / Counter / Decline on a trade-proposal DM) and (2) read-only query slash commands if users actually reach for them later (`/whohas <card>`). Never authors or mutates non-trivial objects directly.

Why: Discord UI can't host the card picker, variant restrictions, trade balancer, or calendar inputs that our web UX already does well. Slash-command authoring would be a strictly worse parallel version of every feature we've already built. This matches how mature Discord integrations work (Linear, Vercel, GitHub bot) — they broadcast rich events and receive one-tap actions, they don't try to become the product.

Consequence: no `/goingto`, `/trade`, `/mylist edit` in Phase 4. Visit announcements, list shares, trade proposals are all *web-authored → bot-delivered*. Supersedes the framing in the 2026-04-14 "HTTP Interactions bot" entry which implied a slash-command-driven trading flow.

### 2026-04-16 — Three-axis consent model for signed-in community features

Signing in ≠ opting into community noise. Previous draft assumed a signed-in user implicitly joined their servers' trading communities and accepted match-alert DMs. Wrong — that makes the app annoying for the passive-sync user.

Three orthogonal toggles with deliberately conservative defaults:

1. **Discoverability** — profile visible, match-eligible, counted in community rollups. *Default on.* This is the baseline of "I joined the community layer."
2. **Location & schedule presence** — LGS tagging, visit announcements, appearing in "who's going to X" queries. *Default off.* Physical-presence disclosure is a meaningful step beyond discoverability.
3. **Bot DMs to me** — unsolicited push (match alerts, meetup reminders). *Default off.* Direct transactional mail (a trade proposal addressed specifically to me) is the sole exception — that's mail, not spam.

Granularity is mostly per-guild with an account-level layer for app-wide concerns (profile visibility, DM categories). Enrollment in a server's trading community is always affirmative: signing in does not auto-join any server.

Why: this protects the largest likely user segment (sign in for sync + passive browsing) from features optimized for the most engaged segment (meetup coordinators). It also makes each broadcast-capable feature gateable — we can't ship "announce your visit" without shipping the toggle to opt out of broadcasting, so the noise controls stay in lockstep with the noise.

### 2026-04-16 — LGS directory is a web object, server-admin-curated

Considered: letting users self-declare LGSs as free text, or letting anyone add to a shared list via `/lgs add` bot command. Both rejected.

Chose: **LGSs are persistent objects curated by server admins via a web admin page** at `/guilds/<id>/admin`, gated on the viewer's Discord `MANAGE_GUILD` permission (available from the guild OAuth scope, no separate role system). Server-scoped initially; an LGS added by admins of N different servers can be promoted to a global entity so a single "Cool Stuff Games" is shared across, e.g., multiple SoCal Discords.

Consequence: no `/lgs add` slash command. Visit announcements and "usual LGS" tags *reference* entries from the directory (via autocomplete / dropdown), they never *create* new ones. Consistent with the broader bot-is-broadcast-transport principle — LGSs are objects, and object mutation happens in the web app.

### 2026-04-16 — Trade proposals elevate from Phase 5 into Phase 4 v1

Previously slotted in Phase 5 as part of the "full lifecycle" (proposals + counter-offers + relationships + trust-weighted matchmaking). Moved the proposal primitive itself into Phase 4 v1 because it's the cleanest first use of the bot-as-DM-transport: web-authored (sender builds the trade in the balancer), bot-delivered (recipient gets a DM with a frozen snapshot + Accept/Counter/Decline buttons), response is a one-tap button interaction (fits the "bot as input only for responses to pushed notifications" rule).

Phase 5 still owns the longer-lived relationship features: counter-offer threading, reputation, trader-connection scoring feeding matchmaker, auto-update of wants/available on completion. Proposals just happen earlier because they're load-bearing for the demo and depend only on primitives Phase 4 is already building.

### 2026-04-16 — CI stays mocked; real-Discord coverage is layered on top

Considered: pointing CI at a dedicated Discord test server and having every PR exercise real Discord API calls. Rejected.

Chose: **mocked CI as the merge gate, with two additional layers specifically to close the gaps mocking leaves open** — a nightly contract-drift check hitting real Discord, and a written manual Tier-3 runbook exercised in a dedicated test server before any promotion to main. See `PHASE4_TESTING.md` for the live spec.

Why: the user correctly insists on a high standard — "green CI means all features definitely work in production." Real-Discord-in-CI *sounds* like the way to uphold that, but it fails the standard in practice: Discord rate limits (50 req/s global, 5 req/5s per channel) throttle concurrent CI runs, network flake produces spurious failures that train devs to hit "retry" on legitimate red runs, cleanup state across test runs is brittle, and the merge gate becomes coupled to a third party's uptime. Worse, ~90% of Discord-related bugs are on our side of the wire (payload construction, response parsing, signature verification) — none of which need a real round-trip to catch.

The standard is upheld instead by four disciplines enumerated in `PHASE4_TESTING.md`: a typed `DiscordClient` abstraction so contract changes become compile errors, mocked responses captured from real Discord calls (not hand-crafted), a signature-verification test that exercises the real verification path with a locally-generated keypair, and a nightly contract-drift job that catches Discord-side schema changes within 24h without blocking merges. Every Discord-integrated feature ships with a parallel Tier-3 entry in the runbook — that's a non-optional shipping requirement, same as unit tests.

Consequence: no bot token in CI secrets. CI runs offline relative to Discord. The dedicated test server exists for manual smoke tests only. This is deliberate.

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

### In-app QR scanner *(Phase 1 follow-up)*

QR code display and Web Share API both landed as part of the unified Share popover in v2026.04.15.1-stable, so the "hold up my phone" and "AirDrop this to you" in-person flows are covered.

Still parked: an in-app recipient-side scanner using `BarcodeDetector` (Chromium solid, Safari partial) so a recipient can tap "Scan a list" inside SWUTrade instead of bouncing to their stock camera app. Nice-to-have, not necessary — external camera apps already do the right thing for our URLs — but it'd shave a step in the in-person handoff. Phase 2 (accounts) makes it richer later: a signed-in scanner could auto-import the scanned list rather than just navigating to the URL.

### Foil variants for SOR / SHD / TWI

TCGPlayer split foil into its own product SKU starting with SEC, so we get Foil, Hyperspace Foil, Prestige Foil, etc. as first-class variants for SEC+. The first three sets (SOR, SHD, TWI) were released when TCGPlayer still used a "foil toggle" on the same product — both printings live on one productId, so our data ends up with only Standard and Hyperspace (and Showcase for leaders/bases).

Foil prices for those sets exist via `https://mpapi.tcgplayer.com/v2/product/{id}/pricepoints`, which returns `[{printingType:'Normal',marketPrice,...}, {printingType:'Foil',marketPrice,...}]`. To wire them up:

- Call pricepoints in `scripts/fetch-prices.ts` for dual-printing SKUs (neither `foilOnly` nor `normalOnly`); adds ~1500 extra HTTP calls across the three sets.
- Emit a second `CardVariant` per dual-print card with `variant: 'Foil'` or `'Hyperspace Foil'` and the foil market/low.
- Update dedup keys (`tradeCardKey`, `byProductId` maps, and anywhere else keyed off productId alone) to fold in `printing` or `variant` — both variants share the same productId.

Non-trivial because the productId-as-identity assumption is load-bearing. Half-day-ish task. Park until a user actually asks for early-set foils.

### Price movers + history (requires daily snapshot infra)

**Today:** prices are point-in-time — the app knows what a card costs right now, but not whether it's trending up or down.

**Infra:** add a `price_snapshots` table (`product_id text, date date, market_price numeric, low_price numeric`, ~7K rows/day). Populated by the price-refresh cron — each run diffs against the latest snapshot and inserts a new row only when the date changes. Neon free tier handles ~2.5M rows/year comfortably.

**Features this unlocks (each independent):**
- **Biggest gainers / losers this week** — surface in the search overlay's empty state so traders spot mispriced cards. Query: compare today's snapshot to 7-day-ago, sort by absolute or relative delta.
- **Price sparklines** — tiny 30-day inline chart on card rows (trade view, list view, profile). Beautiful but needs 30 days of history before it's useful.
- **Collection value tracker** — sum a user's available list's market value per day. "Your collection: $247 (+$12 this week)." Shown on the profile page or in the drawer.
- **Price alerts** — "Notify me when X drops below $Y." Needs a notification channel: Discord DM via the Phase 4 bot, or an in-app badge on next visit.

### Other pending UX notes

- Allow replacing cards in trade list (in-place edit)
- Creator credit footer refinement
