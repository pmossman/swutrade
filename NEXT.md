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
6. **Wiki updated** (`docs/wiki/`) if shipping changed behavior in an area page's scope — the staleness guard on each page applies.
7. **Roadmap updated** if shipping changed Phase status or introduced a new design decision.
8. **Mark slice complete** in the Done section below with the date + commit range.

Skipping any of 1–3 is a bug in the process.

---

## Active slice

*(none currently — pick next from the queue)*

---

## Queue

Ordered smallest / highest-clarity first so the between-slice ritual feedback loop stays fast. Re-order as priorities shift.

### 1. UX-A5 — Ghost → real-user merge reassurance

**Why:** Sign-in silently migrates ghost trades + sessions into the real user row (`mergeGhostIntoRealUser` in `lib/sessions.ts`, called from `api/auth.ts` callback). Silent success in ownership transitions is anxiety-inducing — users wonder if they lost their in-progress trade.

**What ships:**
- New `users.merge_banner_dismissed_at timestamptz` column (nullable). Additive migration.
- OAuth callback records the merged-from ghost id in the iron-session cookie (or a short-lived signed URL fragment) so the client knows a merge just happened.
- One-shot gold banner on first post-merge Home / Session render: "We carried your trade with @alice over. View it." Dismissible via button that writes `merge_banner_dismissed_at = now()`.
- Only fires once per real-user account; subsequent sign-ins on new devices don't re-trigger.

**Done when:**
- [ ] Migration applied to Neon.
- [ ] Integration test covering the callback flags the cookie + the banner appears on next load.
- [ ] e2e test: ghost opens a session, signs in, banner appears, dismiss persists across reload.
- [ ] Between-slice ritual passes.

---

### 2. UX-A3 — Reframe TradeDetailView response buttons

**Why:** `TradeDetailView` shows four response buttons on a pending proposal: Accept / Counter / Decline / Edit Together. First three are proposal vocabulary, Edit-Together is session vocabulary. v2 dogfooding (tabled below) reinforced that this mismatch is a real comprehension gap — the exact confusion Phase 5b meant to collapse.

**What ships:**
- Relabel as ways-to-respond with consistent vocabulary: "Accept · Edit together · Counter · Decline".
- Visually group Accept + Edit-together (positive responses) vs Counter + Decline.
- Consider Edit-together as the middle-ground default when the recipient wants to negotiate *and* see cards change live.
- Copy change in `src/components/TradeDetailView.tsx`; possibly a minor reshape of the action bar.

**Done when:**
- [ ] Labels + visual grouping updated.
- [ ] e2e spec assertions updated where they reference the old labels.
- [ ] Between-slice ritual passes.

---

### 3. Decoder unification (followup from 2026-04-20 share-image bug)

**Why:** Today's fix (commits `9555d86` + `fcdf9aa`) patched the symptom — wants/available share params are now decompressed server-side. But two parallel decoder implementations still exist: `src/urlCodec.ts` (client encode + decode, `restriction` shape) and `lib/listShareCodec.ts` (server decode, `acceptedVariants` shape). Any future change to the client encoder has to be mirrored server-side or the same divergence class recurs. The new `tests/api/og-codec.test.ts` catches drift but shouldn't be the only guard.

**What ships:**
- Single decoder module usable from both client and server (likely in `lib/listShareCodec.ts` since `lib/` is already server-safe and importable from `src/`).
- A small shape adapter for the `restriction` (client) ↔ `acceptedVariants` (server) mismatch. Adapter lives with the decoder.
- `src/urlCodec.ts` delegates decoding to the shared module; encoder stays client-side (browser-only-safe imports only).
- Delete the duplicated logic.

**Done when:**
- [ ] One decoder source of truth; `grep 'function decodeWants'` returns one match.
- [ ] Adapter for shape diff is covered by its own unit test.
- [ ] `tests/api/og-codec.test.ts` still passes (round-trip remains the integration guard).
- [ ] Between-slice ritual passes.

---

### 4. UX-A2 — Collapse four-bar mutex into a PrimaryActionBar

**Why:** `EditBar / CounterBar / ProposeBar / AutoBalanceBanner` stack above the trade builder as a mutex (`src/App.tsx:575–624`). Each is a different *mode* of the same canvas. v2 dogfooding confirmed this is the single biggest visual-hierarchy gap: v2's bottom-pinned primary CTA was the strongest lesson, and v1's top-of-screen composer bars are where the misalignment lives.

**What ships:**
- New `<PrimaryActionBar>` pinned bottom on mobile (desktop: stay top for now, or float). State-driven label: Send proposal / Save counter / Save edit / Invite someone / Confirm trade.
- The three composer bars (Edit / Counter / Propose) shrink to informational content only — matchmaker hint, note textarea, imbalance callout. Their "Send" / "Save" buttons move into `PrimaryActionBar`.
- `AutoBalanceBanner` stays as informational (unchanged or minor).
- The `useComposerBar` hook already consolidates send-state-machine logic — PrimaryActionBar reads from that.

**Done when:**
- [ ] Primary CTA is visually dominant and bottom-pinned on mobile.
- [ ] Composer bars render only informational content; no Send buttons left inside them.
- [ ] Desktop regression check — action strip + PrimaryActionBar don't both occupy primary weight.
- [ ] Propose / counter / edit / auto-balance e2e specs still pass.
- [ ] Between-slice ritual passes.

**Pointers:** UX-A2 from the 2026-04-19 audit; confirmed by v2 dogfood.

---

### 5. Copy + context fixes

**Why:** Clarity wins bundled: Discord DM text is third-person and confusing on first read, the Counter button label is ambiguous, post-send navigation goes to the wrong destination, landing-page empty state has no explanation, CounterBar drops users cold into a composer.

**What ships:**
- `lib/proposalMessages.ts`: field names "They're offering" → "You would receive", "They're asking for" → "You would give" (recipient-first framing).
- `lib/proposalMessages.ts`: Counter button label "Counter" → "Counter offer".
- `src/components/ProposeBar.tsx` + `CounterBar.tsx`: post-send primary link "Back to community" → "View your trades" (→ `/?trades=1`), keep community as secondary.
- `src/components/CounterBar.tsx`: context banner on mount — "Responding to @X's proposal. Sides are flipped — you're now offering what they asked for. [View original]". Dismissible with localStorage.
- `src/App.tsx` (trade view empty state): one-line subtitle explaining the two-panel trade model.
- `src/components/AccountMenu.tsx`: sign-in popover copy reframed to lead with community/trade, not "sync".
- `src/components/SettingsView.tsx`: 1-line note on EnrollableGuildCard explaining the bundled toggle behavior when enrolling.

**Done when:**
- [ ] All copy changes in place, spot-checked in the running app.
- [ ] CounterBar's new banner dismissible, remembered via localStorage.
- [ ] propose.auth e2e + trades-history e2e updated if any assertions referenced changed text.
- [ ] Between-slice ritual passes.

**Pointers:** UX_REVIEW CU1, CU2, CU3, CU4, CU7, CF6, CF7.

---

### 6. UX-A4 — Rehome the Communities module

**Why:** Communities module on Home competes with the trading loop. Mental model "check my Discord servers" ≠ "see my trades." Right now it's a sidebar widget on the main dashboard. v2 audit pushed for this removal — the destination already exists at `/?community=1` via NavMenu, and trade-relevant community signals (overlap chip in picker) are already surfaced in context.

**What ships:**
- Remove `<CommunitiesModule>` from `HomeView.tsx`.
- Community-related empty state on Home if user has zero enrolled guilds → short CTA pointing to Settings.

**Done when:**
- [ ] Communities module no longer renders on Home.
- [ ] Discovery path via NavMenu verified.
- [ ] Community e2e specs still pass (they navigate via the main nav, not Home).
- [ ] Between-slice ritual passes.

---

### 7. UX-A6 — Profile entry-points audit

**Why:** Multiple entry points to `/u/<handle>` (community member list, trade counterpart name, @mentions). Not verified they all route consistently or preserve context (e.g., returning after "Trade with @X").

**What ships:**
- Grep pass for every `nav.toProfile` / `/u/` navigation site.
- Verify consistent Back-button behavior across entry points.
- Profile view CTAs reflect the origin (e.g., "Back to your trades" when arriving from My Trades, "Back to @community" when arriving from community directory).

**Done when:**
- [ ] Audit doc or inline comment enumerates every entry point + its expected Back behavior.
- [ ] Inconsistencies resolved (or deliberately accepted with a note).
- [ ] Between-slice ritual passes.

---

### 8. Test-file dedup

**Why:** `makeFakeBot()` + proposal-row seeding helpers are duplicated across ~4 test files. A schema change to `trade_proposals` or the bot interface becomes an N-file fan-out. Shared helper `tests/api/discordFakes.ts` partially exists (from the Phase 5b work), but the migration isn't complete.

**What ships:**
- `tests/api/discordFakes.ts`: single canonical `createFakeDiscordBotClient(opts?: { sendFails?, editFails?, sendResponse? })`. 4 in-file variants deleted.
- Extend `tests/api/helpers.ts` with `seedTradeProposal(overrides?) → { id, cleanup }`. Cleanup bound to id at creation time so failed inserts never leak.
- Migrate existing call sites.

**Done when:**
- [ ] All 4 test files import from the shared fakes/fixtures.
- [ ] `grep 'function makeFakeBot'` returns one match.
- [ ] Full vitest suite green.
- [ ] Between-slice ritual passes.

**Pointers:** CODE_REVIEW A7; TEST_REVIEW 1, 2, 5.

---

## Later (unscheduled, priority order)

### Client-side error reporter

Server has `lib/errorReporter.ts` posting to `#bot-errors`. Client has no equivalent — view-layer failures silently `console.warn` (e.g., `TradeImageModal`). Add a `src/lib/clientErrorReporter.ts` that POSTs to a `/api/errors/client` endpoint which funnels to the same Discord webhook tagged `client`. Hook to a React `ErrorBoundary` at App root + expose as `reportClientError()` for explicit catches. Low urgency until real users start hitting runtime errors we can't see.

### Proposal transition pattern extraction

`handlePropose`, `handleCounter`, `handleCancel`, `handleEdit`, `handleNudge`, and `resolveProposal` share a pattern: "load proposal → auth check → precondition check → optimistic-concurrency update → edit source DM → send outbound DM." Extract `executeProposalTransition(opts)`. High ROI once a 7th transition shows up (expiry cron counts as one — tackle this alongside).

### Proposal expiry cron

Proposals sit `pending` indefinitely today. A scheduled job (GitHub Actions, following the price-refresh pattern — see `h-cards-pricing.md` and `j-infra.md` on why it's not a Vercel cron) runs daily, transitions rows older than N days (30 to start) to `expired`, edits their DMs to show the expired banner. Needs the shared transition pattern above.

### Tier 2 nightly Discord contract probe

Real-Discord API health check on a nightly schedule. Hits `/users/@me` with the bot token + `/gateway` + a canonical `POST /channels/{id}/messages` to a dedicated test channel. Diagnostic only — issue-opens on failure, doesn't block merges. Stand up once the bot has real user traffic.

### Chain visualization timeline

Trade detail view currently shows one-hop chain context (↑ counter to / ↓ countered by). A proper timeline walking the FK chain back to the root. Defer until chain depth > 2 actually happens in the wild — right now a timeline would only show two nodes.

### Keyboard shortcuts on Home

Dashboard-app pattern: `G T` → trades, `G L` → lists, `G C` → community, `N` → new trade. Nice-to-have polish; low priority until beta users explicitly ask.

### Phase 5a tail — Trading-network lifecycle

Trader reputation / preferred traders, auto-prune on accept, notifications inbox, trade-completion (met-in-person) state, chain timeline. See ROADMAP.md Phase 5a for scope. Proposal-expiry cron sits above.

### Phase 4 v2 — Community depth (LGS integration)

LGS directory, visit announcements, meetup-aware matching, match-alert DMs. Moved below Phase 5 per the ROADMAP reorder — sessions come first. See ROADMAP.md Phase 4 v2 for scope.

---

## Tabled

### v2 rewrite (tabled 2026-04-20)

Experimental ground-up rewrite of the frontend with a minimal / Apple-inspired design vision. Branch `v2` on origin, design at `docs/v2/design.md`. Went through two review rounds (`docs/v2/review-01.md`, `review-02.md`) and the agent implemented Phase 1. Dogfooded at mobile viewport.

**Outcome:** the implementation overshot "minimal" — lost card thumbnails (wrong for a TCG app — players recognize cards by art), produced a sparse Home (single row on a black void read as empty), and dropped counterpart identity from the Trade canvas header (the generic "Trade" title killed context). Vision wasn't worth the rewrite cost.

**Positive lessons backported to v1** (commit `cce0c9f`):
- Muted side-identity tint — full-panel emerald/blue borders on `TradeSide` replaced with a pale tint chip behind the label only. Gold CTAs and state badges no longer compete with panel chrome.
- Ghost `ListsDrawer` CTA — anonymous users now see a "Sign in to keep a list of your cards" panel with Continue-with-Discord button instead of empty Wants / Available tabs.

**Lessons confirmed but not shipped** (v1 already had equivalents):
- Tap-to-expand pricing sheet — v1's popover-based `PriceSlider` is functionally the same. Refactor to a proper bottom-sheet not worth the cost.
- Percentage preset pills — already exist in `PriceSlider` (50/60/70/80/90/100).
- Gold scarcity audit — v1's existing gold uses are contextually correct (active/selected/primary-in-context); blanket demotion risked regressions without clear wins.

**v1 patterns confirmed correct:**
- Card thumbnails in picker + rows (TCG art is recognition-first).
- Module-dense Home (single row on a void reads as "nothing happening").
- Breadcrumbs provide real context on mobile + desktop (keep).
- Cyan/gold/emerald/red/purple state-badge palette carries information (don't flatten).

**New queue items surfaced from the rewrite dogfood:**
- UX-A2 (4-bar mutex → PrimaryActionBar) — elevated; v2's bottom-pinned CTA was the single strongest lesson.
- UX-A3 (response-button vocabulary) — reinforced.

Branch preserved for reference (no merge planned). `docs/v2/` scaffolding stays on beta as a record of what we tried. Memory `project_docs_wiki` points at the v1 wiki which covers the same ground v2's design was attempting to replicate.

---

## Done

*(append here as slices ship; newest-first)*

### 2026-04-20 — Share-list image fix + cross-boundary codec test
Commits: `9555d86`, `fcdf9aa`. Beta user reported signed-out share-image for a wants list showed no cards. Root cause: commit `43b7fec` (2026-04-15) added deflate+base64url compression to `src/urlCodec.ts` wants/available encoders but the duplicate decoders in `api/og.ts` never got the matching `decompressParam` step — new share URLs carried the `~` prefix, `split(',')` found nothing, `renderListImage` returned an empty PNG. Zero test coverage for `api/og.ts` meant the divergence at the client/server boundary was invisible. Fix: added decompression to the server decoder with a try/catch for malformed payloads (empty image beats 500 on a bad URL). Extracted decoders to `lib/listShareCodec.ts` so tests can import without triggering og.ts's heavy JSON-data imports (not present in CI). New `tests/api/og-codec.test.ts` (9 tests) asserts client-encode → server-decode round-trip. Followup queued: unify the two decoder implementations (queue item #3).

### 2026-04-20 — Mobile polish from v2 lessons
Commit: `cce0c9f`. Two visual polish items ported from dogfooding the v2 Phase 1 rewrite. (1) Muted `TradeSide` panel chrome — dropped `borderColor` prop, outer panel flips to `border-space-700` neutral, side identity reads through the saber-bar + a pale tint chip behind the OFFERING / RECEIVING label. Removes competition with gold CTAs and state badges. (2) `ListsDrawer` shows a "Sign in to keep a list of your cards" CTA + Continue-with-Discord button for ghost users instead of empty tabs. Same pattern as `GhostHomeView`. No behavior changes. The other three items from the original polish plan (PriceSheet refactor, percentage pills, gold audit) were skipped after investigation: v1's popover-based `PriceSlider` already has equivalent pill-grid + tap-to-expand behavior, and a blanket gold-demotion pass would risk regressions. See Tabled section for the v2-lessons summary.

### 2026-04-20 — CI hardening: testTimeout bump
Commit: `1bf6973`. Run on commit `2173b4a` (docs-only, no code changes) timed out on two Postgres-backed integration tests at exactly vitest's default 5000ms. Re-run on the same commit passed. Root cause: `tests/api/*` do 4–5 Neon round trips per test at 300–800ms each on slow GA moments — no headroom over 5s. Bumped `testTimeout` + `hookTimeout` to 15s in `vite.config.ts`. Plenty of headroom for a real test without masking a genuine hang.

### 2026-04-20 — docs/v2 brief + v2 rewrite attempt
Commit: `2173b4a` (brief + scaffolding), plus commits on branch `v2`. See Tabled section above for outcome + lessons.

### 2026-04-20 — Subsystem wiki
Commit: `de049a3`. Added `docs/wiki/` — ten area pages (A sessions, B proposals, C trade builder, D lists, E home/nav, F community/profile, G auth, H cards/pricing, I Discord bot, J infra) + `architecture.md` cross-cutting overview + README index + template. Each area owns a disjoint set of files; ~116 cross-references between pages. Staleness guard: each page is updated in the same PR that changes its covered surface. Memory entry `project_docs_wiki` points future agents at the wiki before starting unfamiliar work. Findings surfaced during the pass (flagged as tech debt in the relevant pages, not fixed): `api/context.md` mis-documents the price-refresh cron (it's a GitHub Actions scheduled deploy-hook, not a Vercel cron); `useTrending` hook is orphaned since trending was removed from the picker; 12-function ceiling is thin; `profileVisibility` pref isn't enforced on `/api/user/:handle`; no `_apply-migration.mts` script despite memory references (lore only).

### 2026-04-19 — UX-A1: Lists promoted out of drawer
Commit: `6a96994`. Highest-impact finding from the 2026-04-19 UX audit — Lists (wants + available) lived in a globally-accessible drawer, so users didn't form the mental model "these are my cards" even though inventory state is what the trade builder reads from. Split the old single "My Lists" HomeView module into two first-class modules: ⭐ "Your wishlist" (priorities pinned, then newest, top 5) and 📘 "Your binder" (newest first, top 5). Each shows card thumbnails + quantity; tapping a row opens the drawer on the matching tab. DrawerContext extended with optional `tab` hint so `openLists('wants')` lands on Wants and `openLists('available')` lands on Available; hint consumed and cleared on open. Home column layout: left = Trades + Wishlist (action ↔ source), right = Binder + Communities (context). Drawer remains the quick-edit surface from inside the trade builder; just no longer the *primary* surface.

### 2026-04-19 — Shared-session lifecycle e2e coverage
Commit: `a607b5f`. Pinned the live-trade session happy path and cancel path with a new `e2e/session-lifecycle.auth.spec.ts`. Two tests using `browser.newContext()` for isolated participants: (1) happy-path — A creates → B claims → both add cards → both confirm → asserts settled banner, action bar collapses, Add Card affordance disappears on both halves (proves `readOnly` propagates), counterpart card still renders with line-total price; (2) cancelled terminal state — A cancels with dialog auto-accept, asserts cancelled banner + no editing chrome, B reloads and sees same state. Uses `filterConsoleErrors` from `_fixtures.ts` to drop expected 401/404/CORS noise. `.auth.spec.ts` suffix means CI-only against the Vercel preview.

### 2026-04-19 — Phase 5b live-trade session UX pass
Commit: `4b49c7e`. Dogfooded the live-trade feature (Parker + wife) and surfaced three real bugs: confirm/cancel controls sat above the cards (flow mismatch — stage → confirm), terminal states didn't visibly lock the canvas, and the counterpart side was a compact tile grid with no per-card price breakdown. Restructured `SessionView` into stage → confirm layout (identity strip at top, balance + terminal banner + two panels in middle, confirm/cancel action bar below the cards). Counterpart side now renders `TradeSide` in read-only mode instead of the custom tile grid — full per-card price breakdown matching the viewer's side. Terminal states (settled / cancelled / expired) render a prominent banner and lock both panels (readOnly flag) so add/qty/remove controls disappear; action bar hides entirely. Action-bar hint text adapts to state ("both empty" / "you've confirmed, waiting on them" / "@x already confirmed" / initial). `TradeRow` + `TradeSide` gained matching `readOnly` props; read-only empty state swaps the Add-cards-tile CTA for a quiet placeholder. UX audit findings (lists promotion, mutex-bar collapse, response-button relabel, communities rehome, ghost-merge banner, profile-entry audit) queued as the "UX audit 2026-04-19 cohesion wave" later-section (now interleaved into the main queue).

### 2026-04-19 — My Trades inline expand
Commit: `6602874`. Clicking a trade row in HomeView's pending callout, the recent-activity feed, or any TradesHistoryView tab now expands an inline peek instead of navigating. The peek renders both sides as a card-image grid (viewer-centric "You offer / You receive" labels, flipped for recipients), shows the proposal message when set, and carries an "Open full details →" affordance. Single `expandedId` per list collapses the prior open row; tab switch + list-shape changes collapse automatically. `useTradeDetail` grew a module-scoped cache so repeat expansions are instant; successful mutations invalidate the affected entry. Anon e2e updated: the trades-history row-click spec now clicks through the peek's full-details button to reach `/?trade=<id>`.

### 2026-04-19 — Home flicker fix
Commit: `8cf5016`. Returning signed-in users saw a one-frame flash of the trade builder before HomeView took over because `detectViewMode(!!user)` ran with `user=null` before `/api/auth/me` resolved. `useAuth` now persists a `swu.signedInHint` flag to localStorage after each confirmed auth (cleared on logout / confirmed-signed-out) and exposes `isSignedIn = !!user || (isLoading && initialHint)`. App.tsx seeds the view router from `isSignedIn` instead of `!!user`, so the first render lands on the right view. Stale hints are self-correcting on the next fetch.

### 2026-04-19 — Handle-picker dogfood fix
Commit: `2d39d14`. Signed-in dogfood pass surfaced two conflicting hints stacking in HandlePickerDialog: the new red "No SWUTrade user…" validation error on top and the pre-existing grey "Press Go to send anyway" hint underneath. Gated the grey hint on `validation.kind !== 'error'`; it reappears automatically when the user edits the input and the error clears.

### 2026-04-19 — Handle-picker improvements
Three upgrades to `HandlePickerDialog`: (1) new `GET /api/me/recent-partners` endpoint + `useRecentPartners` hook drive a "Recent" chips row above the typed-handle input (up to 5 distinct counterparties, newest proposal interaction first, hidden once the user starts typing to avoid clutter); (2) typed-handle validation on submit — unknown-in-community handles are verified against `/api/user/:handle` before navigating, so a 404 now surfaces as an inline "No SWUTrade user with the handle @…" error instead of bouncing into a broken composer; (3) richer empty state when the viewer has no mutual Discord guilds — a distinct panel with a deep link into `Settings → Discord servers`. 3 new integration tests cover distinct-counterpart dedupe, the 5-partner cap, and the empty case.

### 2026-04-19 — Community activity feed
`community_events` append-only log keyed on `(guild_id, created_at)` with two event types (`trade_accepted`, `member_joined`). Write path: `recordTradeAcceptedAcrossGuilds` fires one event per guild where both parties are enrolled+queryable (from `proposalResolve.ts`); `member_joined` fires on first-enrollment in each of the three enroll surfaces (web PATCH, Discord auto-enroll, Discord invite button). New `shareActivityPublicly` user pref (default on, privacy section) suppresses an actor's events at read-time without deleting history. Read API: `GET /api/me/community-activity?guildId=…&limit=…` gated on the same enrolled+queryable axis as the members directory. `useCommunityActivity` hook + `ActivityFeed` component replace the Overview tab's "coming soon" placeholder. Relative timestamps, avatar/handle linking, states for loading/error/empty/populated. 4 new integration tests covering the gate + the actor-suppression filter.

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
Ten friction points surfaced during a driven-through agent-browser pressure test, fixed in one batch. See commit history + UX_REVIEW doc for the detailed list.

### 2026-04-17 — Earlier foundation slices (indexed here for reference)
- Matchmaker rewrite: subset-sum + two modes (UX slice A)
- Scoped pickers in propose mode (UX slice B)
- Imbalance surfacing + zero-card notes (UX slice C)
- Kill ProposeBar auto-fill
- Profile lists → tabs
- Profile nav + CTA cleanup
- Foundation slice 4: design-system primitives (`PageHeader`, `StatusBadge`, states)
- Foundation slice 3: accessibility foundation (`:focus-visible`, `.hit-area-44`)
- Foundation slice 2: `trade_proposals` indexes
- Foundation slice 1: security + correctness quickies (Ed25519 window, test-key gate, counter-cleanup race)
- Send-confirm flow + Discord multi-user research
- Fix URL passthrough for propose/from/counter
- Picker overlap chip + context-preserving header

(See `git log --since=2026-04-15` for the full commit trail; commit messages carry the context.)

### 2026-04-17 — Phase 4c slice foundations
Commits: `5f944dc`, `366c708`, `0a8e759`, `8f54e90`, `5cd743e`, `6805beb`, `aaf8894`, `fd5efa7`, `531ad3c`. Stacked slices landing the proposal foundation: trade history + detail + cancel, counter flow with self-FK + deep-link ephemeral + CounterBar, DM proposals + Accept/Decline button interactions with Ed25519 signature verification, propose composer + backend, community directory view.

### 2026-04-17 — Signed-interaction e2e activated
Commits: `a798bdc`, `7b743fe`, `dcbe5a2`, `17dc046`. Test keypair provisioned (DISCORD_APP_PUBLIC_KEY_TEST on Vercel Preview, DISCORD_TEST_PRIVATE_KEY_B64 locally + GitHub secret). Dual-key signature fallback in api/bot.ts. Spec covers Accept + Decline + unauthorized via synthetic signed clicks against the real preview endpoint. Also fixed `/u/<handle>` routing which was silently falling through to trade view.

### 2026-04-17 — Roadmap audit + foundation-polish slice planning
Commits: `7dad958`. Not a slice per se; introduced NEXT.md and the two review docs (`CODE_REVIEW_2026_04_17.md`, `UX_REVIEW_2026_04_17.md`).

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
