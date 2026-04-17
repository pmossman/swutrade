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

### 1. Copy + context fixes *(Foundation bundle, part 5)*

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

### 2. Test-file dedup *(Foundation bundle, part 6)*

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

### Proposal expiry cron

Proposals sit `pending` indefinitely today. A Vercel Cron Job at `/api/jobs/expire-proposals` runs daily, transitions rows older than N days (30 to start) to `expired`, edits their DMs to show the expired banner. Needs a new cron entry + a handler that matches the propose/cancel state-transition pattern. Small, self-contained, completes Phase 5's terminal-state list.

### Tier 2 nightly Discord contract probe

Real-Discord API health check on a nightly schedule. Hits a narrow set of endpoints (`/users/@me` with the bot token, `/gateway`) + a canonical `POST /channels/{id}/messages` to a dedicated test channel. Diagnostic only — issue-opens on failure, doesn't block merges. Stand up once the bot has real user traffic so we're not monitoring a pipeline that isn't carrying cargo.

### Frontend API client extraction

Every hook inline-implements fetch + error handling. `src/services/apiClient.ts` exposing `apiGet/apiPost/apiPut` that returns a discriminated `{ ok: true, data } | { ok: false, status, code, message }`. Single place for session-expired handling, retry policy, error mapping. Roughly 3 hours of migration work across ~10 call sites. Foundational — pairs well with the ProposeBar/CounterBar dedup below.

### ProposeBar + CounterBar dedup via `useComposerBar`

The two bars share ~80% of their logic: fetch-with-dedupe-ref, auto-apply match/seed on mount, message input disclosure, send state machine, snapshot building. Extract a `useComposerBar` hook and keep the two components as thin render wrappers. Defer until a third variant (e.g., proposer-withdraws-and-replaces flow) justifies the extraction.

### Proposal transition pattern extraction

`handlePropose`, `handleCounter`, `handleCancel`, and `handleTradeProposalButton` share ~250 lines of "load proposal → auth check → precondition check → optimistic-concurrency update → edit source DM → send outbound DM." Extract `executeProposalTransition(opts)`. High ROI once a 5th transition shows up (expiry counts as one — tackle this alongside the expiry cron).

### Discord error classification + retry

Rate limits (429), server errors (5xx), and permanent client errors (4xx) all throw identically from `DiscordBotClient`. Callers can't differentiate. Typed error classes + one retry on 429 with a 1s backoff before marking `delivery_status=failed`. Worth doing alongside the expiry-cron slice since that's where retry starts mattering.

### View-mode config centralization

`detectViewMode` + `useTradeUrl` strip-guards drift every time a new view mode ships. We've eaten two silent bugs from this (`?autoBalance=1`, `?trade=<id>`). A single config object listing every mode + its preserve-params would make "new view mode" a one-place change. 3-4 hours. High ROI but no immediate pain; do before the next view mode ships.

### Embed truncation for large proposals

Discord embed field limit is 1024 chars. A proposal with 10+ expensive cards can silently truncate. Add a length check to `formatCardList`; if output exceeds ~900 chars, cap at N cards and append "+X more — open the web app" with the detail URL.

### Chain visualization timeline

Trade detail view currently shows one-hop chain context (↑ counter to / ↓ countered by). A proper timeline walking the FK chain back to the root. Defer until chain depth > 2 actually happens in the wild — right now a timeline would only show two nodes.

### Phase 4 v2 proper

LGS directory, visit announcements, meetup-aware matching, match-alert DMs. See ROADMAP.md Phase 4 v2 for scope.

---

## Done

*(append here as slices ship)*

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
