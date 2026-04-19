# NEXT.md — Sequenced work queue

The single source of truth for **what ships next**. Updated as slices complete.

ROADMAP.md owns the long-term vision; this file owns the short-term execution order. If they drift, this file wins for "what are we doing right now."

---

## How we use this

- One **Active** slice at a time (section below). Move a slice there when we start it.
- **Queue** is strictly ordered. Top-to-bottom is the work order unless the user re-prioritizes.
- Each slice lists explicit done criteria — don't call one complete until every box is ticked.
- After finishing a slice, run the **Between-slice ritual** before starting the next.

## Between-slice ritual

Before starting the next slice:

1. **Last CI green?** `gh run list --branch beta --limit 1 --json conclusion,status`. If failure, fix that first. If in-progress, wait. (Locked-in rule from `feedback_check_prior_ci` memory.)
2. **Local clean**: `npx tsc -b --force` exits 0.
3. **Tests pass**: `npx vitest run` all green.
4. **Coverage for the shipped slice**: new integration + (where applicable) e2e tests exist for every new endpoint, state transition, or user-facing surface introduced.
5. **Memory updated** if any pattern / gotcha worth remembering turned up during the slice.
6. **Roadmap updated** if shipping changed Phase status or introduced a new design decision.
7. **Mark slice complete** in the Done section below with the date + commit range.

Skipping any of 1-3 is a bug in the process.

---

## Active slice

*(none currently — pick next from the queue)*

---

## Queue

### 1. Dogfood pass on the refactored stack

**Why:** Today's foundation refactor (R1 contexts + R2 routing config + R3 API client + R4 composer hook + header separation) is a deep-structure change. Unit tests + auth e2e pass, but subtle visual / interaction regressions are the kind that only surface under a real human click-through. Catch them while the architecture is fresh in memory.

**What to look for:**
- AppHeader's new chrome-only shape: does it feel right on every view?
- View-level action strips: do Profile hero, Settings Done, Trade-builder toolbar, ListView summary all feel balanced?
- Card name resolution: wants/available drawer rows must show real names (the bug that motivated R1)
- NavMenu popover opens/closes cleanly on every view
- Breadcrumbs truncate correctly at 375px viewport
- Home 2.0 module density on desktop — any awkward empty sections

**Done when:**
- [ ] Ran through Home, Community, Settings, Profile, ListView, TradeDetail with a real signed-in account
- [ ] Caught papercuts logged as their own tasks or fixed same-slice
- [ ] Between-slice ritual passes

---

### 2. Copy + context fixes *(Foundation bundle, part 5)*

**Why:** Many small clarity wins bundled: Discord DM text is third-person and confusing on first read, the Counter button label is ambiguous, post-send navigation goes to the wrong destination, landing-page empty state has no explanation, CounterBar drops users cold into a composer.

**What ships:**
- `lib/proposalMessages.ts`: field names "They're offering" → "You would receive", "They're asking for" → "You would give" (recipient-first framing).
- `lib/proposalMessages.ts`: Counter button label "Counter" → "Counter offer".
- `src/components/ProposeBar.tsx` + `CounterBar.tsx`: post-send primary link "Back to community" → "View your trades" (→ `/?trades=1`), keep community as secondary.
- `src/components/CounterBar.tsx`: context banner on mount — "Responding to @X's proposal. Sides are flipped — you're now offering what they asked for. [View original]". Dismissible with localStorage.
- `src/App.tsx` (or wherever the trade view's empty state renders): one-line subtitle on empty state explaining the two-panel trade model.
- `src/components/AccountMenu.tsx`: sign-in popover copy reframed to lead with community/trade, not "sync".
- `src/components/SettingsView.tsx`: 1-line note on EnrollableGuildCard explaining the bundled toggle behavior when enrolling.

**Done when:**
- [ ] All copy changes in place, spot-checked in the running app.
- [ ] CounterBar's new banner dismissible, remembered via localStorage.
- [ ] propose.auth e2e + trades-history e2e updated if any assertions referenced changed text.
- [ ] Between-slice ritual passes.

**Pointers:** UX_REVIEW CU1, CU2, CU3, CU4, CU7, CF6, CF7.

---

### 3. Test-file dedup *(Foundation bundle, part 6)*

**Why:** `makeFakeBot()` is defined in 4 test files, each slightly different. Proposal-row seeding helpers are in 4 test files, each slightly different. A schema change to `trade_proposals` or the bot interface becomes an N-file fan-out. Consolidation is small, one-shot, pays off immediately on the next schema touch.

**What ships:**
- `tests/api/discordFakes.ts` — `createFakeDiscordBotClient(opts?: { sendFails?, editFails?, sendResponse? })`. Canonical. 4 in-file variants deleted.
- `tests/api/fixtures.ts` (or extend `tests/api/helpers.ts`) — `seedTradeProposal(overrides?) → { id, cleanup }`. The cleanup is returned bound to the id at creation time, so failed inserts never leak (fixing the fragile `createdIds.push(id)` pattern).
- Migrate all existing call sites; delete the local copies.

**Done when:**
- [ ] All 4 test files import from the shared fakes/fixtures.
- [ ] `git grep 'function makeFakeBot'` returns one match (the shared file).
- [ ] Full vitest suite green.
- [ ] Between-slice ritual passes.

**Pointers:** CODE_REVIEW A7; TEST_REVIEW 1, 2, 5.

---

## Later (unscheduled, priority order)

Items that didn't make the Foundation bundle cut but should land before Phase 4 v2 / Phase 5 work resumes.

### Community activity feed *(Community 2.0 follow-up)*

C1 shipped the guild-scoped shell with an Overview tab containing a "Community activity coming soon" placeholder. Real activity feed: `community_events` table keyed on `guild_id + created_at` with event types (trade-accepted, member-joined, list-updated). Read via `GET /api/community/:guildId/activity`. Privacy: add a new consent axis (`shareActivityPublicly`) parallel to the existing three — opt-out default, visible toggle in Settings > Discord servers > Guild. Per-user can hide their own events from the feed. Pairs naturally with the existing `proposal_events` table since trade-accepted data is already logged there.

### Handle-picker dialog improvements

Home 2.0's "Propose a trade" flow opens `HandlePickerDialog` today. Deferred improvements: (a) allow typing a handle that isn't in any shared community (just verify it exists + isn't private), (b) pull recent trade partners to surface as a "Recent" chips row above the typed-handle input, (c) empty-state hint pointing into Community when the user has no enrolled guilds.

### In-builder "Send as proposal" CTA

When a signed-in user has cards on both sides of the trade builder (not via `?propose=` — just ad-hoc balance), surface a small "Send as a proposal to @…" CTA that opens HandlePickerDialog pre-seeded with the current cards. Closes the "I balanced it, now I want to send it" conversion loop. Small UI tweak plus a reuse of the handle-picker.

### `percentage` / `priceMode` prop drilling → context *(audit action item)*

`percentage` + `priceMode` are persisted via `usePersistedState` in App.tsx then drilled through ~8 components (TradeSide×2, ProfileView, ListView, CounterBar, ProposeBar, EditBar, TradeBalance, TradeTabBar). Extract a `PricingContext` sibling to the R1 contexts. ~2 hours. Wait until there's a third symptom — the audit flagged this as medium priority, so no rush.

### Client-side error reporter *(audit action item)*

Server has `lib/errorReporter.ts` posting to `#bot-errors`. Client has no equivalent — view-layer failures silently console.warn (e.g., `TradeImageModal`). Add a `src/lib/clientErrorReporter.ts` that POSTs to a `/api/errors/client` endpoint (new) which funnels to the same Discord webhook tagged `client`. Hook it to a React `ErrorBoundary` at App root + expose as a `reportClientError()` helper for explicit catches. Low urgency until real users start hitting runtime errors we can't see.

### Proposal transition pattern extraction

`handlePropose`, `handleCounter`, `handleCancel`, `handleEdit`, `handleNudge`, and `resolveProposal` (accept/decline) now share a well-established pattern: "load proposal → auth check → precondition check → optimistic-concurrency update → edit source DM → send outbound DM." Extract `executeProposalTransition(opts)`. High ROI once a 7th transition shows up (expiry cron counts as one — tackle this alongside).

### Proposal expiry cron

Proposals sit `pending` indefinitely today. A Vercel Cron Job at `/api/jobs/expire-proposals` runs daily, transitions rows older than N days (30 to start) to `expired`, edits their DMs to show the expired banner. Needs a new cron entry + a handler that matches the propose/cancel state-transition pattern. Small, self-contained, completes Phase 5's terminal-state list.

### Tier 2 nightly Discord contract probe

Real-Discord API health check on a nightly schedule. Hits a narrow set of endpoints (`/users/@me` with the bot token, `/gateway`) + a canonical `POST /channels/{id}/messages` to a dedicated test channel. Diagnostic only — issue-opens on failure, doesn't block merges. Stand up once the bot has real user traffic so we're not monitoring a pipeline that isn't carrying cargo.

### Chain visualization timeline

Trade detail view currently shows one-hop chain context (↑ counter to / ↓ countered by). A proper timeline walking the FK chain back to the root. Defer until chain depth > 2 actually happens in the wild — right now a timeline would only show two nodes.

### Keyboard shortcuts on Home

Dashboard-app pattern: `G T` → trades, `G L` → lists (opens drawer), `G C` → community, `N` → new balance. Nice-to-have polish; low priority until beta users explicitly ask.

### Phase 4 v2 proper

LGS directory, visit announcements, meetup-aware matching, match-alert DMs. See ROADMAP.md Phase 4 v2 for scope.

### Phase 5b — Live trade sessions

Separate-flow in-person collaborative trading. See ROADMAP.md Phase 5b for scope + data-model sketch.

---

## Done

*(append here as slices ship)*

### 2026-04-19 — Header chrome / action separation
Commit: `e1efcab` + `b0583c2`. Removed the `actions` prop from AppHeader; view-specific CTAs (Trade with @X, Done, split/tabbed toggle, Share/Clear, Start a trade) moved to content-level strips per view. Biggest UX win: ProfileView's "Trade with @X" now renders alongside the avatar + handle as a hero, not as a squished header button fighting breadcrumbs for width. Settings drill-down gets a tight right-aligned Done strip. Trade builder gets its own action row. ListView merges summary + primary CTA into one strip. AppHeader is now *chrome only*: logo, breadcrumbs, NavMenu, AccountMenu.

### 2026-04-19 — Foundation refactor (R1 + R2 + R3 + R4 in one day)
Four parallel slices landing the architectural audit's top findings in under 24 hours.

**R1 — contexts (`a0c0e6d`):** `PriceDataContext` + `CardIndexContext` + `DrawerContext` replace the per-view `usePriceData()` instances + prop-drilled `byProductId`/`byFamilyAll` + each view's own `listsDrawerOpen` state. Providers wrap App in `src/main.tsx`. Single `<ListsDrawer>` lives at App root. **Net −56 LOC across 9 files**, and the entire class of "view forgot to call `loadAllSets()`" bugs goes away (the motivating case: yesterday's ListsDrawer-rendered-raw-familyId-slugs bug on HomeView).

**R2 — route config (`ff79c13`):** New `src/routing/config.ts` with a `VIEW_ROUTES` array. Each entry declares its `matches()` predicate + owned `paramKeys`. `detectViewMode(isSignedIn)` loops the array. `useTradeUrl`'s strip-guard chain now consults the config's `STANDALONE` view list instead of hand-maintained `if (currentParams.has('profile')) return` branches. Drill-down helper for Settings/Community was evaluated but skipped — the two shapes differ enough that shared abstraction would save 15 lines while complicating CommunityView's single-guild auto-redirect effect. Shared `TRADE_CODEC_KEYS` + `TRADE_INTENT_KEYS` exports.

**R3 — API client (`9645170`):** New `src/services/apiClient.ts` with `apiGet<T>` / `apiPost<T>` / `apiPut<T>` / `apiDelete<T>` returning `ActionResult<T>` — same discriminated-union pattern `tradeActions.ts` already pioneered, now shared. Status→reason mapping (409 `already-resolved`, 429 `rate-limited` with `nextAvailableAt`, 404 `not-found`, 403 `forbidden`, 401 `unauthorized`, else `error`). Migrated 11 hooks: useTradesList, useGuildMemberships, useTradeDetail, useAccountSettings, useCommunityMembers, useRecipientProfile, useCommunityCards, useTrending, usePopularWants, useAuth, useServerSync. Tricky cases: needs-reauth 409 branch in useGuildMemberships (maps to `already-resolved` → custom banner); useServerSync wraps apiClient in a thin helper that re-throws `auth-expired` for the surrounding try/catch.

**R4 — `useComposerBar` hook (`c141e2c`):** ProposeBar / CounterBar / EditBar shared ~70% of logic (send state machine, card snapshot builder, message input disclosure, error mapping). Extracted to `src/hooks/useComposerBar.ts`. Each bar keeps its own mount-fetch + seed-once pattern (fetch shapes differ too much to share), but the tail end is one hook. Net: CounterBar −28 LOC, EditBar −30 LOC, ProposeBar −59 LOC across the three components. Discriminated `ComposerSendState` carries optional `deliveryStatus` so the "saved but DM failed" branch still works for Propose + Counter. Uses R3's `apiClient.apiPost` internally.

### 2026-04-19 — Community 2.0 guild-scoped spaces
Commit: `548198d`. CommunityView restructured from a flat member directory into per-guild pages with tabs (Overview · Members · Popular wants · Upcoming). Multi-guild selector when enrolled in >1 (auto-redirects when enrolled in exactly 1). Breadcrumb: `Home › Community › <guildName>`. URL routing: `?community=1&guild=<id>&tab=<slug>`. Overview tab has activity-feed placeholder + "Your matches here" top-3 preview with a link into Members. Popular wants tab renders aggregated wants from the existing community-cards endpoint. Upcoming tab is LGS placeholder. Pairs with `memberCount` now on `/api/me/guilds` (`db6b164`).

### 2026-04-19 — Home 2.0 four-module dashboard
Commit: `01cf623`. Restructured HomeView from a two-column pending-mailbox + communities layout into a four-module dashboard:
- ⏰ Needs your response (pinned callout, only when count > 0)
- 💱 My Trades with recent activity from `proposal_events`
- 📋 My Lists with top priority wants preview
- 👥 My Communities with enrolled guild cards
- 🏪 My Stores (Phase 4 v2 placeholder)

Desktop: 2-column grid pairing action-surfaces (left) with resource-surfaces (right) + full-width Stores footer. Mobile: stacks single-column. `/api/trades/proposals` extended with a `recentActivity` field (joins `proposal_events` → `users`, filters noisy delivery-only events, limit 5). CTA renamed "+ New trade" → "+ Balance a trade" to disambiguate from the Discord propose flow (propose-to-someone lives in Communities module). Companion `HandlePickerDialog` (`591d03e`) opens from the Communities module's "Propose a trade" action.

### 2026-04-19 — Bulk-resolve endpoint + UI + Discord 40003 classification
Commits: `5630a84`, `7543a9a`, `d16f1be`. Beta user rapidly declined ~10 pending proposals and hit Discord's `40003` ("opening DMs too fast") rate limit. Three-part fix:
- **UI** — multi-select checkboxes on Incoming + Outgoing pending rows, select-all toggle, fixed bottom `BulkActionBar` with two-tap-confirm destructive button. 50-cap honored client-side with a "Showing N of M · bulk cap is N" hint.
- **Backend** — `POST /api/trades?action=bulk-resolve` with `{ ids, action: 'decline' | 'cancel' }` capped at 50. Coalesces proposer-notification DMs into ONE summary DM per unique proposer ("Parker declined 7 of your trades") using a new `buildBulkDeclineNotification` builder. 200ms spacing between summary DMs as defense-in-depth. Cancels skip the summary (edit-in-place uses known channel ids).
- **Error classification** — Discord code `40003` (HTTP 400) now classifies as `DiscordRateLimitError` in `lib/discordErrors.ts`. Existing `errorReporter.shouldSkip` filter auto-silences it + bot client's 429-retry backoff applies automatically.

### 2026-04-19 — Edit + Nudge + web Accept/Decline endpoints + activity timeline
Shipped across several commits: Foundation event log (`f3f7b61`), edit (`e454b35`), accept/decline (`0dba7d9`), nudge (`45b384c`), My Trades tabs + timeline UI (`b605c0c`).

**`proposal_events` append-only log** with event types (created, delivered_ok/failed, edited, nudged, accepted, declined, cancelled, countered, expired), actor+payload+created_at. `lib/proposalEvents.ts` helper for `recordEvent` + `listEvents` + `lastNudgedAt` (rate-limit check). Threaded into every existing lifecycle handler.

**Edit** — `POST /api/trades?action=edit` mutates a still-pending proposal's cards/message, re-delivers the Discord message in place. Proposer-only, pending-only. `/?edit=<id>` EditBar composer on the web. 8 tests.

**Web Accept/Decline** — `POST /api/trades?action=accept` + `?action=decline` share logic with the Discord button handler via a new `lib/proposalResolve.ts` module. Recipients who prefer the web can resolve from the My Trades list without bouncing to Discord. 12 tests.

**Nudge** — `POST /api/trades?action=nudge` re-posts the DM (or thread message) to bump it in the recipient's inbox. 24h cooldown via `lastNudgedAt`. Optional 280-char note appended as a gold-bordered prefix embed via new `buildProposalMessage(ctx, { nudgeNote })` param. 7 tests.

**My Trades UI** — TradesHistoryView rebuilt as 3 tabs (Incoming / Outgoing / History) with role-appropriate row-level quick actions. TradeDetailView gets an activity timeline (reads events) + "Open thread in Discord" link when `discordThreadId` is set.

### 2026-04-18 — AppHeader design system + view migrations
Commits: `505a346`, `93d762f`, `2e1fcc6`, `ab3e7ce`, `57d62ec`, `d099816`, `4bc792f`. Three primitives in `src/components/ui/`:
- **AppHeader** — single top-chrome with logo + breadcrumbs + right-cluster (actions slot that would later be removed in the 2026-04-19 separation, NavMenu, AccountMenu). Always-on across every view.
- **Breadcrumbs** — view-registered path rendered in the header. Desktop shows full trail; mobile collapses to `‹ parent · current`. Single-DOM-tree after a strict-mode-collision fix.
- **NavMenu** — hamburger popover owning content nav (Home / My Lists / My Trades / My Communities). Separate from AccountMenu (identity-only: profile / settings / sign out) — beta feedback was that mixing identity + content actions in one popover was confusing.

All eight signed-in views migrated (Settings, Trades history + detail, Community, Profile, Home, ListView). Popover stacking-context fix (`relative z-40` on header, popover bumped to z-50) + e2e helper update for the new NavMenu location.

### 2026-04-18 — Home view v1 + beta feedback pass
Commits: `f120765`, `09c9c94`, `ff3330c`, `ce47f03`, `73a76f1`, `f36402e`. Shipped the signed-in landing page that surfaced "needs your response" + communities + build-a-trade CTA. Series of same-day polish landings from beta user clicks: pending-cap (with "see all N" overflow), rich trade rows with viewer-centric grammar + timeAgo + top-card preview, 2-column desktop layout, Manage deep-link into settings > servers > guild, TradeDetail Back returns to referrer, SWR-cache on useTradesList/useGuildMemberships to kill loading flashes on return-nav. Compact New trade + History buttons in the greeting row instead of a full-width gold CTA.

### 2026-04-18 — Home view (signed-in landing page)
Commits: `f120765`, `09c9c94`. Signed-in users with a bare URL now land on a Home page (`src/components/HomeView.tsx`) instead of an empty trade builder. Surfaces pending proposals that need their response (capped at 5 with "See all N pending →" overflow), waiting-on-others (collapsed, also capped), enrolled Discord communities, an LGS placeholder, and a primary "Build a trade" CTA. `detectViewMode` grew an `isSignedIn` parameter; auth-resolution + popstate both call it through a ref. Signed-out users still land on the trade builder so the public share-URL experience is unchanged.

### 2026-04-18 — Bot-install outreach: DM existing members on install
Commit: `3de0a5f`. When the bot lands in a guild that already has SWUTrade users, DM them a polished invite with a one-tap Enroll button instead of silently adding the guild to their enrollment list. Two new prefs on `users`: `dmServerNewInstall` (default on) + `autoEnrollOnBotInstall` (default off), plumbed through the prefs registry. Batch size of 5 respects user opt-outs. "Delight the potential user with a magic experience" per user framing.

### 2026-04-18 — Slack-style Settings hub + peer prefs move out of CommunityView
Commits: `72d7a38`, `9d839a4`. Settings page becomes a drill-down hub (profile / preferences / servers → guild → members → per-user prefs) with query-param routing + popstate. Persistent "Done" button (gold) in the header provides one-tap escape from any depth — beta feedback was "Back 5 times is bad UX." Peer prefs move out of CommunityView into the Settings servers/guild/members drill-down; CommunityView stripped the inline peer-pref select and gets a "Prefs" deep-link per row instead.

### 2026-04-18 — Error observability: typed Discord errors + #bot-errors channel + CI notifier
Commits: `b51a5c1`, `86b2e9a`, `14449fa`, `43f6ff8`, `97bcc49`, `97f1e2e`, `dc79443`. Six related slices. `lib/discordErrors.ts` adds typed error hierarchy (RateLimit / Permission / NotFound / Validation / ServerError / Unknown). `DiscordBotClient` auto-retries 429s once with capped sleep (5s default). `lib/errorReporter.ts` posts catch-site failures to a `#bot-errors` webhook, filtering e2e/dev-seed noise + expected 404s/DM-disabled. CI gets a `#releases` notifier that flips to 🟢 live the moment the preview deploys (BEFORE CI finishes), with per-job breakdown only on failure. `scripts/discord-admin.mjs` is a dev-ops wrapper for channel/webhook/member management using a separate admin token (kept minimal permissions on the bot). Unicode emoji (not shortcodes) so markdown underscores don't break the render. `getGuildBotMember` fix — Discord rejects `/members/@me` for bots with 403, must pass botUserId explicitly.

### 2026-04-17 — Fix: large proposals silently failed to DM (1024-char embed cap)
Commit: `f77dc51`. User reported: ~15+ card proposals silently dropped. Root cause: Discord embed field value cap of 1024 chars. `formatCardList` in `lib/proposalMessages.ts` now truncates with a 94-char buffer reserved for a "+N more" summary line. Fix shipped before the error-observability channel existed — worth noting that this kind of silent fail is exactly what the observability work prevents going forward.

### 2026-04-17/18 — Prefs registry migration (8 steps, complete)
Commits: `2f9271d`, `31dbb2f`, `9b92e8f`, `f30d8bd`, `8cf579d`, `fdb4add`, `9014f4d`, `aea2f8b`, `4dfb1bc`, `70c67fa`, `224d543`, `1e9581f`. Rewrote all user settings through a typed registry (`lib/prefsRegistry.ts`) with scope={self,peer,guild}, section={privacy,notifications,communication,membership}, and type={boolean,enum}. Cascade resolver (`lib/prefsResolver.ts`) walks peer override → viewer self column → registry default. `user_peer_prefs` table with composite PK + cascade FKs. SettingsView + proposal DM ⚙ Prefs button render from the registry. `/swutrade settings` slash command + user context menu item. Combined self+peer ephemeral when opening ⚙ Prefs on a proposal DM — user sees both surfaces in one place. Welcome DM to installer on bot-install. Auto-create `#swutrade-threads` channel on bot install so proposals have somewhere to land.

### 2026-04-17 — Private threads for trade proposals (propose path, feature-gated)
Implements the research doc's recommendation: when `TRADES_CHANNEL_ID` is set, a new proposal lands as a **private thread** inside that parent channel, with both traders auto-added. Each trader gets a push-style notification on add and can chat with the other directly in the thread. Falls back to the existing per-user DM when thread creation fails (user not in guild, bot perms missing, or env unset).

**Changes:**
- Schema: `discord_thread_id` + `discord_thread_parent_channel_id` columns on `trade_proposals` (migration `0009_steady_ultimates.sql`, applied to Neon).
- `lib/discordBot.ts`: `createPrivateThread(parentChannelId, {name, autoArchive})` + `addThreadMember(threadId, userId)` methods. `type: 12 (PRIVATE_THREAD)`, `invitable: false`, auto-archive default 1440 (24h).
- `api/trades.ts` `handlePropose`: delivery cascade — thread first when env is set, DM fallback on any failure. Thread id doubles as `channel_id` for downstream PATCH-message edits (Accept/Decline path unchanged).
- Thread naming: `trade-{proposer}-{recipient}-{shortId}` — truncated to Discord's 100-char cap.
- Tests: three new cases in `trades-propose.test.ts` covering happy-path thread flow, fallback-on-failure, and env-unset legacy path. `makeFakeBot` fakes updated across all four test files to satisfy the expanded interface.

**E2E spec fixes from prior slices' header consolidation:** auth-flow, community, matchmaker, migration, sync all used `page.getByText(user.username)` as the signed-in gate — moved to `getByRole('button', { name: 'Account menu' })` since the username now lives inside the popover. Community spec also needed to click the filter-summary button to expand the collapsed chip row. New `e2e/helpers/waitForSignedIn.ts` helper for future specs.

**Counter + accept/decline refinements are NOT in this slice** — they still use the existing edit-message path, which works because thread ids are interchangeable with channel ids in Discord's model. A follow-up slice will add thread-aware counter logic + skip the separate proposer-notification DM when the thread flow was used.

### 2026-04-17 — Send-proposal confirm flow + Discord multi-user research
Two slices delivered in parallel via subagents:

**1. Send-proposal confirm modal** (`src/components/ProposeBar.tsx`, four e2e specs). Clicking the top-bar Send button now opens a Radix Dialog review/confirm surface instead of firing immediately. Modal renders: title "Send to @handle", two-column Offering/Receiving summary (variant pill + qty + $line-total), totals strip (Offering · Receiving · Imbalance-or-Balanced), a full-width 5-row note textarea (replaces the cramped "Add a note" disclosure that beta flagged as too small), and Cancel / Send actions. Dialog blocks dismissal while `sending`; renders inline error above actions on failure so retry is one click. Snapshot helper extracted so the preview totals and POST payload can't drift. Four e2e specs updated to the two-click flow (`propose-open-confirm` → `confirm-send`) with new testids on both buttons and the dialog itself.

**2. Discord multi-user conversation research** (`docs/discord-multi-user-conversation-research.md`). Compared bot-initiated group DMs (🔴 red — bots can't create them, invisible-channel bug), private channels in a shared guild (🟡 yellow — works but channel-list clutter, needs shared guild), and private threads in a `#trades` channel (🟢 green — free since Nov 2022, DM-like push on invite, auto-archive). Recommendation: build option 3 (private threads) first. Next steps documented in the file for when we take this up.

### 2026-04-17 — Picker rework: fullscreen + Done + consolidated filters (beta feedback)
Picker overlay is back to fullscreen (`inset-0`). The top-peek gap was ambiguous in practice — beta feedback was "just make it full screen." Header Done button replaces the X icon + also replaces the touch-only bottom Done CTA, so the overlay has a single unambiguous dismiss affordance rendered in the side's accent color (emerald for Offering, blue for Receiving).

Filter controls consolidated behind a single summary button. Collapsed state renders a compact row: `[🎚 All cards · Any variant · All sets ▾]` (with counts when a source chip is active: `Overlap (3)`). Tapping expands the full detail surface (source chips + variant + set selectors) inline below the summary. Summary button tints gold when any filter is active so users see at a glance that the grid is narrowed. Uses the existing `summarizeSelection` helper for variant/set summaries.

### 2026-04-17 — Header consolidation + propose cancel (beta feedback)
Top bar dropped from five controls (Logo · AccountMenu · Lists · ViewToggle · Share/Clear) to two primary slots (AccountMenu · ViewToggle) in steady state. Changes:

- **ListsDrawer lifted to controlled state** — App.tsx owns `listsDrawerOpen` and hands it down. Drawer no longer renders its own trigger button.
- **AccountMenu grows a "My Lists" entry** — signed-in + signed-out both include it (lists are stored in localStorage until the user opts into cloud sync, so the menu item works without auth).
- **Signed-out state unified** — anonymous-silhouette avatar (parallel shape to the signed-in avatar) opens the same popover surface with a "Not signed in" identity header, "My Lists", and a Discord sign-in CTA. No more visual distinction between "you have an account menu here" and "sign in."
- **ProposeBar gains a cancel affordance** — back-arrow button at the left of the bar. Returns via `history.back()` when same-origin, else navigates to `/?community=1`. Guarded with a `confirm()` if the draft has cards or a note (non-trivial work to discard).

### 2026-04-17 — Public defaults + auto-enroll + clickable logo (beta feedback)
Beta users were bouncing off the private-by-default wall: new accounts had to hunt through Settings just to appear in community queries, and the per-guild enrollment toggle was a second opt-in wall on top. Three related fixes:

- **New-user defaults** (api/auth.ts): `profileVisibility: 'public'`, `wantsPublic: true`, `availablePublic: true` set explicitly on user insert. Existing users' settings are preserved — only new accounts see the change.
- **Auto-enroll on bot-installed guilds** (lib/guildSync.ts): when a new `user_guild_memberships` row is inserted and that guild is in `bot_installed_guilds`, set `enrolled` / `includeInRollups` / `appearInQueries` all to `true`. Existing rows keep the user's prior choice — the change is additive for new joins, not a retroactive flip of explicit opt-outs.
- **Clickable SWUTrade logo** (PageHeader.tsx): wordmark becomes a link to `/`, so tapping it from any view returns to home. Full navigation (not SPA pushState) so sub-view params like `?propose=` drop off.

New test: `guild-sync.test.ts` pins "auto-enrolls new memberships in guilds where the bot is installed" — `g1` has the bot (all three consent axes flip to true), `g2` doesn't (stays default off).

Also deleted `e2e/trending.auth.spec.ts` — the picker's trending card strip was removed in the prior slice and the spec was asserting UI that no longer exists.

### 2026-04-17 — Tabbed trade view + trending removal (beta feedback)
Beta users asked for a single-focus trade layout instead of always-both-sides. Added a new per-device `tradeViewMode` toggle (localStorage, split default) and a `TradeTabBar` component that replaces the two-panel layout with a single-tab view when active. Each tab shows its side's count + running $ total so the hidden side isn't a mystery. `TradeSide` grows a `headerless` prop so the in-panel "OFFERING TOTAL $X" strip doesn't duplicate the tab bar's own labeling — tabs sit flush on top of the single panel in tabbed mode. Toggle icon sits in the top action cluster, swaps between split/tabbed glyphs to reflect current state.

Trending card strip removed from `TradeSearchOverlay` — overlay empty state was too busy, and the feature isn't load-bearing at current scale. The `/api/trending` endpoint stays (community view is a likely future home).

Updated `e2e/mobile.spec.ts` to expect "Trade balance" instead of "ADD CARDS TO WEIGH THE TRADE" — the empty TradeBalance headline was quieted in the prior UX batch but the spec was missed.

### 2026-04-17 — UX copy + polish batch (agent-browser dogfooding)
Ten friction points surfaced during a driven-through agent-browser pressure test, fixed in one batch:

- **Propose hint phrasing**: *"You could offer 4 of their wants"* → *"4 cards you have match their wants"* — less ambiguous about what the 4 is.
- **Balance-strip copy**: *"Ask for $X more to restore balance"* → *"Ask for $X more — cards or cash"* (and symmetric for offer). Cash settlement now explicit.
- **Disabled Send tooltip**: *"Add at least one card to either side to enable."*
- **Overlap chip relabel**: *Overlap* → *Their wants you have* (offering) / *Yours they have* (receiving). Jargon replaced with direct answer.
- **Quieter empty TradeBalance**: headline tier==='empty' now uses a plain gray uppercase label with no glow + neutral border. Two gold bars in propose mode no longer fight for attention; the ProposeBar keeps primary weight. Also renamed the empty headline from *"Add cards to weigh the trade"* (which read as a CTA) to *"Trade balance"* (section header).
- **Variant pill tooltips**: `VariantBadge` gains title-attribute hints for Hyperspace / Hyperspace Foil / Showcase / Prestige / Serialized etc. so non-players hovering get a one-line explainer.
- **Profile tab accent**: active tab now has a 3px underline + colored badge pill instead of 2px underline + muted pill. "Which tab am I on" no longer requires pixel-peeping.
- **Own-profile CTA relabel**: *Start a trade* → *Open trade editor* when viewing your own profile (was conflating with the "Trade with @handle" CTA on other profiles).
- **Row kebab hover-reveal**: secondary-actions kebab hidden behind `.hover-reveal` on desktop, 0.7 opacity on touch via the existing media-query. Row density reduced without losing access.
- **Empty-panel suggest prompt**: when in propose mode with overlap available, the empty *Add cards to Offering* tile gets a quiet *"Or tap ✨ Suggest a match above"* hint so undecided users discover the auto-fill shortcut.

Also re-seeded the fake bots with priority-starred wants (~every 3rd) so future testing can exercise the ★ Priorities suggest button once the pool happens to diverge between modes.

### 2026-04-17 — Fix URL passthrough for propose/from/counter context
`useTradeUrl`'s sync effect was replacing the entire search string with `buildTradeSearch` output, which ONLY emits `y`/`t`/`pct`/`pm`. Every card add stripped `propose`, `from`, `counter`, and anything else. Within a session the lazy-init hooks (`useProposeHandle`, `useSenderHandle`, `useCounterId`) cushioned it by capturing on mount — but refresh dropped the context (ProposeBar unmounted, Send button disappeared) while cards themselves restored, creating a confusing half-restore. Fix: merge trade-codec params into the existing URL params instead of overwriting, so unknown keys pass through automatically. Also gated the new "Picked so far" overlay summary on `open` — the overlay's DOM stays mounted through the transition, and the hidden "3" was triggering strict-mode locator ambiguity in the anonymous e2e suite.

### 2026-04-17 — Picker overlap chip + context-preserving header (UX)
Picker gets a new first-class **Overlap** source chip (`mine ∩ theirs`) that surfaces the match pool the Suggest button already operates on — clickable, always visible when a counterpart exists (even at count=0 so the "no overlap, go look at 'They want'" signal is legible). Auto-scope cascade updates: Overlap when >0, else Theirs when >0, else no chip active. Community chip drops out entirely when there's a counterpart — off-topic noise in a zoomed-in 1:1 trade. Picker header now reads *"Adding to Offering · for @alice"* with a running "Picked so far: 3 · $12" line so the full-screen overlay no longer feels disconnected from its parent proposal; overlay leaves a 40px top inset so the wordmark peeks through and dismissal reads as a return, not an exit. The Esc/X button title adapts to "Back to proposal" when counterpart context is present.

### 2026-04-17 — Imbalance surfacing + zero-card notes (UX slice C of 3)
Surfaces the implied cash settlement that's been implicit all along: the difference between the two sides' card subtotals. Added an `imbalanceNote()` helper in `lib/proposalMessages.ts` that appends a "Subtotal difference: $X in their favor" field to the initial proposal DM, the countered DM, and the resolved (accepted/declined/cancelled) DMs. Hidden when the diff is under $0.50 so balanced trades don't carry unnecessary noise. Matching `<ImbalanceStrip>` in TradeDetailView renders the same info in-app, with directional language adapted to viewer role ("from them to you" vs. "from you to them"). Validation audit: `/api/trades/propose` and `/api/trades/counter` already accept zero-card sides as long as the other side has content — the refine only rejects both-empty. Pure-cash trades ("$20 for their Luke") work end-to-end today; this slice just makes the implied cash legible.

### 2026-04-17 — Scoped pickers in propose mode (UX slice B of 3)
Recipient profile fetch lifted from ProposeBar into a shared `useRecipientProfile(handle)` hook consumed by App. The result feeds both ProposeBar (as props, replacing its internal fetch) and TradeSide (via `effectiveSharedLists`, which overrides the URL-encoded `sharedLists` when in propose mode). TradeSide gains an `autoScopeToTheirs` prop — set when `proposeHandle` is truthy — that pre-activates the "they want" / "they have" source chip on overlay open. Users now land directly in the overlap view with their counterpart instead of the full catalog, with the chip one click away if they want to expand. Reuses the existing source-chip infrastructure (same mechanism that powered the `?from=` shared-list flow) rather than adding a parallel tab system.

### 2026-04-17 — Matchmaker rewrite: subset-sum + two modes (UX slice A of 3)
Greedy `computeMatch` replaced with a subset-sum search. Pools capped at top-16 by price (priorities-first), then the cross-product of both sides' subsets is scored by imbalance (primary), card count (tiebreaker), and priority count (final tiebreaker). Fixes the real $4-vs-$15 report from dogfooding — previously locally-greedy would stop early; the new search finds the subset pair with the tightest achievable balance. Second mode `maximize-priorities` force-includes every priority-starred card then only adds non-priority cards if they improve or preserve balance. ProposeBar now renders two Suggest buttons: `✨ Suggest a match` (minimize) always on when overlap exists; `★ Priorities` (maximize) only when the alt mode produces a different result. New `imbalance` field on `MatchResult` exposes the residual cash implication — surfaced by the callers rather than stored.

### 2026-04-17 — Kill ProposeBar auto-fill (UX fix)
ProposeBar no longer auto-applies the matchmaker on mount — early dogfooding feedback said it felt presumptuous, and the greedy algorithm can produce visibly unbalanced results on small overlap pools ($4 vs $15 observed). The bar now lands empty with a status line that hints at possibility instead of performing: *"You could offer 3 of their wants · They have 5 of yours"*. A new secondary **"✨ Suggest a match"** button (visible only when overlap exists) runs the matchmaker on demand. If there's no overlap the status switches to *"No matching overlap — pick cards manually to propose anyway"* and the Suggest button hides. Propose e2e updated to click Suggest explicitly before Send.

### 2026-04-17 — Profile lists → tabs (UX fix)
ProfileView's stacked Wants-then-Available sections became tabs. Scanning someone's available cards no longer requires scrolling past their entire wants list, and both lists' existence is visible at a glance via the tab bar. Default tab is the first with items; private/empty states are rendered per-tab so each panel explains its own state. Kept the existing blue (wants) / emerald (available) accent colors as the active-tab underline — preserves the side-color invariants from the profile owner's perspective without any palette changes.

### 2026-04-17 — Profile nav + CTA cleanup (UX fix)
ProfileView grows a Back button in the PageHeader (history.back() for same-origin referrer, else `/`) so clicking into a community member no longer strands the user. Header CTA pair collapsed: "Propose a trade" + "Just balance" → single "Trade with @handle" primary when viewing someone else, still "Start a trade" on own-profile or signed-out. The two old buttons auto-filled the same trade — the only real difference was whether Send-to-Discord rendered, not enough to justify user-facing choice. Also excludes `dev-seed-%` ids from `/api/trending` aggregation so seeded fakes don't skew community trends (+ fixes the trending test that started failing after the law-hyperspace seed landed).

### 2026-04-17 — Foundation slice 4: design-system primitives
New `src/components/ui/` dir with `PageHeader`, `StatusBadge`, and a `states.tsx` module exporting `LoadingState` / `EmptyState` / `ErrorState`. `PageHeader` consolidates the duplicated Logo + SWUTrade wordmark + BetaBadge chrome; it accepts `onBack` (back button), `kicker` (string or ReactNode), and right-side action children. Migrated all 7 sites: App.tsx, ProfileView, CommunityView, SettingsView, TradesHistoryView, TradeDetailView, ListView — `grep` confirms the wordmark classes now appear only inside PageHeader itself. StatusBadge has `size: 'sm' | 'md'` preserving the opacity delta between the history-row and detail-header variants; two local definitions deleted. LoadingState / ErrorState / EmptyState replace the `animate-pulse` + red-card + empty-card patterns in CommunityView, SettingsView (`LoadingLine` removed), TradesHistoryView, TradeDetailView. Full-page loading takeovers (ProfileView) kept as-is — different layout context, out of scope.

**Button primitive deferred** — planned but dropped. The primary CTAs in ProfileView/ListView are a mix of `<a>` and `<button>` tags (Propose is an anchor link, Start-a-trade is a button), which needs a polymorphic component rather than a plain `<button>` wrapper. And the existing inline buttons use `font-bold` while the back buttons use `font-medium` — a single primitive that covers both visual weights without divergence needs more design thought. Net -235 LOC without it; Button extraction can come as its own slice when a real call site forces the polymorphic question.

Full vitest (290/290) + browser smoke on home and settings render identical to pre-slice.

### 2026-04-17 — Foundation slice 3: accessibility foundation
Global `:focus-visible` rule in `src/index.css` — 2px gold outline with 2px offset and a `.no-focus-ring` escape hatch. `.hit-area-44` utility class that places a centered transparent 44×44 `::before` pseudo-element on small buttons; applied to QtyStepper + / −, RemoveButton, priority-star, and restriction-editor close in `ListRows.tsx`. Verified in-browser: focus ring renders on tabbed buttons, pseudo-element produces the expected 44×44 hit rect (elementFromPoint at all four 44×44 corners hits the host; a 60×60 test falls through). Avatar `aria-label` ask dropped — current `alt=""` is correct a11y practice because the enclosing `<a>` already contains the visible @handle text, so screen readers announce identity via link content; adding aria-label would *replace* the richer announcement.

### 2026-04-17 — Foundation slice 2: trade_proposals indexes
Added 4 indexes in `lib/schema.ts` covering the hot paths: `counter_of_id` (counter-chain children), `status` (optimistic-concurrency WHERE filters), and compound `(proposer_user_id, updated_at DESC)` + `(recipient_user_id, updated_at DESC)` for the history query. Migration `0008_blushing_thanos.sql` generated; DDL applied to Neon. EXPLAIN with `enable_seqscan=OFF` confirms each index is picked for its intended predicate; planner will switch automatically once row count grows beyond tiny.

### 2026-04-17 — Foundation slice 1: security + correctness quickies
Ed25519 timestamp window (`maxSkewSeconds`, default 300s) with `now`-injection for tests and 5 new cases in `discord-signature.test.ts` pinning default rejection + edge + override behavior. Test-key fallback gated behind `VERCEL_ENV !== 'production'` via a pure `resolveTestPublicKey(env)` helper exported from `api/bot.ts`, with a 3-case unit test. Counter-cleanup race-loss `db.delete` now logs on failure instead of silently swallowing. Full vitest run green (290/290).

### 2026-04-17 — Roadmap audit + foundation-polish slice planning
Commits: `7dad958`. Not a slice per se; introduced this NEXT.md and the two review docs (`CODE_REVIEW_2026_04_17.md`, `UX_REVIEW_2026_04_17.md`).

### 2026-04-17 — Phase 4c Slice 5: trade history + detail + cancel
Commits: `5f944dc`, `366c708`. GET /api/trades/proposals + POST /api/trades/cancel + extended GET /api/trades/:id with chain stubs; TradesHistoryView + TradeDetailView + Cancel button wiring; 11 integration tests + 2 e2e specs. Fix on `useTradeUrl` strip-guard for `?trade=` and `?trades=1`.

### 2026-04-17 — Phase 4c Slice 4: counter flow
Commits: `0a8e759`, `8f54e90`. `trade_proposals.counter_of_id` self-FK + `countered` status; POST /api/trades/counter; Counter button in DM with deep-link ephemeral; CounterBar at `/?counter=<id>`; 11 integration tests + browser e2e + stale-closure fix on message deps.

### 2026-04-17 — Proposer message field
Commit: `df8b161`. Disclosure-style textarea in ProposeBar; plumbed through to `/api/trades/propose` body.

### 2026-04-17 — Signed-interaction e2e activated
Commits: `a798bdc`, `7b743fe`, `dcbe5a2`, `17dc046`. Test keypair provisioned (DISCORD_APP_PUBLIC_KEY_TEST on Vercel Preview, DISCORD_TEST_PRIVATE_KEY_B64 locally + GitHub secret). Dual-key signature fallback in api/bot.ts. Spec covers Accept + Decline + unauthorized via synthetic signed clicks against the real preview endpoint. Also fixed `/u/<handle>` routing which was silently falling through to trade view.

### 2026-04-17 — Phase 4c Slice 3: Discord DM proposals + Accept/Decline
Commits: `aaf8894`. Schema additions for delivery_status + discord_dm_channel_id/message_id; bot DM on propose, button interaction handler with auth gate + idempotency; buildResolvedProposalMessage + buildProposerNotification helpers; 16 integration tests.

### 2026-04-17 — Phase 4c Slice 2: propose composer + backend
Commits: `fd5efa7`, `531ad3c`. `trade_proposals` table; POST /api/trades/propose; "Propose a trade" button on ProfileView; ProposeBar at `/?propose=<handle>`; 9 integration tests + 2 e2e specs.

### 2026-04-17 — Phase 4c Slice 1: community directory view
Commits: `5cd743e`, `6805beb`. GET /api/me/community-members; CommunityView at `/?community=1`; 8 integration tests + 2 e2e specs; CI typecheck tightened via Husky pre-commit hook.

---

## Ritual reminder (in case it drifts)

Before any new `git push` on a non-fix:

```
gh run list --branch beta --limit 1 --json conclusion,status
```

- `conclusion=success` → proceed
- `conclusion=failure` → stop, fix the failed commit first
- `status=in_progress` → wait unless the new work is clearly unrelated

Hook fires on every commit (`tsc -b --force`). Full vitest runs locally before push. E2E runs in CI.
