# Roadmap

Living document: long-term vision, phased plan, design decisions, and parked ideas. Not commitments — just so we don't lose them.

**Companion docs:**
- `CODE_REVIEW_2026_04_17.md` — architectural review of the post-Phase-4c codebase. Critical / architectural / polish findings.
- `UX_REVIEW_2026_04_17.md` — UX review of every major flow. Critical / core friction / polish findings.
- `PHASE4_TESTING.md` — three-tier test strategy and Tier 3 manual runbook.
- `PHASE4C_COUNTER_DESIGN.md` — counter-flow architecture (mostly implemented; lives on as reference for expiry + chain-visualization follow-ups).

---

## Vision

SWUTrade began as a trade balancer — two parties, two sides, price math. The next horizon is making it a **trading hub** for the local / in-person trading experience: users curate what they want and have, trades pull from personal and social sources, and a Discord community layer plugs into the regional server where a lot of real-world trading is already coordinated.

**Core mission**: make local / in-person trading easier and more delightful. The concrete behaviors we're serving are the ones that already happen in any regional SWU Discord — wants lists posted as plain text that nobody finds a week later, "anyone bringing X to the tournament Saturday?", trade agreements evaporating between Discord and the LGS. SWUTrade is the structured backbone under those conversations.

Four invariants we protect through all of this:

1. **Anonymous mode stays first-class.** The core trade calculator works without an account, forever. Accounts are strictly additive — cloud sync and community features. A new player should be able to use the site for the first time, balance a trade, and share the link, all without signing in.
2. **The trade window is the center of gravity.** Lists, shared links, Discord matches — all of it feeds cards INTO the trade. The trade UI is the destination, not the side feature.
3. **Variant semantics are asymmetric.** Wants are predicates (`any` / specific variants). Available is concrete (exact productId). Matchmaking only works if we honor this everywhere.
4. **The web app authors; Discord converses.** Rich authoring of objects — lists, trade proposals, visit announcements — lives in the web app where the UX can support card pickers, date pickers, and balancer math. The bot is a broadcast transport: it renders those objects into Discord channels and DMs, and accepts one-tap responses to pushed notifications. It does not try to become an authoring surface.

---

## Phases

### Phase 1 — Personal lists + anonymous sharing *(complete — through `v2026.04.15.2-stable`)*

Local-first wants and available lists. Anonymous URL-encoded sharing is a complete feature on its own — accounts (Phase 2) layer persistence and identity on top, they don't gate the core sharing UX.

**Shipped:**
- [x] Data model + Zod persistence (`swu.wants.v2`, `swu.available.v1`)
- [x] Lists drawer (Radix Dialog + Tabs) with color-coded Wants / Available tabs
- [x] List rows with qty stepper, priority toggle, delete, inline variant-restriction editor
- [x] Embedded card picker with browse-all default, virtualization, sticky set header, tap-to-decrement, restriction-aware variant pills
- [x] Shared Variant + Set filters; All / Main / Special presets
- [x] swuapi.com enrichment at build time + filtering that drops non-card SKUs
- [x] Cross-printing family-id + `displayName` typo merging
- [x] URL encoding (`?w=…&a=…`) — anonymous sharing
- [x] Share popover: Copy link · navigator.share · Save as image · QR code
- [x] Dense-row OG image for shared-list link previews
- [x] Dedicated `/list` landing view with compact row layout
- [x] Trade-side picker source chips (Offering: *My available* / *They want*; Receiving: *My wants* / *They have*)
- [x] Start-trade handoff auto-opens Offering search overlay

**Parked follow-ups:** BarcodeDetector scanner; foil variants for SOR / SHD / TWI (see Parked technical improvements).

### Phase 2 — Accounts + sync *(complete)*

Discord OAuth, Neon Postgres via Vercel Marketplace, lists sync to server when signed in, local-first while anonymous.

**Shipped:**
- [x] Discord OAuth (Arctic) + iron-session cookies
- [x] Neon Postgres + Drizzle ORM; `users`, `wants_items`, `available_items`, `trades` (personal saved trades)
- [x] Migration prompt on first sign-in if local lists exist
- [x] Public profile routes: `/u/<handle>` (rewrite via vercel.json) + `/?profile=<handle>` query form
- [x] Last-write-wins sync via `/api/sync/wants` and `/api/sync/available`

### Phase 3 — Matchmaker + shared trade context *(complete)*

**3a. Trade matchmaker** *(shipped)* — greedy balanced-trade suggestion from cross-referencing two users' lists. Pure function. Triggered via ProfileView "Start a trade" or via `?from=<handle>&autoBalance=1` URL.

**3b. Sender context in trade links** *(shipped)* — `?from=<handle>` URL param surfaces sender identity; picker shows "They want / They have" source chips inline with personal-list chips. AutoBalanceBanner suggests a balanced trade when a signed-in recipient arrives via a share link.

### Phase 4 — Discord community layer

Phase 4 exists to serve the actual texture of local in-person trading as it already plays out in a regional Discord server (e.g. San Diego SWU): someone drops a wants list in plain text, someone else asks "anyone bringing X to Game Empire Saturday?", trades get agreed to in DMs and then evaporate by Tuesday. SWUTrade's job is to be the structured backbone underneath that conversation.

**Architectural principle — bot as broadcast transport, not input surface.** See 2026-04-16 design decision.

**Three-axis consent model for signed-in users:**
- **Discoverability** *(default on)*
- **Location & schedule presence** *(default off — Phase 4 v2)*
- **Bot DMs to me** *(default off, except direct transactional pings like trade proposals)*

Enrollment is per-guild. Signing in does not auto-join any server's trading community.

---

**Phase 4 v1** *(substantially shipped as of 2026-04-17)*

The drop-into-a-server demo: compose + send + receive + respond to trade proposals, discover trading partners through the community directory, manage enrollment + consent per-guild.

- [x] Discord OAuth with `guilds` scope; `user_guild_memberships` table
- [x] Per-guild enrollment UI in Settings; bundle on/off toggle (enrolled → includeInRollups + appearInQueries)
- [x] Account-level settings page: profile visibility (public / discord / private; default **discord**), bot-DM category toggles
- [x] Signed HTTP Interactions endpoint with Ed25519 signature verification (dual-key test fallback for e2e)
- [x] APPLICATION_AUTHORIZED webhook handler; `bot_installed_guilds` table populated automatically on bot install
- [x] Bot install link via OAuth URL; Settings page shows "Invite SWUTrade bot" block
- [x] Community directory at `/?community=1` — members of mutually-enrolled guilds with per-member overlap stats
- [x] Community source chips in the picker ("Community wants / has") scoped to the viewer's enrolled guilds
- [x] Popular-wants badges (guild-scoped rollup via `user_guild_memberships.include_in_rollups`)
- [x] Trade proposal composer at `/?propose=<handle>` — ProposeBar auto-seeds via matchmaker, optional proposer note, sends via bot DM
- [x] Recipient DM with Accept / Counter / Decline buttons (frozen card snapshots so price/list drift doesn't mutate the proposal)
- [x] Accept/Decline via one-tap button interactions; DM is edited in place with outcome + proposer gets notification DM
- [x] Counter flow: Counter button → ephemeral deep-link to `/?counter=<id>` web composer → submits new proposal with `counter_of_id` FK; original flips to `countered` terminal state; chain supports arbitrary depth
- [x] Trade history at `/?trades=1` and detail at `/?trade=<id>` — sent + received view, status chips, chain-context links, proposer-can-cancel-if-pending
- [x] Signed-interaction e2e (synthetic button click via test keypair) closes the server-contract gap Discord couldn't cover from real button clicks
- [x] **Private threads for trade proposals** — proposals land in a `#trades` thread with both traders auto-added instead of per-user DMs (fallback to DM when thread creation fails); auto-created on bot install (`2026-04-17`, `2026-04-18`)
- [x] **Prefs registry** — typed registry with self/peer/guild scopes, cascade resolver, Discord ⚙ Prefs button, `/swutrade settings` slash command + user context menu (`2026-04-17/18`)
- [x] **Bot-install outreach** — DM existing SWUTrade users in a guild on bot install with a one-tap Enroll button; `dmServerNewInstall` / `autoEnrollOnBotInstall` prefs added (`2026-04-18`)
- [x] **Slack-style Settings drill-down + persistent Done button** — per-trader peer prefs live under Settings > Servers > Guild > Members > User (`2026-04-18`)
- [x] **Signed-in Home landing page** — pending trades + enrolled communities + Build-a-trade CTA; signed-out users still land on trade builder (`2026-04-18`)
- [x] **Error observability** — typed Discord error hierarchy + 429 auto-retry + `#bot-errors` webhook reporter + CI `#releases` notifier (`2026-04-18`)

**Phase 4 v1 — not shipped / deferred:**

- [ ] **"Share my list to Discord" channel-post action** — originally planned as a v1 feature. Deferred after user discussion: channel posts ("here's my whole list") lack a strong use case on their own; proposals to specific users carry more signal. Revisit if the community asks for a lightweight "what I brought today" channel post.
- [ ] **Slash commands** — none in v1 deliberately. Wait for demonstrated need before building `/whohas`.

**Phase 4 v2** *(not yet started — most of the community-depth features)*

- [ ] **LGS directory** as server-admin-managed web object at `/guilds/<id>/admin`, gated on Discord `MANAGE_GUILD`.
- [ ] **LGS presence** — "usually at" profile tag + per-visit announcements (web-authored → bot-broadcast to the guild's configured channel). Visits expire post-event so stale intent doesn't accumulate.
- [ ] **Meetup-aware matching** — "4 traders going to Game Empire Sat: Alice (wants your Vader), Bob (has your Luke)…" scoped to the visit window.
- [ ] **Match-alert DMs** — the spammiest category. Gate behind the three-axis consent toggle.
- [ ] **Read-only slash commands** (`/whohas <card>`, `/whowants <card>`) if users in the live server reach for them.
- [ ] **Tier 2 nightly Discord contract probe** — real-Discord API health check (see `PHASE4_TESTING.md`). Stand up once the bot has real user traffic; probe nothing pre-launch.

### Phase 5 — Trading network *(partially pulled forward; rest post-Phase-4-v2)*

The full **Discover → Match → Propose → Negotiate → Complete → Remember** lifecycle on top of the Phase 4 primitives. Proposal, counter, cancel, and history shipped in Phase 4 v1 (ahead of schedule because they were load-bearing for dogfooding).

**Still to ship:**

- [ ] **Trade expiry cron** — proposals `pending` past N days (30?) auto-transition to `expired`. Recipient's DM is edited with a gray "expired" banner. Needs a cron entry in `vercel.json` + an endpoint at `/api/jobs/expire-proposals` (or similar).
- [ ] **Trader reputation / preferred traders** — `trader_connections` table (`user_a, user_b, trade_count, last_trade_at, is_preferred`). Feeds matchmaker scoring so familiar traders rank higher.
- [ ] **Auto-update of wants/available on trade completion** — on Accept + confirmation, offer to prune the traded cards from both parties' lists.
- [ ] **Notifications table** — in-app inbox for users who opted out of bot DMs but want a record. `(id, user_id, type, payload JSONB, read, created_at)`.
- [ ] **Trade completion flow** — currently Accept is terminal but doesn't model the "we actually met up and exchanged cards" step. Needs a distinct confirmed/cancelled-IRL state.
- [ ] **Chain visualization in the detail view** — currently the detail view shows one-hop stubs (↑ counter to / ↓ countered by). Long chains deserve a timeline.

### Phase 5b — Live trade sessions *(not started — dedicated phase)*

A second trade modality distinct from the async proposal flow: two users sitting next to each other (at the LGS, at a game night) open a shared trade session on their phones and watch each other's side update in real time.

**Why distinct from proposals:**
- Proposals are **ping-pong, convergent via counter chain**, async, record-of-what-each-party-said. Right for remote trading.
- Sessions are **collaborative, convergent via a single mutable object**, live, confirm-at-the-end. Right for in-person trading.
- They serve different modalities and should coexist, not replace. Users pick the flow that matches the situation.

**Data model (sketch):**
- New `trade_sessions` table (separate from `trade_proposals`): `id` short-code, `offering_cards` / `receiving_cards` JSONB (current live state), `participant_user_ids[]`, `confirmed_by_user_ids[]`, `expires_at`, `updated_at`.
- Short-code URL like `/live/abc123` for easy in-person handoff (also works via QR code).
- `expires_at` enforced by the existing proposal-expiry cron with a shorter TTL (a few hours, not days) so session detritus auto-GCs.

**Conflict model:** each participant only edits their OWN half of the trade (offering = my cards from my viewer, receiving = your cards). Per-side ownership → no concurrent writes to the same field → no OT/CRDT required for v1.

**Transport v1:** client polls `/api/trade-sessions/:id` every 2-3s for the current state. Cheap, works on existing infra, "magic enough" for the in-person-at-the-table case. WebSockets/SSE is a v2 optimization.

**Confirm flow:** both parties tap Confirm → the session freezes into a "settled" record. Option to post a completed-trade event to the community activity feed (Phase 4 v2) + subtract the cards from both parties' lists (links up with "auto-update on trade completion" above).

**UX distinction in the app:**
- Proposal: "Send a proposal to @handle" — Discord DM trail, status chips, counter/decline actions.
- Session: "Start a live trade" — generates a QR + short URL, renders a two-column live-updating view, connected-indicator + confirm buttons.

**Pairs well with LGS integration.** Once LGS visits are a thing ("4 traders going to Game Empire Sat"), a live session attached to "Game Empire Saturday" is the natural handoff from scheduling into the actual in-person exchange.

**Realistic scope:** 3-5 days of work — schema, polling endpoints, session UI, confirm flow, expiry TTL. Not a same-day slice. Defer until the core Phase 4 community loop is settled and we've seen whether beta users actually reach for the in-person modality. If they do, this phase pays off massively.

---

## Next focus: foundation + polish investment

Before the next feature slice, we're parking a quality-investment pass drawn from the post-Phase-4c `CODE_REVIEW_2026_04_17.md` and `UX_REVIEW_2026_04_17.md`. Both reviews converge on the same conclusion: the codebase is healthy for its size, but primitives that every future feature uses (header chrome, status badges, buttons, focus indicators, API error handling) aren't extracted. Each slice re-invents them slightly, and they drift.

**Selected slice (~1 day of work)** — design-system + accessibility + security foundation:

Security + correctness (pull from CODE_REVIEW)
- [ ] Ed25519 signature timestamp-window check (rejects replays older than 5 min) — critical fix, ~20 min
- [ ] `trade_proposals` FK + status indexes — prevents a scale cliff around 10k proposals
- [ ] Runtime env-gate on `DISCORD_APP_PUBLIC_KEY_TEST` so the test key can never take effect on the production deploy

Accessibility (pull from UX_REVIEW)
- [ ] Global `:focus-visible` gold outline — currently invisible on the dark palette
- [ ] 44×44 minimum hit zones on qty/remove/priority buttons (visual size stays 24px via pseudo-element hit expansion)

Design-system primitives
- [ ] `<PageHeader>` — replaces the Logo + wordmark + BetaBadge + back-button chrome repeated across 7 views
- [ ] `<Button variant size>` — primary / secondary / danger × md / sm / xs. Replace h-7 / h-8 / h-9 drift.
- [ ] `<StatusBadge>` — consolidates the duplicate chip between TradeDetailView and TradesHistoryView
- [ ] `<LoadingState>` / `<EmptyState>` / `<ErrorState>` primitives — replace ad-hoc inline patterns

Copy + contextual fixes
- [ ] Counter button label in Discord: "Counter" → "Counter offer"
- [ ] Discord DM field names: "They're offering" → "You would receive" (first-person from recipient's view)
- [ ] "Back to community" after send → "View your trades" (primary) with community as secondary
- [ ] CounterBar: add a context banner on mount explaining side-flip semantics + link to original
- [ ] Consent-bundling explainer on the enrolled-guild card (CU3)
- [ ] Landing-page empty-state one-liner ("your cards on the left, their cards on the right")
- [ ] Sign-in popover copy: lead with the community/trade value, not "sync"

Test dedup (pull from CODE_REVIEW)
- [ ] `tests/api/discordFakes.ts` — canonical `makeFakeBot()`, replace 4 in-file variants
- [ ] `tests/api/fixtures.ts` — `seedTradeProposal(overrides)` → `{ id, cleanup }` — replace 4 in-file variants

The bundle is large but each item is small (most are 10-30 min). The yield compounds: every future view ships smaller and more consistent because the primitives exist.

**Deferred from the reviews** (not in this bundle, worth revisiting):
- ProposeBar/CounterBar extraction (`useComposerBar`) — high-leverage but bigger; wait for a third variant to justify
- Frontend API client (`apiCall` with discriminated result) — foundational, pairs well with the above as a follow-up
- Chain-visualization timeline in TradeDetailView — wait until chain depth > 2 happens in practice
- Embed truncation for 10+ card proposals — only matters when real users hit it
- Prop drilling → context for wants/available/byProductId — wait until the drilling makes a specific change painful

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

Legacy heuristic was "any variant is Showcase → treat as Leader." Enrichment populates `cardType` per variant now, so we use it directly for Leader/Base detection. Showcase heuristic stays as a fallback for unmatched cards.

### 2026-04-14 — Anonymous sharing is a complete feature, not a prerequisite for Phase 2

URL-encoded params already carry everything needed for a full sharing experience. Accounts are an *upgrade path* (cross-device sync + stable handles), not a gate. The landing banner, dedicated `/list` view, and OG image generation live in Phase 1 polish.

### 2026-04-14 — Dropped: save-to-list affordance on search tiles

Trader feedback: lists tend to be stable references built when organizing a collection, not something updated in the heat of an active trade.

### 2026-04-15 — Source lists are filters on the picker grid, not sidebar sections

Refactored to two source chips (Offering: *My available* / *They want*; Receiving: *My wants* / *They have*) that narrow the main grid. One grid, one mental model. Preserves Phase-3/4 scalability — additional sources land as more chips.

### 2026-04-15 — Shared-list view optimizes for recipient scan speed

Compact row layout with in-view filter controls. Multi-variant wants surface full restrictions. OG image matches for link-preview consistency.

### 2026-04-15 — One Share action with every channel behind it

Consolidated Link / Image into a single **Share** popover containing Copy link, `navigator.share`, Save as image, QR code. QR always-visible is deliberate — in-person "look at my phone" handoff is a first-class use case.

### 2026-04-14 — Privacy defaults for Phase 2

Wants: public by default. Available: private by default (supply is leverage), shared only to users in mutual opted-in Discord guilds once Phase 4 lands. *Revised 2026-04-17: profile visibility default changed from `public` to `discord-only` — see corresponding decision below.*

### 2026-04-16 — Bot is broadcast transport; authoring stays in the web app

**The web app is the canonical authoring surface; the bot's primary job is to render structured snapshots of web objects into Discord as rich embeds + DMs.** The bot accepts input in exactly two narrow cases: (1) one-tap button responses to pushed notifications and (2) read-only query slash commands if users actually reach for them later (`/whohas <card>`). Never authors or mutates non-trivial objects directly.

### 2026-04-16 — Three-axis consent model for signed-in community features

Signing in ≠ opting into community noise. Three orthogonal toggles with conservative defaults: Discoverability (on), Location & schedule (off), Bot DMs (off except direct transactional). Enrollment is always affirmative per guild.

### 2026-04-16 — LGS directory is a web object, server-admin-curated

**LGSs are persistent objects curated by server admins via a web admin page** at `/guilds/<id>/admin`, gated on Discord `MANAGE_GUILD` (no separate role system). Server-scoped initially; promotable to global.

### 2026-04-16 — Trade proposals elevate from Phase 5 into Phase 4 v1

The proposal primitive is the cleanest first use of the bot-as-DM-transport: web-authored, bot-delivered, accepted/countered/declined via one-tap DM buttons.

### 2026-04-16 — CI stays mocked; real-Discord coverage is layered on top

Mocked CI as the merge gate; real-Discord via a nightly contract probe (Tier 2, not yet shipped) + a manual Tier 3 runbook. Real-Discord in CI would fail the "green CI = works in prod" standard in practice (rate limits, network flake, brittle cleanup). Most Discord bugs are on our side of the wire anyway.

### 2026-04-17 — Profile visibility default flipped from `public` to `discord`

A new user signing in shouldn't accidentally expose their wants to the open internet. Default to the lower-risk option and let users opt up. No migration for existing rows — zero users pre-change.

### 2026-04-17 — Removed "My profile" from the account menu; Settings owns the share link

Landing on your own `/u/<handle>` page via a "My profile" menu entry was disorienting (no exit affordance, UI designed for outsiders viewing you). Folded the share link + preview into the Settings page's "Your public profile" card. "My profile" as a standalone menu item is gone.

### 2026-04-17 — Counter flow: recursive linked nodes, not mutation

A counter is a new `trade_proposals` row linked via `counter_of_id` self-FK to the proposal it counters. The original transitions to `'countered'` terminal state. Chains extend naturally (counter-of-counter is structurally fine, no depth cap for v1). Design rationale + alternatives in `PHASE4C_COUNTER_DESIGN.md`.

### 2026-04-17 — Counter DMs show a single decision point, not the full chain

Each DM focuses on "here's what's on the table now," with at most a one-line reference to the parent proposal. Full chain visualization (if ever needed) lives in the web detail view. Drops the Discord embed size concern (4096-char field limit) and keeps mobile DM reads clean.

### 2026-04-17 — Race guards on proposal transitions are optimistic-concurrency, not locks

`handleCounter` and `handleCancel` both gate their UPDATE on `WHERE status = 'pending'` and rollback their own inserts if the row count is 0. Simpler than row-level locking + works on Neon HTTP (which doesn't support multi-statement transactions in HTTP mode). Accepts a narrow window where a counter row might be inserted then deleted; acceptable.

### 2026-04-17 — `delivery_status` is a second axis distinct from `status`

`status` tracks the proposal's lifecycle (pending → accepted / declined / cancelled / expired / countered). `delivery_status` tracks whether the Discord DM actually landed (pending → delivered / failed). Separating them lets the UI say "saved but couldn't DM them — send them a message manually" without overloading the status enum.

### 2026-04-17 — Dual-key Ed25519 fallback for test-signed interactions

`api/bot.ts` verifies against the primary `DISCORD_APP_PUBLIC_KEY` first, falling back to `DISCORD_APP_PUBLIC_KEY_TEST` if set. Only Preview deploys have the test key; Production never does. Lets the signed-interaction e2e POST a synthetic button click through the real verification + dispatch pipeline without needing a real human Discord click (which Playwright can't generate). See upcoming quality bundle for the runtime env-gate that closes the "test key accidentally on prod" foot-shot.

### 2026-04-18 — Typed prefs registry with self/peer/guild scope cascade

User preferences are defined once in `lib/prefsRegistry.ts` with explicit `scope={self,peer,guild}` and `section={privacy,notifications,communication,membership}`. `lib/prefsResolver.ts` cascades peer override → viewer self column → registry default. Both the SettingsView drill-down and the Discord ⚙ Prefs button render from the registry, so adding a new pref is a single-place change. Rejected alternative: per-view prefs tables — would have required parallel UI + API + migration work for every new pref. Trade-off: one registry file becomes the canonical source of truth, any addition needs to think about all three scopes.

### 2026-04-18 — Silent-fail observability via typed errors + webhook alerts

Discord bot errors used to throw as generic `Error`s, making it impossible to distinguish "429 retry this" from "permission missing, alert the human" from "user's DMs are disabled, don't alert." `lib/discordErrors.ts` introduces a typed hierarchy (`DiscordRateLimitError`, `DiscordPermissionError`, `DiscordNotFoundError`, `DiscordValidationError`, `DiscordServerError`, `DiscordUnknownError`), `DiscordBotClient` auto-retries 429s once with capped sleep, and `lib/errorReporter.ts` posts real failures to a `#bot-errors` webhook (filtering test traffic + expected 404s + DM-disabled). Pattern emerged after the 1024-char embed-cap silent-fail bug (`f77dc51`) — we want the system to tell us when things break, not wait for a user report.

### 2026-04-18 — Bot-install outreach with one-tap Enroll

When the bot lands in a guild with existing SWUTrade users, those users get a DM invite with a one-tap Enroll button rather than being silently added to the guild's enrollment rolls. Two prefs gate it: `dmServerNewInstall` (default on — the outreach DM itself) and `autoEnrollOnBotInstall` (default off — whether to skip the DM and just enroll). Rationale: bot-install is a high-leverage moment — existing users are exactly the ones most likely to convert the server into an active trading community. "Delight the potential user with a magic experience."

### 2026-04-18 — Home view becomes the signed-in default landing

Signed-in users with a bare URL land on a Home page surfacing pending trades + enrolled communities + a Build-a-trade CTA, not the trade builder. Rejected alternative: keeping the builder as the default and adding a "Home" menu item. Builder-as-default made the signed-in experience indistinguishable from anonymous — no acknowledgment of user state, no visible pending proposals, no entry point to community. Signed-out users still land on the builder so the public share-URL experience is unchanged. Lists cap at 5 per section (with "See all N →" overflow to the full Trades history) to survive users with high pending volume.

### 2026-04-18 — Slack-style Settings drill-down with persistent Done button

Settings grew beyond a single scrollable page (profile + global prefs + per-server + per-server-member prefs). Rebuilt as a drill-down hub with query-param routing: `/?settings=1&tab=servers&guild=X&members&user=Y`. A persistent gold "Done" button in the header exits to the main app from any depth — direct response to beta feedback ("tapping back 5 times is bad UX"). Native popstate handles back/forward navigation.

### 2026-04-19 — Four IA surfaces: My Trades / My Lists / My Communities / My Stores

App organizes user-facing content around four parallel "my" surfaces, each getting its own hub + NavMenu entry + Home module. "My Stores" is the Phase 4 v2 LGS slot; it renders as a dim "coming soon" placeholder today so the layout is stable when LGS data lights up. Rationale: users ask different questions of each surface ("what do I have?", "who's around me?", "what's happening in my area?") — they deserve distinct first-class destinations, not tabs inside one catch-all. Drives Home 2.0's dashboard layout + NavMenu contents.

### 2026-04-19 — Home is a dashboard, not a content stream

Home 2.0 became four stacked modules + a pinned "Needs your response" callout, replacing the earlier "pending proposals + communities" two-column layout. Each module has the same shape: icon + name + secondary action + summary stats + 2-3 preview items + link-through. Desktop: 2-column pairing (action-surfaces left, resource-surfaces right) + full-width Stores footer. Mobile: single-column stack in priority order. Module pattern stays predictable even as modules grow — Phase 4 v2's LGS events slot into the Stores module without a layout rewrite.

### 2026-04-19 — "+ Balance a trade" vs. "Propose a trade" semantic split

Previously one "+ New trade" CTA led to the ad-hoc balance builder, and sending a Discord proposal was discovered only through profile CTAs. Renamed the primary CTA to "+ Balance a trade" (signals local/in-person/ad-hoc) and surfaced "Propose a trade →" as a secondary action inside My Communities. Rationale: balance-a-trade is the foundational flow (no recipient required, no Discord) + matches the product mission ("local/in-person is the goal; Discord augments"). Propose lives inside Communities because you can only propose to someone in your community. Future: in-builder "Send as proposal" CTA will close the conversion loop when a user balances cards first, then decides to send.

### 2026-04-19 — Community 2.0: guild is the unit, not a flat directory

CommunityView shifted from a flat cross-guild member directory (with sort tabs) to per-guild spaces with their own tabs (Overview · Members · Popular wants · Upcoming). Multi-guild selector when enrolled in >1; auto-redirects when exactly 1. Rationale: users visit Communities to do more than find trade partners — they want to see what's happening in their guild, who's new, what's popular. A flat list collapses those intents. Per-guild pages also let each guild grow its own identity over time (future custom LGS tag, pinned events, etc.).

### 2026-04-19 — AppHeader is chrome-only; view-specific CTAs live in content

Initial design-system work folded view-specific action slots (`actions={...}`) into the AppHeader's right cluster alongside NavMenu + AccountMenu. This created width competition when a long breadcrumb ("Home › Community › SWU SD") met a wide primary CTA ("Trade with @somehandle") on mobile. Separated the roles: AppHeader does logo + breadcrumbs + nav + account only. View CTAs render in content-level strips that each view can design freely (hero on Profile, tight right-align on Settings, inline toolbar on Trade builder, summary+CTA strip on ListView). Predictable chrome, flexible per-view actions.

### 2026-04-19 — React contexts for shared state, not prop drilling

Three new contexts replace the prop-drilling + per-view-hook-duplication that had accumulated: `PriceDataContext` (wraps `usePriceData`, auto-calls `loadAllSets` on mount — the motivating bug case), `CardIndexContext` (derives `byProductId` / `byFamilyAll` indexes so views don't thread them), `DrawerContext` (single shared ListsDrawer state + `openLists()` hook). Providers nest in `main.tsx` above `<App/>`. The ListsDrawer now lives at App root — no more "every view renders its own drawer" duplication. `percentage` / `priceMode` still prop-drilled (deferred to its own slice — low urgency, moderate-value extraction).

### 2026-04-19 — API shape: discriminated ActionResult across all hooks

`src/services/apiClient.ts` exposes `apiGet` / `apiPost` / `apiPut` / `apiDelete`, each returning `ActionResult<T> = { ok: true; data: T } | { ok: false; reason: '...'; detail?: string }`. Status → reason mapping is centralized: 409 → `already-resolved`, 429 → `rate-limited` with `nextAvailableAt`, 404 → `not-found`, 403 → `forbidden`, 401 → `unauthorized`, else → `error`. 11 hooks migrated off inline `fetch + res.ok + JSON.parse + setState` to this pattern. Rationale: each new endpoint was reinventing the error branches; callers couldn't tell a 429 from a 404 from a 500 without parsing error messages. Pattern originated in `tradeActions.ts`; now shared.

---

## Parked technical improvements

### Decouple price refresh from deploys

**Today:** Prices are baked into the build (`public/data/*.json`). A 2h GitHub Actions cron pokes a Vercel deploy hook with `?buildCache=false`. Each refresh = a full ~5min production deploy.

**Better:** Move price data into Vercel Blob (or KV) and have a Vercel Cron Job hit `/api/refresh-prices` to rewrite it. App reads from the live store. No redeploys for price updates; updates propagate in seconds.

Sketch:
- `api/refresh-prices.ts` runs the fetch logic, writes each set's JSON to Vercel Blob (`access: 'public'`)
- App fetches from `https://<store>.public.blob.vercel-storage.com/data/{slug}.json`
- `vercel.json` cron: `{ path: '/api/refresh-prices', schedule: '0 */2 * * *' }`
- Delete `.github/workflows/refresh-prices.yml`

### Leader card images are portrait-padded

TCGPlayer serves all card images as 5:7 portrait. Leaders are landscape in-game, so their portrait-padded thumbnails get cropped when rendered in landscape tiles. swuapi exposes `frontImageUrl` which might be the real landscape image; worth investigating when we do another visual pass.

### In-app QR scanner

QR display and Web Share API shipped. Parked: in-app recipient-side scanner using `BarcodeDetector` (Chromium solid, Safari partial) so recipient can tap "Scan a list" inside SWUTrade instead of bouncing to their camera app. Nice-to-have; external camera apps already work for our URLs.

### Foil variants for SOR / SHD / TWI

TCGPlayer split foil into its own product SKU starting with SEC, so Foil / Hyperspace Foil / Prestige Foil are first-class variants for SEC+. The first three sets (SOR, SHD, TWI) still use a "foil toggle" on the same product — both printings share one productId. Emitting a second `CardVariant` per dual-print card requires folding `printing` into dedup keys everywhere. Half-day task; park until requested.

### Price movers + history

**Today:** point-in-time only — the app knows current price but not trend.

**Infra:** `price_snapshots` table populated by the price-refresh cron. Neon free tier handles ~2.5M rows/year.

**Features unlocked:** biggest gainers/losers (empty-state), price sparklines (card rows), collection value tracker, price alerts (Discord DM via Phase 4 bot).

### Other pending UX notes

- Allow replacing cards in trade list (in-place edit)
- Creator credit footer refinement
