# Infra — build, deploy, CI, testing

> **Owner scope**:
> - `vercel.json` (function-ceiling rewrites), `middleware.ts` (edge crawler SSR)
> - `package.json`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`
> - `vite.config.ts`, `eslint.config.js`, `src/main.tsx`, `src/version.ts`, `src/vite-env.d.ts`
> - `playwright.config.ts`, `playwright.auth.config.ts`, `vitest`-under-vite config in `vite.config.ts`
> - `e2e/_fixtures.ts`, `e2e/helpers/**` (auth, seed, guilds, global-setup, discordSign, waitFor*, openMyLists)
> - `tests/api/helpers.ts`, `tests/api/discordFakes.ts`, `tests/fixtures.ts`
> - `.github/workflows/ci.yml`, `.github/workflows/refresh-prices.yml`
> - `.husky/pre-commit`
> - `drizzle.config.ts`, `drizzle/**` (migrations + `meta/_journal.json`)
> - `scripts/gen-fonts.ts`, `scripts/fetch-prices.ts`, `scripts/enrich-cards.ts`, `scripts/register-discord-commands.mjs`, `scripts/discord-admin.mjs`
>
> Schema-level DB details (tables / columns / invariants) belong to the owning area page (sessions, trades, lists, etc.); this page documents the **mechanics** of migrations, not their content.

## Overview

SWUTrade is a Vite-built React SPA served by Vercel, with serverless functions under `api/*.ts` doing all the writes against a Neon Postgres. There is no Next.js — every `api/*.ts` is a raw `@vercel/node` handler, and every page route is the SPA shell at `/` with `vercel.json` rewrites translating pretty URLs into query params the handlers parse. CI is a four-job GitHub Actions pipeline that runs in parallel with the automatic Vercel preview deploy; deploys are **never gated** on CI — the preview is live the moment Vercel is done building, and CI's only job is to verify after the fact.

The load-bearing decision in the whole subsystem is **function consolidation**: Vercel's plan caps the number of deployed serverless functions, and hitting that cap fails builds silently at "Deploying outputs…". So instead of an `api/sessions/create.ts` + `api/sessions/get.ts` + `api/sessions/cancel.ts` tree, SWUTrade ships one `api/sessions.ts` with a `?action=<name>` dispatcher and `vercel.json` rewrites mapping the pretty URLs onto it. **If you think a file is missing, check `vercel.json` first** — it almost certainly is a rewrite target of an existing dispatcher.

## Key concepts / glossary

- **Function ceiling** — Vercel plan cap on serverless function count. SWUTrade stays under it by consolidating into dispatcher files (`api/me.ts`, `api/bot.ts`, `api/sessions.ts`, `api/trades.ts`, `api/auth.ts`, `api/sync.ts`). Hitting the ceiling causes a silent deploy failure — see memory `project_swutrade_function_ceiling`.
- **Dispatcher file** — a single `api/*.ts` whose default export switches on `req.query.action` and returns one of N sub-handlers. Pattern documented in `api/context.md:41`.
- **Pretty-URL rewrite** — a `vercel.json` entry that maps e.g. `/api/sessions/:id/cancel` → `/api/sessions?action=cancel&id=:id`. The browser sees the first form; the function sees the second.
- **Auth e2e vs anonymous e2e** — two Playwright configs. `*.spec.ts` runs locally + in CI against `vercel dev` / dev server (anonymous — no DB required). `*.auth.spec.ts` runs CI-only against the Vercel **preview URL** with a bypass header, and locally against `vercel dev`. Memory `feedback_auth_e2e_gap`: `npm run e2e` **excludes** the auth specs, which is a footgun for UI changes.
- **Between-slice ritual** — the `gh run list --branch beta --limit 1` check codified in `NEXT.md:16-28`. Don't start slice N+1 on top of a red CI for slice N.
- **Preview protection bypass** — Vercel's Deployment Protection SSO-walls preview URLs by default. CI and third-party webhooks get past via an `x-vercel-protection-bypass` header. Disabled entirely on beta as of 2026-04-16 (memory `project_swutrade_vercel_protection`).
- **Drizzle journal** — `drizzle/meta/_journal.json` is the ordered migration manifest. Version 7, PostgreSQL dialect, 19 entries as of 0018 (see `drizzle/meta/_journal.json:1`).
- **`isBetaChannel()`** — `src/version.ts:11`, runtime host-based predicate that decides whether to render the Beta pill. Treats localhost as beta so dev builds visually match preview.
- **`APP_COMMIT` / `APP_BUILD_TIME`** — Vite `define` constants baked at build time. Populated by `vite.config.ts:6-17` — prefers `VERCEL_GIT_COMMIT_SHA` (short-form), falls back to `git rev-parse HEAD`, falls back to `"dev"`.
- **`#releases` CI notifier** — three-step GitHub Actions job set (`notify-start`, `notify-live`, `notify-finish`) that posts a single Discord message and PATCHes it in place as CI progresses. Unicode emojis (not shortcodes — `:white_check_mark:` renders wrong because Discord's markdown parser reads the underscores as italic markers; see `ci.yml:346-349`).

## File map

### Vercel config

**`vercel.json`** — The whole file is rewrites. No `crons` field (despite `api/context.md:69-70` claiming otherwise — that paragraph is stale; today's cron lives in GitHub Actions). Rewrites are ordered: pretty-URLs first, catch-all `"^/api/(.*)"` last, so a single-purpose endpoint (`api/search.ts`, `api/og.ts`, `api/popular-wants.ts`, `api/trending.ts`) stays reachable without an explicit rewrite.

**`middleware.ts`** — Edge middleware that only activates for bot user-agents on `/` and `/u/:handle`. Emits OG-tagged HTML so link previews in Discord/Twitter/etc. get cards instead of "Redirecting…". Lives at the repo root (Vercel auto-detects). Not part of any function — counts against the middleware budget, not the function ceiling.

### Build + runtime

**`package.json`** — Script surface:
- `npm run dev` → `vite` (SPA dev server on `:5173`; no API).
- `npm run build` → `tsx scripts/fetch-prices.ts && tsx scripts/enrich-cards.ts && vite build`. Price + enrichment scripts run *at build time* so they're baked into `public/data/`. `build:fresh` forces re-fetch via `FETCH_PRICES=1` / `ENRICH=1`.
- `npm run typecheck` → `tsc -b --force`. **This is what CI runs.** Don't substitute `tsc --noEmit` (memory `feedback_typecheck_command`: `--noEmit` skips project references and misses errors the build-mode check catches).
- `npm run test` / `test:run` → `vitest` / `vitest run`.
- `npm run e2e` → non-auth Playwright (`testIgnore: '**/*.auth.spec.ts'` in `playwright.config.ts:12`).
- `npm run e2e:auth` → auth Playwright against `playwright.auth.config.ts`.
- `npm run db:generate|migrate|studio` → drizzle-kit passthroughs.
- `npm run gen:fonts` → regenerates `api/_fonts.ts` from the TTFs in `scripts/fonts/` (see below).
- `npm run prepare` → husky install on post-`npm ci`.

**`vite.config.ts`** — React + Tailwind v4 plugin, and an inline Vitest config stuffed under a `@ts-expect-error` at line 25 (vitest extends the vite type, but the ambient types in `vite/client` don't know about it). Test pool is explicitly `threads` + `maxThreads: 4` (line 30-32) — API tests hit a shared Postgres and don't tolerate the default fork pool (worker-level globals in `tests/api/helpers.ts` get torn down incorrectly between child processes).

**`tsconfig.json`** — Solution file with two references: `tsconfig.app.json` (SPA — DOM lib, `include: src`) and `tsconfig.node.json` (server — Node types, `include: vite.config.ts, lib/**, drizzle.config.ts`). The split is why `tsc -b --force` is the right typecheck: `--noEmit` against `tsconfig.app.json` alone misses errors in `lib/` or `api/`.

**`src/main.tsx`** — App entry. ErrorBoundary sits *outside* the providers intentionally (comment at line 11-14) so a throw in provider init still yields the fallback UI instead of a blank page.

**`src/version.ts`** — Three exports:
- `APP_COMMIT` (from `__APP_COMMIT__` Vite define)
- `APP_BUILD_TIME` (ISO string at build time)
- `isBetaChannel()` — host-based predicate that treats `beta.*`, `*-git-beta-*.vercel.app`, and localhost as beta. Used by `BetaBadge.tsx:14` and `App.tsx:827-832` to flip the footer between "v" + SHA (stable) and "beta · SHA · built Xm ago" (beta/dev).

**`src/vite-env.d.ts`** — Declares the two `__APP_*__` globals so TS doesn't complain in consumers.

**`eslint.config.js`** — Flat config: `@eslint/js` recommended, `typescript-eslint` recommended, `react-hooks` flat, `react-refresh` for Vite. `globalIgnores(['dist'])`. No Prettier integration — formatting is editor-driven.

### Tests

**`playwright.config.ts`** — Non-auth config. `testIgnore: '**/*.auth.spec.ts'` (line 12). Local: `chromium` only. CI: adds `mobile-chrome` (Pixel 7) — anonymous UI has to work on both form factors. Starts `npm run dev` as its own webServer.

**`playwright.auth.config.ts`** — Auth-only config. `testMatch: '**/*.auth.spec.ts'` (line 17). **`fullyParallel: false, workers: 1`** intentionally (comment at line 18-24): every test writes to one shared Neon DB, and React StrictMode's double-mount caused second-fetch timeouts when workers queued at the server side. Serial is slower but deterministic. Locally it boots `vercel dev --listen 3000`; in CI it gets `PLAYWRIGHT_BASE_URL` pointed at the preview URL and skips the webServer. Bypass header injected via `extraHTTPHeaders` when `VERCEL_AUTOMATION_BYPASS_SECRET` is set (line 33-37).

**`e2e/_fixtures.ts`** — Extends Playwright's `test` with a `consoleErrors` collector that catches both `console.error` and unhandled `pageerror` events. Ships `filterConsoleErrors()` and `expectNoConsoleErrors()`. The filter whitelist is deliberately narrow:
- `401|404` on "Failed to load resource" — anonymous viewers hit auth-gated endpoints constantly; not-found ids are legitimate test inputs.
- `blocked by CORS policy` and `fonts.gstatic.com` — Playwright's `extraHTTPHeaders` applies the bypass header to **every** request, including CDN font fetches, which CORS-blocks anything not in the preview origin's allow-list. Not a real bug.
- `net::ERR_FAILED` — companion to the CORS block.

Broad filters would mask the exact CJS-interop / render error class this fixture was introduced to catch (the Live Trade ship went out with a runtime error that only surfaced in browser console — CI missed it because no existing spec was checking).

**`e2e/helpers/auth.ts`** — `signIn(context, user)` seals a test session cookie directly using `iron-session` and `SESSION_SECRET`, skipping OAuth. `createIsolatedUser()` (line 40-49) uses `crypto.randomUUID` + a module counter because a per-process counter alone collides across Playwright workers at the same `Date.now()` millisecond (comment at line 30-39 is a postmortem). `ensureTestUser`, `cleanupTestUser`, `createSenderFixture`, `seedUserLists` are the DB-side fixtures (dynamic imports so anonymous specs don't pull in `lib/db.js`).

**`e2e/helpers/seed.ts`** — Standalone entry (`npx tsx e2e/helpers/seed.ts`) that upserts the default `TEST_USER`. Invoked by the CI auth job before running the auth suite (`ci.yml:229-230`). Also invoked programmatically by specs that use the shared user.

**`e2e/helpers/global-setup.ts`** — Optional `globalSetup` for local runs. Only seeds when `POSTGRES_URL` is set so the anonymous config doesn't need DB.

**`e2e/helpers/guilds.ts`** — Phase-4 guild fixtures (`installBotInGuild`, `createGuildMembership`, `getGuildMembership`, `getUserSettings`). Mirrors `tests/api/helpers.ts` so e2e and vitest can seed the same shapes.

**`e2e/helpers/discordSign.ts`** — Synthesizes signed Discord interaction payloads for the signed-interaction e2e spec. Generates a fresh Ed25519 keypair per run; the test skips unless `DISCORD_APP_PUBLIC_KEY_TEST` on the Preview deploy matches the generated public key. Pairs with a "Seed test user" step in CI and with `DISCORD_TEST_PRIVATE_KEY_B64` (ci.yml:205, 220-221).

**`e2e/helpers/waitForApp.ts`** — `waitForPricesLoaded(page)` — waits for the positive "Prices updated Xm ago" footer signal. Using a falsy "not loading" check raced past initial state where `loadAllSets` hadn't fired yet.

**`e2e/helpers/waitForSignedIn.ts`** — Waits on the "Account menu" button being visible. Replaces the old header-username-text check since the consolidated header moved the username into the popover.

**`e2e/helpers/openMyLists.ts`** — Two-click drawer opener. Historical note: "Open my lists" started top-level, moved into AccountMenu, now lives in NavMenu — this helper is the single seam that kept specs from churning on each move.

**`tests/api/helpers.ts`** — The vitest-side harness:
- `describeWithDb` — `process.env.POSTGRES_URL ? describe : describe.skip`. Fork PRs without secrets get a clean skip instead of a misleading failure.
- `mockRequest` / `mockResponse` — `@vercel/node` typed mocks so handlers can be called directly without spinning up an HTTP server. `_status`, `_json`, `_body`, `_headers`, `_redirectUrl` are all inspectable on the response.
- `sealTestCookie` — seals an iron-session cookie the way `/api/auth/callback` does, so tests can assert authenticated paths without OAuth.
- `createTestUser`, `insertWant`, `insertAvailable` — DB fixtures with bundled `cleanup()` closures.
- `installBotInGuild`, `createGuildMembership`, `createMutualGuildMembership` — the guild trio. The mutual variant (line 239-253) inserts the bot + both users in one call and returns a reversed cleanup chain.
- `createFakeDiscordClient` — in-memory `DiscordClient` seeded by access-token → guild-list.

**`tests/api/discordFakes.ts`** — `createBaseFakeBot(overrides)` returns a `DiscordBotClient` where every method defaults to a throwing stub ("method X was called but the test didn't configure it"). Introduced after a "test-file-dedup" NEXT slice replaced seven bespoke `makeFakeBot()` copies that each drifted when the interface grew (private threads, channel creation, etc.). Also ships `EditCall`/`SendCall`/`PostCall` recorder types so individual tests don't redeclare inline array types.

**`tests/fixtures.ts`** — Older/smaller shared vitest fixtures; lighter than `tests/api/helpers.ts`.

### CI / git hooks

**`.github/workflows/ci.yml`** — The four-job pipeline (see full walkthrough below).

**`.github/workflows/refresh-prices.yml`** — Every 2 hours (UTC), POSTs the `VERCEL_DEPLOY_HOOK` with `?buildCache=false` so prices re-fetch. Captures the HTTP status explicitly and fails the job on non-2xx (bare curl would exit 0 even on a 401, silently letting prices go stale).

**`.husky/pre-commit`** — One line: `npm run typecheck`. Comment (`pre-commit:1-8`) explains why: mirrors the first thing CI runs, fast enough not to block commits, catches the bulk of what would turn CI red. Escape hatch: `git commit --no-verify`.

### Migrations

**`drizzle.config.ts`** — drizzle-kit config. `schema: './lib/schema.ts'`, `out: './drizzle'`, `dialect: 'postgresql'`, credentials from `POSTGRES_URL_NON_POOLING`. The non-pooling URL is deliberate — drizzle-kit uses long-lived transactions for migrations that don't play nicely with pgBouncer.

**`drizzle/NNNN_*.sql`** — Generated migration files, ordered by four-digit prefix. Auto-named (`drizzle-kit generate` picks the suffix). Naming convention: don't rename files after they've been committed — the journal keys off the `tag` and any rename desyncs the two.

**`drizzle/meta/_journal.json`** — Ordered manifest. Each entry has `idx`, `version` (drizzle's internal format, currently 7), `when` (ms epoch), `tag`. 19 entries as of 0018 (see `drizzle/meta/_journal.json:130-136` for the tail).

**`drizzle/meta/NNNN_snapshot.json`** — Per-migration schema snapshots used by drizzle-kit to diff the next generate. Don't hand-edit; regen if merging branches with divergent migrations.

**`lib/db.ts`** — Minimal drizzle client (11 lines). `getDb()` lazy-constructs per call; `@neondatabase/serverless`'s `neon(url)` caches the HTTP connection so this is cheap. No singleton — serverless functions each call `getDb()`.

### Scripts

**`scripts/gen-fonts.ts`** — Reads `scripts/fonts/inter-{400,700,900}.ttf`, base64-encodes them, writes `api/_fonts.ts` as three `export const` strings. Run after updating the font files (`npm run gen:fonts`). Inlined so the OG image function (which renders via `resvg-js`) can load fonts in all environments — including preview deploys behind Vercel auth, where a static-asset URL would 401. The alternative (fetching fonts at request time from gstatic / the same origin) fails per `project_swutrade_ogimage` — `/tmp` writes only, ESM JSON imports, never self-fetch own origin.

**`scripts/fetch-prices.ts` / `scripts/enrich-cards.ts`** — Build-time data pipeline. Invoked by `npm run build` before `vite build`. `FETCH_PRICES=1` / `ENRICH=1` force re-fetch bypassing their own caches. Outputs land in `public/data/` so the built SPA serves them from Vercel's CDN (not an API call). See `h-cards-pricing.md` for what they actually do.

**`scripts/register-discord-commands.mjs` / `scripts/discord-admin.mjs`** — One-off Discord ops scripts. Covered by `i-discord-bot.md` — not CI-adjacent.

## Data model

This area doesn't own schema tables. What it owns is the *shape of the migration story*:

- **Append-only migrations** — files are never edited after merging. A bad migration gets a follow-up migration that fixes forward.
- **No rollback story.** There's no `down` migration, no revert script. Every schema change is forward-only; if a migration lands wrong, the fix is another migration — plus (if the wrong state leaked to prod) hand-written SQL via the neon console.
- **Schema ↔ migration pairing** — changing `lib/schema.ts` without running `drizzle-kit generate` will typecheck locally but diverge from the DB at runtime. The `_journal.json` version bump is the loudest signal when you forget (`lib/context.md:25`).
- **`restriction_key` normalization** — `lib/shared.ts#restrictionKey()` produces a deterministic string from a `{mode, variants?}` restriction. Lives here because it's isomorphic (client + server need the same output for the `wants_user_family_restriction` unique index to fire correctly). Memory `project_swutrade_bugs`: `normalizeRestriction()` collapses all-variant-selected restrictions to `mode: 'any'` on read to avoid corruption.

The first migration `0000_even_flatman.sql` shows the starting schema (`users`, `wants_items`, `available_items`); the tail `0018_premium_cammi.sql` shows the state after ghost users + anonymous session participants landed (`users.is_anonymous`, `trade_sessions.user_b_id` made nullable). Anything between is an incremental addition — no drops of data-carrying columns.

## Public surface

### Local development workflows

**`npm run dev`** — Vite dev server on `localhost:5173`. No API. Fine for pure UI work; hits fall through to the static `/data/*.json` files (no `/api/*`).

**`vercel dev`** — Boots Vite *and* the `/api/*` serverless functions locally on `localhost:3000`. Required for auth / sync / proposal / session work. Pulls env from the linked Vercel project via `vercel env pull`. Note that `api/bot.ts` signature verification uses the production public key unless `DISCORD_APP_PUBLIC_KEY_TEST` is set — local Discord interactions usually run against ngrok → preview, not `vercel dev`.

**`npx vitest run`** — Unit + API integration tests. Unit tests (`src/**/*.test.ts`, `tests/lib/*.test.ts`) run with no env. API tests (`tests/api/*.test.ts`) require `POSTGRES_URL` — without it, `describeWithDb` (helpers.ts:17) flips the entire suite to `describe.skip` so unit tests still run.

**`npx playwright test`** — Non-auth only (chromium locally, chromium + mobile-chrome in CI). Starts `npm run dev` automatically.

**`npm run e2e:auth`** — Runs locally against `vercel dev --listen 3000`, or against `PLAYWRIGHT_BASE_URL` in CI. Requires `SESSION_SECRET` + `POSTGRES_URL_NON_POOLING` in `.env.local` to seal cookies and seed data.

### Env var handling

- `vercel env pull .env.local` (or `--environment=preview --git-branch=beta`) is the canonical way to sync envs.
- Memory `feedback_env_vars`: when piping secrets into `vercel env add`, use `printf` not `echo` — echo appends a trailing newline that breaks signature verification.
- Memory `feedback_vercel_env`: `vercel env add NAME preview beta --yes --force --value VALUE` for the preview scope — it requires an explicit git branch arg.

## State + data flow

### The four-job CI pipeline

`.github/workflows/ci.yml` has four "work" jobs plus three "notify" jobs, glued with explicit `needs` dependencies:

```
notify-start ──┐
               │
check ─────────┼─────→ wait-for-deploy ──→ e2e-authenticated
                                │                │
e2e-anonymous ─────────────────┤                 │
                                │                │
                                ↓                │
                            notify-live          │
                                ↓                ↓
                            notify-finish (always, PATCH)
```

**Job 1: `check`** (`ci.yml:53-79`) — `tsc -b --force`, then `vitest run`, then `vite build`. Runs on push and PR. Needs `POSTGRES_URL` + `SESSION_SECRET` secrets (fork PRs without them cleanly skip the DB-requiring tests via `describeWithDb`).

**Job 2: `e2e-anonymous`** (`ci.yml:81-130`) — Runs in parallel with `check`. Caches `public/data` + `scripts/cache` by ISO week (`steps.weekkey.outputs.key`), and caches Playwright browsers by `package-lock.json` hash. On cache miss, fetches prices + enrichment. Runs `npm run e2e` (chromium + mobile-chrome via the CI branch of `playwright.config.ts:27-29`). Uploads `playwright-report/` on failure.

**Job 3: `wait-for-deploy`** (`ci.yml:132-187`) — Push-events only. Polls the GitHub deployments API (40 attempts × 15s = 10min) for a deployment matching `github.sha`. The poll explicitly short-circuits on `state=failure|error` — without that early-exit, a failed deploy would eat the full 10-minute poll while `e2e-authenticated` waited on its own timeout, masking the real error behind a generic timeout (comment at `ci.yml:160-163`). Verifies reachability with the bypass header before emitting `url=…` as a job output.

**Job 4: `e2e-authenticated`** (`ci.yml:189-246`) — Runs against `PLAYWRIGHT_BASE_URL` from Job 3's output. Writes its env vars to `.env.local` so dotenv-sourced code paths pick them up. Seeds the test user via `npx tsx e2e/helpers/seed.ts`, then runs `npm run e2e:auth`. Uploads both `playwright-report/` **and** `test-results/` on failure — the latter is where `trace.zip`, screenshots, and videos land per the auth config's `trace: on-first-retry` (comment at `ci.yml:237-240`).

**Deploy gating** — **CI does not gate the Vercel deploy.** Vercel listens to the push directly and starts building the moment the commit lands. CI runs in parallel. Consequences:

1. Preview URLs go live *before* CI finishes. That's intentional — dogfooding on the preview is part of the between-slice ritual.
2. A green checkmark on the deploy does not imply a green CI — check both.
3. If `check` fails but the deploy is fine, **the preview is still live with broken code**. Rollback is a follow-up revert commit (`feedback_deployment`: don't unprompted `vercel --prod`).

**Notifier flow** (`ci.yml:17-387`):

1. **`notify-start`** fires in parallel with `check` + `e2e-anonymous`. POSTs a "🚀 deploying [sha]" message to `DISCORD_RELEASE_WEBHOOK_URL?wait=true` so the response carries the message id; captures that id as an output.
2. **`notify-live`** waits on `wait-for-deploy` success and PATCHes the same message to "🟢 live … still verifying" with a direct preview link. Gives users a green-lit link the moment it's clickable, without having to wait for CI.
3. **`notify-finish`** always runs (`if: always()`), needs *every* upstream job including `notify-live` (the latter to avoid a race where notify-live and notify-finish land out of order and briefly regress the final state). PATCHes to final state with a three-bucket outcome: `failure > cancelled > success` (comment at `ci.yml:317-322`). Per-job breakdown emojis **only on failure** — a healthy run shouldn't repeat four ✅ after the header. Unicode emojis directly, not shortcodes (`ci.yml:346-349` documents why: shortcode underscores get parsed as italics).

### Deploy model

- **`beta` is the active dev branch.** Push directly, no PRs for feature work (memory `feedback_workflow`). Automatic push-after-commit once a commit succeeds on beta (memory `feedback_push_after_commit`).
- **`main` is promoted from beta**, not where code lands first.
- **Price refreshes**: `.github/workflows/refresh-prices.yml` fires a Vercel deploy hook every 2 hours with `buildCache=false`, so the `npm run build` step (which includes `fetch-prices.ts`) re-fetches from TCGPlayer. There is **no Vercel cron**. The earlier `api/context.md:69-70` paragraph claiming vercel.json declares crons is stale — delete on next pass through that file.
- **Don't redeploy unprompted** (memory `feedback_deployment`). Beta pushes trigger deploys automatically; `vercel --prod` is for main promotions and only when asked.

### Vercel protection + bypass

- Preview deploys were SSO-walled by default, which meant third-party webhooks (Discord interactions, OAuth callbacks) saw an HTML 401 they couldn't auth past (memory `project_swutrade_vercel_protection`). This broke every end-to-end webhook test.
- **Disabled on beta 2026-04-16** to unblock webhooks. Still enabled on production (assumed — not re-verified in this pass).
- CI gets past via `x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET` — injected via `playwright.auth.config.ts:33-37` into every request the browser makes.

### Husky pre-commit

`.husky/pre-commit` runs `npm run typecheck` before the commit leaves the working tree. Catches the TypeScript errors that would fail `check` in CI. Fast enough to be transparent; escape hatch is `git commit --no-verify` when knowingly committing work-in-progress. **Do not** add vitest or playwright here — the two are slow and CI catches them fine.

Key footgun: running `tsc --noEmit` (e.g. from an IDE) is weaker than `tsc -b --force` because `--noEmit` skips project references. A commit can pass IDE typecheck and fail CI. Use `npm run typecheck` or `tsc -b --force` directly (memory `feedback_typecheck_command`).

### Migration mechanics

1. Edit `lib/schema.ts`.
2. `npm run db:generate` — drizzle-kit diffs the last `meta/NNNN_snapshot.json` vs the current schema and emits `drizzle/NNNN_*.sql` + a new snapshot + updates `_journal.json`.
3. `npm run db:migrate` — applies all un-applied migrations against `POSTGRES_URL_NON_POOLING`.
4. Commit the generated SQL + snapshot + journal *in the same commit* as the schema change. Splitting them across commits means anyone between those commits sees a schema that doesn't match the DB.

**The drizzle journal hang** — per project history, `drizzle-kit migrate` sometimes hangs indefinitely on its initial journal-read. A `_apply-migration.mts` bypass using raw `neon()` to apply the SQL files directly was used historically to escape the hang. That script isn't in the tree currently (not in `scripts/`, not in `drizzle/`; `git log --all` didn't surface it either), so the escape hatch today is to copy the raw SQL from the newest `drizzle/*.sql` into the Neon console and run it manually, then backfill the `__drizzle_migrations` table entry so drizzle-kit doesn't re-apply on next run. **Tech debt** — see below.

### Console error collection

Every auth e2e spec should end with `expectNoConsoleErrors(consoleErrors)` before the final assertion. The fixture catches both `console.error` and `pageerror` (unhandled uncaught exceptions), filters the known-noise set, and asserts empty. When adding a new spec that legitimately emits noise (e.g. hitting an intentional 500 to assert UI recovery), extend `filterConsoleErrors` rather than removing the check — the filter is deliberately narrow.

### Build-time data pipeline

`npm run build` does three things in sequence:

1. `tsx scripts/fetch-prices.ts` — fetches TCGPlayer prices, writes `public/data/prices*.json` (respects its own cache unless `FETCH_PRICES=1`).
2. `tsx scripts/enrich-cards.ts` — fetches card enrichment data, writes `public/data/cards*.json` + `public/data/family-index.json` (respects cache unless `ENRICH=1`).
3. `vite build` — bundles the SPA + middleware.

Because step 3 runs *after* 1+2, the bundler sees the final data files. They ship to the CDN as static assets — the client loads them via plain `fetch('/data/foo.json')`, never through `/api/*`.

## UI/UX patterns

Backend-leaning area — no UI patterns owned. One runtime-visible surface:

**Beta pill + version footer.** `BetaBadge.tsx` renders on `isBetaChannel()` — hover reveals `Beta build <SHA> · <built-at>`. `App.tsx:820-834` renders a footer pill: on beta `"beta · <SHA> · built <Xm ago>"` in gold, on stable `"v <SHA>"` in gray. Both are freshness indicators for dogfooding — if you make a code change and the commit on-screen isn't yours yet, the deploy isn't done. Memory `project_swutrade_palette`: gold is primary chrome here; avoid inlining hex.

## Tech debt + known gaps

### Function ceiling headroom

Current `api/*.ts` files at the top level: `auth.ts`, `bot.ts`, `me.ts`, `og.ts`, `popular-wants.ts`, `search.ts`, `sessions.ts`, `sync.ts`, `trades.ts`, `trending.ts` plus the `api/user/[handle].ts` dynamic route = **11 functions** (plus `_fonts.ts` which is imported by `og.ts` and not a function in its own right — its name is a lower-dash convention to mark it non-routable). `api/context.md:9` mentions a 12-function Hobby cap as the historical driver. If headroom has improved on the current plan tier, it's still worth consolidating new surfaces into existing dispatchers rather than finding out the hard way. Any greenfield endpoint should start inside `api/me.ts` (authenticated user ops) or `api/sessions.ts` (session ops) or carve out a new dispatcher only when the shape genuinely doesn't fit.

### Stale `api/context.md` note

`api/context.md:67-70` claims "`vercel.json` declares crons; each points at an `api/cron/*.ts` file. The refresh-prices cron is the only active one today." This is wrong at time of writing: `vercel.json` has no `crons` field and there is no `api/cron/` directory. The actual price refresh is `.github/workflows/refresh-prices.yml` firing a Vercel deploy hook. Fix on next touch.

### Drizzle journal hang → no tree-checked escape hatch

The `_apply-migration.mts` raw-neon bypass script lives only in the memory `project_next_md_queue` / commit-history lore — it's not in `scripts/` today. A future hang means writing the bypass ad-hoc. Consider codifying it: `scripts/apply-migration.mts` that reads `drizzle/*.sql` sequentially via `@neondatabase/serverless` and updates `__drizzle_migrations` by hand.

### No migration rollback

Every schema change is forward-only. A fix-forward migration is always an option; a "revert this column" is not. For destructive changes (column drop, unique-constraint add), the practical guard is to stage the migration on beta, dogfood for a day, then promote. No deeper safeguard exists.

### Auth e2e is serial (workers: 1)

`playwright.auth.config.ts:23-25` documents why — StrictMode double-mount under shared-DB contention. Real cost: the suite's wall time scales linearly with test count. If it crosses ~3 minutes, the mitigation is per-test isolated users (`createIsolatedUser` in `e2e/helpers/auth.ts:40`) + a connection-per-worker DB pool — not flipping `workers: 1` → many without doing that plumbing first.

### `npm run e2e` does NOT cover auth specs

Easy to forget, and biting enough to have earned its own memory entry (`feedback_auth_e2e_gap`). Before pushing any UI change, `grep -l auth.spec.ts e2e/` to see whether the affected surface has auth coverage, and run `npm run e2e:auth` if so. CI will catch it either way, but catching it locally is 4× faster.

### `check` depends on `POSTGRES_URL` for full coverage

Fork PRs from contributors without access to our Neon secrets will clean-skip the DB-requiring API tests (`describeWithDb`). The unit tests still run, but the merge button looks greener than it is. Acceptable because we don't accept unrelated-contributor PRs often — if that changes, we'll need a CI-owned shadow DB for PR branches.

### Between-slice ritual is human-executed

`NEXT.md:16-28` codifies it, but there's no script that runs `gh run list --branch beta --limit 1 --json conclusion,status` + `npx tsc -b --force` + `npx vitest run` before accepting a new slice. The habit is the guard. Memory `feedback_check_prior_ci` is the reminder; the failure mode is stacking commits on top of a red CI, which turns every subsequent "ci failed" Discord ping into noise.

### `vite.config.ts:25` `@ts-expect-error`

The vitest-config-under-vite-config pattern needs a `@ts-expect-error` because `vite/client`'s ambient types don't declare the `test` key. Non-critical; the first thing to look at if a vitest config option silently no-ops. An explicit `import { defineConfig } from 'vitest/config'` would paper over it but requires splitting the config.

### No formal fuzz / property tests

All tests are example-based. Migration-resilience tests (`src/persistence/migration.test.ts`) cover a few known-bad v1 shapes but won't catch a future v3 that's a superset of v2 with a silent field-meaning change.

## Decisions worth remembering

### Function consolidation over sub-directories

One `api/sessions.ts` with `?action=` > six files under `api/sessions/`. **Why**: Vercel plan ceiling, silent failure mode. The UX downside (slightly weirder handler files, dispatcher switch statements) is far cheaper than a deploy that silently succeeds on some routes and drops others.

### `vercel.json` rewrites over client-side URL munging

Pretty URLs (`/api/sessions/:id/cancel`) stay in the browser history and the bot's webhook URLs. Clients never see `?action=cancel`. **Why**: the client-facing surface stays stable even as we reshape the function topology. If we ever do get headroom to split `api/sessions.ts` back into files, clients don't need updating — only `vercel.json`.

### CI notifier emits Unicode, not shortcodes

`✅` not `:white_check_mark:`. **Why**: Discord's markdown parser reads the underscores in `:white_check_mark:` as italic delimiters and breaks both the emoji and surrounding formatting. Unicode bypasses the parser entirely (comment at `ci.yml:346-349`).

### Deploy does not wait for CI

Vercel builds on push; CI runs in parallel. **Why**: dogfooding the preview is part of the between-slice ritual, and waiting for CI before allowing any clicks would make 5-min CI cost 5 min of real-time even on trivial changes. The trade-off: a green deploy is not a green CI, and that's on the developer to check via the `#releases` notifier.

### Auth e2e serial by default

`workers: 1` in `playwright.auth.config.ts`. **Why**: every test writes to a shared Neon DB; parallel workers queue at the server side anyway, and React StrictMode's double-mount compounds with the queueing to cause second-fetch timeouts. Serial is ~1 minute wall time for the suite — cheap enough to trade for determinism.

### Fonts inlined as base64 in `api/_fonts.ts`

Not fetched at request time, not read from `/public`. **Why**: auth-protected preview deploys 401 static-asset URLs without the bypass header; `/tmp` is the only writable area in serverless (memory `project_swutrade_ogimage`); fetching from the same origin is forbidden. Bundling the TTFs into the deploy artifact is the escape valve.

### Husky runs typecheck only

Not vitest, not playwright. **Why**: commit latency is the expensive thing in a fast-iteration workflow; typecheck is fast and catches the largest class of CI-failing errors. Full-suite coverage is CI's job.

### Migrations are commit-coupled, not deploy-coupled

A schema change + its migration SQL + the snapshot + journal bump all ship in one commit. **Why**: anyone else pulling that commit gets the DB state implied by their code; a split puts the repo in a state where `tsc` passes but the DB doesn't match. The drawback is the drizzle-kit step has to be run locally before commit — no automation hides that.

### Price refresh via GitHub Actions cron + deploy hook, not Vercel cron

`refresh-prices.yml` fires a `VERCEL_DEPLOY_HOOK` every 2h with `buildCache=false` so the build-time `fetch-prices.ts` re-runs. **Why**: keeps the price data in a static CDN artifact (no runtime fetch per request, no rate-limit worry on TCGPlayer). A Vercel cron hitting an `/api/refresh-prices` endpoint would write to DB or blob, costing a runtime fetch per viewer. The deploy-hook model makes prices first-class build output.

## Cross-references

- [`a-sessions.md`](./a-sessions.md) — for the `api/sessions.ts` dispatcher's action semantics.
- [`b-proposals.md`](./b-proposals.md) — for what `api/trades.ts` does with each action.
- [`g-auth.md`](./g-auth.md) — for `api/auth.ts` dispatch and the iron-session cookie format that `e2e/helpers/auth.ts` seals.
- [`h-cards-pricing.md`](./h-cards-pricing.md) — for `scripts/fetch-prices.ts` / `scripts/enrich-cards.ts` logic and the price data contract. The cron *schedule* is here; the cron *content* is there.
- [`i-discord-bot.md`](./i-discord-bot.md) — for `api/bot.ts` dispatch, signature verification, and the `#releases` webhook semantics beyond the CI-notifier layer.
- [`README.md`](./README.md) — index + staleness-guard rules.
