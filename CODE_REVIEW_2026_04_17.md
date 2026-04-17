# Code review — 2026-04-17

Post-Phase-4c architectural pass. Parallelized across four surfaces
(API/data, Discord integration, frontend, test/CI). Findings
consolidated, cross-referenced, and triaged by impact.

**Verified inaccurate agent claim filtered out:**
Bot review claimed "OAuth token expiration not checked before use."
False — `lib/auth.ts:71-80` does check `discordAccessTokenExpiresAt`
before returning the token, and the `/api/me/guilds/refresh`
endpoint returns 409 on expired/absent tokens. Noted so nobody
chases a ghost.

---

## Top-line read

The codebase is in good shape for the amount of feature surface
it carries. The shape concerns cluster into three themes:

1. **Discord integration is spread across too many sites.** Message
   builders, DM lifecycle, error classification, signature checks,
   and config reads are all scattered. Each new bot feature adds
   3-5 duplicated lines in new places.
2. **Routing + URL state is a fragile hand-maintained config.** Every
   view mode costs two edits (one to `detectViewMode`, one to
   `useTradeUrl` strip-guards). We've already eaten two silent bugs
   here. There's a single-source-of-truth extraction worth doing.
3. **Test duplication is compounding.** `makeFakeBot()` lives in
   4 files; proposal seeding lives in 4 files. Schema changes cost
   4x the work they should.

None of this is urgent in the "production is broken" sense. All of
it will slow down iteration as slices stack up.

---

## CRITICAL

### C1 · Ed25519 signature verification has no timestamp window

**What/where:** `lib/discordSignature.ts:21-54`. Function verifies
the signature against `timestamp || body`, but doesn't check that
the timestamp is close to now. Discord's spec requires rejection
when the timestamp is more than 5 minutes from server time — that's
the anti-replay defense.

**Impact:** A captured signed interaction (e.g., an Accept click
from six months ago, sniffed via a compromised proxy or leaked log)
stays valid forever. Attacker replays → state flips. Low exploit
probability today (no sensitive state flips yet, logs aren't
public), but the defense is cheap and the risk scales with feature
surface.

**Fix:** Add a `maxSkewSeconds: number` option (default 300).
Reject when `Math.abs(Date.now()/1000 - Number(timestamp)) > max`.
Extend the existing signature tests with a future/past timestamp
rejection case.

**Effort:** 20 minutes.

---

### C2 · No indexes on trade_proposals FKs or status

**What/where:** `lib/schema.ts:185-226`. `tradeProposals` defines
FKs via `.references()` for `proposer_user_id`, `recipient_user_id`,
`counter_of_id` — no explicit `.index()`. Queries hit these columns
constantly:
- `handleProposalsList` filters on proposer OR recipient
- `handleGetProposal` selects counter children via `counter_of_id`
- `handleCancel`/`handleCounter`/button handler all load by `id`
  (pk is fine) but update on `(id, status='pending')` for
  optimistic concurrency

Postgres does NOT auto-create indexes on FK columns (unlike MySQL's
InnoDB).

**Impact:** Full table scan on every proposals-list load, every
counter-child lookup. At our current volume it's unobservable. At
10k proposals it'll be a multi-second page load.

**Fix:** Add `.index()` calls in the schema + regenerate migration.
Composite `(proposer_user_id, updated_at desc)` and
`(recipient_user_id, updated_at desc)` for the history query.
Single-column indexes on `counter_of_id` and `status`.

**Effort:** 45 minutes (schema edit + generate + apply + verify
with EXPLAIN).

---

### C3 · Test public-key fallback isn't environment-gated

**What/where:** `api/bot.ts:85-95`. If
`DISCORD_APP_PUBLIC_KEY_TEST` is set, it's tried as a fallback when
the prod key fails verification. The comment warns "never on
Production" but the code accepts it regardless of environment.

**Impact:** If an env var copy-paste accident deploys the test key
to production (happens to everyone eventually), attackers with the
test private key can forge any interaction. The private key is
currently in `.env.local` + a GitHub secret — if either leaks
and the test key reaches prod, game over.

**Fix:** At the top of the file (module load), check
`process.env.VERCEL_ENV`. If it's `'production'`, ignore
`DISCORD_APP_PUBLIC_KEY_TEST` entirely (optionally: log a loud
warning if set). Add a unit test that simulates prod env +
asserts the fallback is inert.

**Effort:** 30 minutes.

---

### C4 · Routing fragility — useTradeUrl strip-guards must track every view mode

**What/where:** `src/App.tsx:44-69` (detectViewMode),
`src/hooks/useTradeUrl.ts:73-84` (strip-guards). Adding a view
mode is two-file surgery. Missing the strip-guard is silent.
We've shipped this bug twice: `?autoBalance=1`, `?trade=<id>`.

**Impact:** Every new query-param-driven view is a latent bug
waiting to ship. Reload-after-delay breaks. Detection only happens
in e2e if a specific test exercises the post-mount URL read path
(we only got lucky with `?trade`).

**Fix:** Extract a single config object listing every view mode:
```ts
const VIEW_MODES = {
  trade:         { detect: (p) => noOtherMatch },
  'trade-detail': { detect: (p) => p.has('trade'), preserveParams: ['trade'] },
  community:     { detect: (p) => p.get('community') === '1', preserveParams: ['community'] },
  ...
}
```
`detectViewMode` iterates the config; `useTradeUrl` reads
`preserveParams` to know what to leave alone. New mode = single
config entry.

**Effort:** 3-4 hours (refactor + coverage). High ROI — prevents
an entire bug class.

---

### C5 · Audit useCallback/useEffect dep arrays for stale-closure traps

**What/where:** System-wide. We hit a real one at
`ProposeBar.tsx` where `handleSend` was missing `message` from
its deps — note shipped silently empty. CounterBar.tsx currently
has similar structure; low-risk, but audit everything newly
written in the last 6 weeks.

**Impact:** Silent field-dropped-on-submit bugs. Every one costs a
CI round-trip to catch if caught at all.

**Fix:** Enable `react-hooks/exhaustive-deps` as an error (not
warning) in `eslint.config.js`. Sweep existing violations.

**Effort:** 1-2 hours depending on sweep count.

---

## ARCHITECTURAL (high ROI, pay off over next 3-4 slices)

### A1 · Duplicated "proposal state transition" pattern across three handlers

**What/where:** `api/trades.ts` handlePropose, handleCounter,
handleCancel, plus `api/bot.ts` handleTradeProposalButton. All
four share the shape: load proposal → auth check → precondition
check → optimistic-concurrency update → edit source DM → optionally
send outbound DM. ~250 lines of near-duplicated code.

**Why painful:** Adding a 5th transition (expiry cron, proposer
retract-and-replace) means copy-paste. Auth/preconditions drift
across handlers. Logging, rate-limiting, metrics have to be added
5 places.

**Fix:** Extract `executeProposalTransition(opts)` that owns the
common shape, with caller-provided `transition(trade) → newStatus`
and `afterUpdate(trade)` hooks for DM side-effects.

**Effort:** 4-6 hours + careful test update.

---

### A2 · ProposeBar + CounterBar are ~80% the same component

**What/where:** `src/components/ProposeBar.tsx`,
`src/components/CounterBar.tsx`. Shared: one-shot fetch with
dedupe ref, auto-apply effect, message disclosure, snapshot
builder, send state machine, data-state attribute.

**Why painful:** Every bug fix to one is likely needed in the
other. Message-stale-closure was only fixed in ProposeBar so far
— need to verify CounterBar (see C5).

**Fix:** Extract a `useComposerBar` hook that owns the state
machine + fetch lifecycle + send orchestration. Keep the two
components as thin wrappers that differ only in seed source and
labels.

**Effort:** 6 hours. Medium ROI now, high ROI if we add a third
variant (e.g., "counter-the-counter via web directly" would be a
third).

---

### A3 · Three separate `TradeCard ↔ CardSnapshot` converters

**What/where:** `ProposeBar.tsx:145-155` (send),
`CounterBar.tsx:156-163` (send), `CounterBar.tsx:127-134`
(seed-from-snapshot). All parse `tc.card.name` with
`.replace(/\s*\([^)]+\)\s*$/, '')` which is fragile — a card name
with legitimate parens breaks variant extraction.

**Why painful:** Every schema or price-format change is a 3-site
update. Regex drift likely.

**Fix:** Move to `src/utils/cardSnapshots.ts` with
`tradeCardsToSnapshots(cards, { pct, priceMode })` and
`snapshotsToTradeCards(snapshots, byProductId)`. Unit test the
variant-parsing edge cases.

**Effort:** 1.5 hours.

---

### A4 · Button interaction dispatch lacks a registry

**What/where:** `api/bot.ts:177-195` — custom_id parsed by
string-split, action validated via a hardcoded set. Adding a
second feature with buttons (LGS visits, match alerts) means
adding another `if (customId.startsWith(...))` branch.

**Why painful:** Dispatcher becomes a growing switch. Testing a
new feature's routing requires mocking the full dispatcher.

**Fix:** Small registry:
```ts
const customIdHandlers: Record<string, (payload) => Promise<void>> = {
  'trade-proposal': handleTradeProposalButton,
  // 'lgs-visit': handleLgsVisitButton, // future
};
```
Parser lives in each feature's module; dispatcher is dumb.

**Effort:** 2 hours.

---

### A5 · Validation convention is inconsistent

**What/where:** `api/trades.ts` uses Zod everywhere. `api/sync.ts`
uses manual casts (`req.body as WantsItemPayload[]`). `api/me.ts`
is mixed — Zod for settings, manual for some others.

**Why painful:** New endpoints guess. Zod + manual cast in the
same dispatcher is a smell. Malformed bodies crash handlers
silently on the manual-cast side.

**Fix:** `lib/validation.ts` with `validateBody(req, res, schema)`
that handles the safeParse + 400 + detail payload in one place.
Convert remaining manual casts.

**Effort:** 2 hours.

---

### A6 · DM lifecycle is inlined in three handlers

**What/where:** `api/trades.ts:208-240` (propose send),
`api/trades.ts:646-699` (counter — edit original + send counter),
`api/trades.ts:481-505` (cancel — edit only). Each inlines
"sendDirectMessage → extract channel_id/message_id → persist → log
error."

**Why painful:** Rate-limit handling, retry, observability have to
be added 3x. Ties into A1 (transition pattern) but stands alone.

**Fix:** `lib/discordDm.ts` with `sendTrackedDm(bot, userId,
payload, { persistIds: (ids) => Promise<void> })`. Returns
`{ status: 'delivered' | 'failed', reason? }`.

**Effort:** 2 hours.

---

### A7 · Test-side duplication (mock bot + seed proposal)

**What/where:** `tests/api/bot.test.ts`, `trades-propose.test.ts`,
`trades-counter.test.ts`, `trades-list-cancel.test.ts` each define
their own `makeFakeBot()` and some variant of `insertProposal()`/
`seedProposal()` helpers. Four separate implementations.

**Why painful:** Schema change to `trade_proposals` is a 4-file
update. Fake bot shapes drift (bot.test has 6 unused methods; counter
adds `editCalls` tracking but not sendCalls).

**Fix:** `tests/api/discordFakes.ts` exporting
`createFakeDiscordBotClient(opts?)`. `tests/api/fixtures.ts`
exporting `seedTradeProposal(overrides)` → `{ id, cleanup }`.
Collapse the four definitions.

**Effort:** 2 hours.

---

### A8 · No central Discord config module

**What/where:** `process.env.DISCORD_*` reads scattered across
`api/bot.ts`, `api/auth.ts`, `lib/discordBot.ts`, with different
failure modes: some return null, some throw from deep inside a
handler, some return 500.

**Why painful:** Deployment starts fine; first user request into a
missing-env path fails cryptically. No single source of truth for
"what Discord envs does this app need."

**Fix:** `lib/discordConfig.ts` with named getters that throw with
a clear message when absent. Call a `validateDiscordConfig()`
function once at module load in every api/* entrypoint so the
failure surfaces at cold-start, not mid-request.

**Effort:** 1 hour.

---

### A9 · Frontend API client is reinvented per hook

**What/where:** Every hook with a `fetch()` call reimplements
error handling. `useServerSync` has a local `fetchJson` helper
that's not shared. `useTradeDetail`, `useTradesList`,
`useCommunityMembers`, `useAccountSettings`, ProposeBar,
CounterBar, SettingsView all inline `fetch + if (!res.ok)`.

**Why painful:** Retry, session-expired, rate-limit-respect,
error-typing all need 10+ edits. The recent "409 already-resolved"
error mapping needed to be re-implemented per-caller.

**Fix:** `src/services/apiClient.ts` exposing
`apiGet/apiPost/apiPut` that return a discriminated `{ ok: true,
data } | { ok: false, status, code, message }`. Single place for
session-expired handling + retry policy.

**Effort:** 3 hours (helper + migrate ~10 call sites + tests).

---

## POLISH

### P1 · Discord error classification + retry

Rate limits, server errors, and permanent client errors all
throw the same way from `DiscordBotClient`. Callers can't
distinguish "retry in 1s" from "user has DMs disabled forever."
Classify errors; retry 429s once with backoff.

**Effort:** 2 hours.

---

### P2 · Function-count headroom

Currently 10 API functions; Hobby ceiling is 12. Expiry cron and
any other new job bumps us against the cap. Either (a) plan now
to consolidate `popular-wants` + `search` + `trending` into one
dispatcher (they're all read-only search surfaces), or (b) accept
that the next new job lives inside an existing file.

**Effort:** 0h now (decision); 2-3h later if we consolidate.

---

### P3 · Observability for delivery_status

`trade_proposals.delivery_status` can be `pending | delivered |
failed` — no alert fires when rows are stuck pending. If a bot
token gets revoked, proposals silently fail without anyone
noticing.

**Effort:** 1-2 hours for a cron-backed healthcheck that logs
counts of stuck rows.

---

### P4 · No Tier 2 nightly Discord probe

`PHASE4_TESTING.md` reserved space for this. With the bot live in
beta, a minimum-viable probe (hit `/users/@me` + `/gateway` with
the bot token, assert response shape) is a ~60-line nightly action.

**Effort:** 2-3 hours.

---

### P5 · Auth e2e may not need `workers: 1` anymore

Constraint was added for StrictMode double-mount + parallel worker
DB contention during Phase 4a. Tests have since moved to
per-worker isolated users (`createIsolatedUser`). Worth a spike:
run with `workers: 2` on a branch and watch for flakes.

**Effort:** 1 hour spike.

---

### P6 · Missing `APPLICATION_UNAUTHORIZED` event handler

`api/bot.ts:handleEvent` processes `APPLICATION_AUTHORIZED` but
not the uninstall event. `bot_installed_guilds` rows accumulate
forever. Harmless today, gets noisy at scale.

**Effort:** 30 minutes.

---

### P7 · `data-state` attribute is ad-hoc across 3 components

ProposeBar, CounterBar, AutoBalanceBanner expose `data-state` for
e2e; other stateful views don't. Either formalize (every composite
stateful view exposes one, documented convention) or drop.
Lightly recommend formalizing — `data-state` beats timing-fragile
text assertions in tests.

**Effort:** 1.5 hours (audit + formalize).

---

### P8 · Prop drilling: `wants`, `available`, `byProductId`

Drilled through App → TradeSide → pickers. Each intermediate
layer just passes through. A `CardIndexContext` + `UserDataContext`
would collapse ~20 lines of pass-through and make "I need card
lookup" a one-line hook call.

**Effort:** 4 hours. Not urgent; pay when the drilling makes a
specific change painful.

---

### P9 · Discord DM embed field-name inconsistency

`buildProposalMessage` uses "They're offering" / "They're asking
for". `buildResolvedProposalMessage` uses "Offered" / "Asked for".
`buildCounteredProposalMessage` uses "Offered" / "Asked for".
Users switching between variants will see the inconsistency.

**Effort:** 15 minutes.

---

### P10 · Counter row orphan-on-cleanup-failure

`handleCounter` inserts the counter row, then runs optimistic-
concurrency update on the original. On 409, it tries to delete
the inserted row but swallows any error with `.catch(() => {})`.
If Neon had a transient hiccup precisely at cleanup time, the
orphan row stays indefinitely.

Downgrade from Critical (agent had it there): the failure rate is
essentially zero today and the orphan is harmless until a future
feature tries to enumerate `counterOfId`-rooted chains. But log
the cleanup failure for observability.

**Effort:** 20 minutes.

---

## Suggested order

If picking a subset, I'd do these first:

1. **C1** (timestamp window) — 20 min security fix, no reason not to.
2. **C2** (FK indexes) — 45 min, prevents a compounding scale cliff.
3. **C3** (test key env-gate) — 30 min, closes a foot-shot.
4. **A7** (test dedup) — 2 hours, unblocks future test additions.
5. **C4** (routing config) — 3-4 hours, kills a bug class.
6. **C5** (useCallback ESLint sweep) — 1-2 hours, cheap insurance.
7. **A3** (snapshot converter extract) — 1.5 hours, pairs with A2.
8. **A9** (API client) — 3 hours, foundational for later slices.

That's roughly 12-15 hours of work and closes the most repeatedly-
bitten issues. Everything else can land opportunistically as the
relevant feature area gets touched.
