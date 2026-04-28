# Changelog

Release notes for production cuts. Dates match the git tag (`v<date>-stable`) on `main`. Not every commit lands here — just the user-facing shape of each release.

## v2026.04.28-stable — 2026-04-28

Largest release since the foundation pass. SWUTrade is no longer a personal trade-balance calculator — it's a multi-user trading platform with shared live trades, Discord-account proposals, community discovery, and explicit trading-partner bookmarks. Twelve days of Phase 5b work + a full UX cohesion wave on top, condensed.

### Live shared trades (Phase 5b)

Two players can now build a trade together in the same browser session. One creates an "open invite" and shares a QR / URL; the other scans / clicks and joins immediately — no Discord account required for either side.

- **QR / share-link invitations.** Tap "Invite someone" in the trade builder; a session URL is minted on the spot with a scannable QR for in-person trading at the LGS. The other player can claim as an existing SWUTrade user, an existing Discord-signed-in user, or a fresh anonymous guest.
- **Both sides edit live.** Each player owns one half of the trade canvas. Edits sync via short polling; a cyan "@alex made changes" nudge pops if the counterpart edits while you're not watching the canvas.
- **Confirm → settle handshake.** Both players have to tap Confirm to lock the trade in. The first confirmer's side flips read-only with a prominent "🔒 You've confirmed" strip; an explicit **Unconfirm to edit** button is the only way out so accidental qty bumps can't silently invalidate a confirmation. When the second player confirms, the session settles and the canvas locks on both sides.
- **Cancel / expire.** Either side can cancel an active session at any time. The terminal banner now carries an escape link ("Back to your trades" for signed-in users; "Back to home" for guests) so a cancelled trade isn't a dead end.
- **Invite by Discord handle.** Open invites can also DM the URL to a known SWUTrade user via Discord. Useful when the other player isn't physically present but you know who you want to trade with.
- **Active sessions surface in My Trades.** Sessions and proposals share the same row chrome on the My Trades surface; the unified stream reads as one "incoming + outgoing + settled" timeline.

### Wishlist / Trade Binder split

The "My Lists" drawer used to conflate two distinct concepts (cards you want to acquire vs. cards you have to trade) behind shared tabs labelled with internal vocabulary ("Wants" / "Available"). Each is now its own first-class surface.

- **Dedicated views.** `?view=wishlist` and `?view=binder` render full-page editors, accessible from the new Home modules and from NavMenu's "My Wishlist" / "My Trade Binder" entries.
- **Vocabulary reconciled.** User-facing copy is **"Wishlist"** and **"Trade Binder"** everywhere — schema names (`wants` / `available`) stay internal. The drawer's tabs swapped to match.
- **Per-list share images.** When you share just your wishlist, the image is titled **"WISHLIST"** with a single full-canvas list of the cards you're hunting (priority stars displayed). Trade Binder shares get a parallel **"TRADE BINDER"** treatment. The combined "share both" image (the drawer's button) is unchanged.
- **In-trade-builder drawer retained.** A new "Lists" button in the trade-builder action strip opens a slim quick-edit drawer. Doesn't disrupt your in-progress composer state — the Lists drawer is the only path for "I just realized I have this card; let me add it to my binder" mid-trade.

### Trading Partners (favorites)

Bookmarking layer for the Discord-friend-no-shared-server case. You can now trade with anyone on SWUTrade without needing a mutual bot-installed Discord guild, and you can pin people you trade with often.

- **Star toggle on every public profile.** Visit `/u/<handle>` and tap the bookmark icon to add them to your trading partners. Independent of community enrollment.
- **"Your Trading Partners" Home module.** Up to 6 favorites with avatar + handle + a one-tap **Trade** button that lands you in a propose-to-them composer.
- **HandlePickerDialog integration.** When you tap "Send proposal" in the trade builder, your favorites surface as a gold-accent chip row above "Recent" partners. Star toggles inside the dialog let you favorite community members in one tap without leaving the flow.
- **Copy invite link.** Your own profile (`/u/<your-handle>`) now has a "Copy invite link" button that puts `?propose=<your-handle>` on the clipboard. Paste in any Discord channel to drop friends straight into a propose-to-you composer.
- **Copy trade link on send.** After sending a proposal, a "Copy link" button next to "View your trades" gives you a direct trade-detail URL. When Discord DM delivery fails (recipient not in any bot-installed server with you), the affordance becomes prominent gold so the manual handoff is the obvious recovery action.

### Two-state user model

Anonymous "ghost" sessions used to look like a separate user state — visible "Sign out" button, gold "you're signed in as a guest" banner, ghost-specific home view. From the user's POV there are now exactly two states: **guest** (no Discord account; could be signed-out or have an internal session cookie) and **Discord-signed-in**.

- **AccountMenu** shows the same guest variant for signed-out and ghost users — Sign in with Discord + Show tutorial. No Profile / Settings / Sign out.
- **NavMenu** splits gating into two axes: "My Communities" requires a real Discord account; "My Trades" works for anyone with a session (so ghosts can still reach in-flight shared trades from the hamburger).
- **GhostHomeView deleted.** Ghosts default to the trade builder. Even an explicit `?view=home` from a ghost falls through to the trade builder.
- **Ghost → Discord-account merge stays seamless.** When a ghost signs in, their in-flight sessions migrate to the new account row server-side; a one-shot gold "We carried your trade with @alice over" banner confirms.

### Home dashboard

New 2×2 + partners layout. Replaces the prior single-column module stack.

- **Row 1**: 💱 My Trades · 👥 My Communities
- **Row 2**: ⭐ Your Wishlist · 📘 Your Trade Binder
- **Row 3**: 🤝 Your Trading Partners
- **Pinned at the top**: ⏰ "Needs your response" callout when there are open incoming proposals.

The old "My Stores" Phase-4 placeholder was removed — reserving dim chrome for an unshipped feature wasn't earning its space.

### Communities

Community pages got their own structure. Visit `/?community=1` to see your enrolled servers; click in for member directory, popular wants, activity feed, and (placeholder) upcoming events.

- **Per-guild member directory** with overlap chips ("You can offer 3 of 12") that quantify trade potential at a glance.
- **Activity feed** showing recent trades + new-member events across the guild.
- **Popular wants** aggregated from the guild's enrolled members so you can see what's in demand.
- **Bot-install outreach.** When the SWUTrade bot lands in a new Discord server, existing members get a polished invite DM with a one-tap Enroll button.

### Trade composers + proposal flow

- **Single PrimaryActionBar** at the bottom of the trade builder unifies the four prior composer-bar mutexes (Edit / Counter / Propose / AutoBalance). Send / Save / Confirm always lands in the same place; the per-mode bars now carry only informational content.
- **Response buttons regrouped.** A pending proposal's recipient-side actions split into two intent groups: "Move forward" (Accept · Edit together) in cyan; "Push back" (Counter offer · Decline) in muted gray.
- **Counter offers flip sides automatically.** When you counter a proposal, the composer pre-loads with the offering / receiving sides swapped and a banner reminds you: "Sides are flipped — you're now offering what they asked for."
- **Edit together promotion.** "Accept as-is" and "Edit together" sit side by side; the latter promotes a proposal into a live shared session for negotiation.
- **Nudge** — re-DMs a pending proposal with a 24h cooldown and an optional 280-char note prepended as a gold-bordered embed.

### Mobile + visual polish

- **Haptics** with `prefers-reduced-motion` respect on every primary tap (Confirm, Cancel, Send proposal, Cancel session, etc.).
- **44×44 minimum tap targets** across the trade builder, lists, and modals.
- **Muted side-identity chrome** — `TradeSide` panel borders no longer compete with gold CTAs and state badges. Side identity reads through a thin saber bar + a pale tint chip behind the OFFERING / RECEIVING label.
- **Origin-aware "Back" breadcrumb on profiles** — landing on `/u/<handle>` from My Trades vs Community vs a trade detail now lands you back where you came from instead of always dumping to Home.

### Tutorial + onboarding

- **First-run tutorial replaced auto-firing tour with an opt-in glowing help button.** The `?` icon in the header pulses for users who haven't seen the tour; tap to start. Tucks itself away after dismissal. AccountMenu's "Show tutorial" entry stays as the persistent revisit path.
- **Three-step coachmark tour** anchored to the actual trade-builder UI: welcome / add cards / sign in with Discord.

### Reliability + bug fixes

- **Cancel on open-slot session now actually shows.** Cancelling a "waiting for counterpart" session used to leave the QR card on screen even though the DB row was cancelled (the openSlot flag derived purely from `userBId === null`, ignoring status). Fixed.
- **Greeting buttons clickable on first paint.** History + "+ New trade" no longer wait for `/api/auth/me` to resolve before rendering.
- **Picker search auto-focuses every time it opens** (not just on the very first mount of the page).
- **Filter clarity.** The picker's collapsed filter chip stops lying about active filters — when "Special" is the active set preset, it reads "Special" instead of being buried after a misleading "All cards · Any variant ·" prefix. Active filters get a stronger gold tint, a count badge, and an inline "Clear" button.
- **Picker / list / profile prices pinned to raw 100% TCGPlayer.** The percentage modifier (default 80%) only applies inside the actual trade balancer now. Cross-referencing card prices against TCGPlayer doesn't require mental division anymore.
- **Forward-nav scroll reset.** Clicking "Edit trade binder →" from a scrolled Home no longer lands you mid-page on the new view. Browser Back / Forward still restores native scroll position.
- **Share-list image with deflate-compressed URLs.** Earlier compression of share-list URLs accidentally broke the OG-image renderer's decoder; signed-out share-image previews are showing rendered cards again. New cross-boundary codec test guards against future drift.

### Internal — invisible to users but worth recording

- **268 commits** since `v2026.04.16-stable`.
- **Subsystem wiki** at `docs/wiki/` — ten area pages (sessions, proposals, trade builder, lists, home/nav, community/profile, auth, cards/pricing, Discord bot, infra) plus an architecture overview. Living documentation; updated in the same commit as non-trivial changes to its area.
- **Shared `lib/listShareCodec.ts`** — single decoder source of truth for shared-list URLs across client + server, replacing the parallel decoders that had drifted.
- **Schema migrations 0010 → 0019** applied to Neon: shared-trade sessions table, session events, ghost-user flag, community events, user peer prefs, favorite-partner table.
- **Drizzle journal in lockstep with `lib/schema.ts`** — `npm run db:generate` produces the SQL migration + snapshot together; `db:migrate` applies to the configured DB.
- **`useTutorial` simplified** — auto-fire effect deleted, no more `isSignedIn` / `suppressAutoOpen` plumbing. Hook exposes `hasBeenSeen` for AppHeader to drive the help-icon glow.
- **dev-seed-community script removed** — beta has organic users now; the synthetic droids cluttered the community directory and the reporter had to filter out their non-snowflake user IDs from `#bot-errors`. Cleanup includes the runtime filter prefix.
- **CI**: vitest `testTimeout` bumped to 15s to absorb Neon latency spikes that flaked api integration tests at the 5s default.

## v2026.04.16-stable — 2026-04-16

Foundation-hardening pass before Phase 2 (accounts + sync). No new user-facing features — the scope was code quality, data integrity, test coverage, and component architecture. Everything below is internal.

### Data integrity
- **34 duplicate product rows removed** from the TCGPlayer fetch pipeline. Cards that appeared twice in the picker grid (e.g., Luthen Rael in SEC) are now deduped at ingest with a build-time uniqueness guard.
- **Gold and Rose Gold** variants recognized as first-class print variants (42 SEC cards promoted from gray "unknown" pills to yellow / rose pills). Appended to `CANONICAL_VARIANTS` — existing share-link bitmasks stay backward-compatible.
- **SRP / OPP regional-prize cards** relabeled: numeric parentheticals like `(77)` collapse to a teal "Regional" pill; tournament-placement labels (Champion, Finalist, Top 4/8/16, Day 2) get a shared violet pill. Previously rendered as unlabeled gray unknowns.
- **Enrichment** gained a name-based fallback for sets where TCGPlayer ships empty collector numbers (SECW). Match rate: 93.58% → 94.16% (+40 cards). A regression guard now fails the build if any mapped set drops to 0% enrichment.
- **Share URLs compressed** via deflate + base64url (`fflate`). A 20-card wants list goes from ~1200 chars to ~530 chars (57% reduction). Old uncompressed links still decode correctly.

### Bug fixes
- **`pct=999` in URL** no longer inflates prices 9.99x — `parseTradeUrl` now clamps the percentage to [1, 100].
- **Trade qty stepper** capped at 99 — clicking + past 99 previously went to 100, 101, etc.
- **Search query misrouting** fixed: promo-set slug words like "of", "the", "force" were auto-aliased to set codes, so the swap-variant flow's seeded query "Luke Skywalker - Hero of Yavin" routed to Ashes of the Empire and returned nothing. Aliases now restricted to unambiguous set codes + 2 hand-curated overrides.

### Test coverage
- **74 → 143 unit tests** across 5 new test files. Load-bearing pure logic extracted from hooks into testable reducers: `wantsAddReducer`, `availableAddReducer`, `toggleSetReducer`, `replaceGroupReducer`. `applySelectionFilters`, `browseAllGroups`, `parseQuery`, and `localSearch` now have dedicated suites.
- **17 Playwright e2e specs** added, covering: app boot, search + set-code aliases, trade flow + qty stepper + URL roundtrip, swap-variant kebab, shared-list landing → start-trade handoff → source-chip activation, curator build-and-share (clipboard round-trip), wants dedup through the UI, drawer interactions (tab switch + restriction editor + priority toggle + remove), qty-aware source chip, and mobile viewport sanity at 390×844.
- **E2e wired into CI** via a new GitHub Actions workflow with weekly-cached card data so fetch-prices only hits TCGPlayer once per ISO week. Playwright browser cached per lockfile hash.

### Component architecture
- **`TradeSide.tsx`** reduced from 838 → 393 LOC (−53%) via three extractions:
  - `TradeRow` — trade-panel card row (thumbnail, variant pill, spread badge, qty stepper, kebab menu).
  - `TradeSearchOverlay` — full-screen card picker with encapsulated `useCardSearch`. Parent communicates via `open/onDismiss` + declarative `seed` prop (matches the existing `autoOpenSharedLink` one-shot convention). Source chips generalized to `SourceChipConfig[]` so Phase 3/4 can add new sources without overlay edits.
  - `VariantBadge` — single source of truth for variant-pill chrome, collapsed from 4 inline duplicates.
- **Filter chip groups** (`VariantChipGroup`, `SetChipGroup`) shared between the trade overlay's `SelectionFilterBar` and the shared-list `ListView`. ListView's set-filter mutual-exclusion semantics unified with the trade overlay (group presets now clear individual chips, matching the hook's `replaceGroupReducer`).
- **`formatPrice`** deduplicated from 3 inline copies into `priceService.ts`.
- **`PickerTile`** gained an `aria-label` so screen readers (and e2e tests) can identify each tile in the drawer picker.

### CI / build
- **Refresh-prices cron** now checks the deploy hook's HTTP status and fails the workflow on non-2xx, so a rotated or revoked `VERCEL_DEPLOY_HOOK` secret can't silently succeed while prices go stale.

## v2026.04.15.2-stable — 2026-04-15

Adds in-person and native share surfaces to the lists drawer.

### Unified Share menu
- The drawer's separate "Link" and "Image" buttons consolidate into one **Share** action that opens a popover with every channel under one roof:
  - **Copy link** — same behavior as before.
  - **Share via…** — invokes the OS share sheet via `navigator.share` (AirDrop on iOS, Nearby Share on Android, Messages, WhatsApp, etc.). Hidden on desktop browsers that don't implement the API.
  - **Save as image** — same OG-image render flow, now inside the menu.
  - **Scan to open** QR code at the bottom of the popover so a nearby player can scan with their stock camera app — no install, no permissions, cross-platform.

## v2026.04.15.1-stable — 2026-04-15

Same-day follow-up focused on the shared-link receiving experience and the trade-side picker's sidebar real estate.

### Shared-list landing view
- Rewritten as a compact row layout — tiny thumbnail, name, set code, variant pill, qty, price per row — so a recipient can scan a long list without pagination.
- Ephemeral filter controls (text search + Variant + Set) to let recipients narrow to the subset they care about.
- Wants that carry a multi-variant restriction surface the whole restriction on the row (e.g. `HS / HSF / Std`) rather than just the cheapest-matching rep.

### Start-a-trade handoff
- Clicking "Start a trade" from a shared-list link now drops the user straight into the Offering side's search overlay with the "They want" source chip pre-activated — so the sender's wants are already the grid's contents.
- Variant / Set filters reset on this handoff so a persisted filter from an earlier session can't accidentally zero out the shared list.

### Trade picker: source chips replace sidebar sections
- The "From your Available" and "From the shared link · They want" collapsibles are gone. Their contents now flow into the main grid via two pill-toggle chips above the filters:
  - Offering side: **My available** · **They want**
  - Receiving side: **My wants** · **They have**
- Each chip carries a remaining-qty count (items still pending after what's already been added to this side of the trade) and auto-deactivates when that count hits zero.

### OG image
- Link-preview layout switched from a grid of card tiles (~6 per column) to a dense row list (~18 per column). Matches the web list view so the preview and the landing page look like the same thing.

### Polish
- Lazy-loaded card images use `alt=""` so the alt text doesn't flash in as tiles scroll into the virtualized viewport.

## v2026.04.15-stable — 2026-04-15

The Wants / Available lists feature fully lands, plus a picker rewrite and several rounds of filter/mobile polish. First post-baseline release since `v2026.04.14-stable`.

### Anonymous list sharing
- Build Wants and Available lists locally; share as a copyable link or a rendered OG image.
- Shared links open to a dedicated list view with a "Start a trade" CTA that carries the lists into the main trade UI.
- Link-preview metadata (Discord/Slack/iMessage) generated by `/api/og` for both trade shares and list shares.

### Picker rewrite
- Empty search shows every matching card in browse mode (set + card-number order, leaders/bases sunk to the end of each set) instead of a "type a card name" blank state.
- Virtualized grid via `@tanstack/react-virtual` keeps the picker snappy even with a thousand visible tiles.
- Tap a saved tile's `×N` badge to decrement or remove — no need to close the picker to undo a mistap.
- "Back to list" close, Esc-to-collapse, and search-input select-all on focus wire the type → tap → type → tap batch flow mobile users want.
- Add Card footer moved to the bottom of each trade panel, color-coded to the side.

### Filter redesign
- Variant and Set filters live in collapsible chip bars with per-surface persistence (trade search and picker remember their own selections independently).
- Set presets (All / Main / Special) are a mutually-exclusive three-way switch that clears any individual set chips; individual chips likewise clear the preset. No more redundant combinations.
- Sticky set header at the top of the scroll grid so you always know which set you're looking at.

### Wants variant UX
- Per-tile restriction badges surface exactly what a tap saves — one pill per selected variant in its own color, or a gold "Any" pill when no filter is active.
- The variant-restriction editor on saved Wants only offers variants that actually exist for that card family (a Pyke Sentinel no longer shows Prestige / Serialized / Showcase chips).
- Shared abbreviated chip labels ("HS Foil", "Pres Foil") across the picker and the editor.
- Available picker hides the variant filter entirely — every tap there commits an exact printing.

### Mobile polish
- Compact top bar: "My Lists" label shows alongside the icon on mobile, price pill stacks Mkt/80% vertically, TCG prefix dropped.
- Wants / Available tabs and their Add Card buttons color-coded to match Offering (emerald) and Receiving (blue) for cross-surface consistency.
- Wants-row variant editor is taller with larger tap targets and a dedicated close X.
- Lists sections in the trade search overlay default to collapsed with a tinted count badge so they don't eat the main grid's real estate.

### Data hygiene
- Enrichment now drops non-card SKUs (booster boxes, spotlight decks, prerelease kits) and resolves token/leader id collisions (Gar Saxon no longer appears under "Experience", Qi'ra no longer under "Shield").
- Card families merge by enriched `displayName` so TCGPlayer name typos (Cad vs Cade Bane) show as one card with all variants.

### Known parked work
- Foil / Hyperspace-Foil variants for SOR / SHD / TWI — those sets use TCGPlayer's foil toggle instead of separate SKUs; wiring them up needs a productId dedup-key change. See the roadmap.

## v2026.04.14-stable — 2026-04-14

Stable baseline before Wants / Available lists feature work.
