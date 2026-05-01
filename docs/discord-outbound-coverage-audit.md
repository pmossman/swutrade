# Outbound Discord coverage audit — 2026-05-01

**Goal:** for every place our code makes a request to Discord (REST
fetch, bot client method, webhook POST), there should be a unit
test that pins the exact body / URL we'd send. That way changes to
our code surface as test failures BEFORE they ship to a real Discord
endpoint.

This audit is a snapshot. Re-run when adding a new outbound caller.

## Coverage table

| # | Caller location | Function | Test file | Status |
|---|---|---|---|---|
| 1 | `api/auth.ts` line 233/240 | `handleCallback` (OAuth code exchange + `users/@me` fetch) | `tests/api/auth-oauth.test.ts` (only handleDiscordStart) | ❌ **GAP** |
| 2 | `api/signals.ts` lines 374, 501 | Signal post + cancellation embed | `tests/api/signals.test.ts` (890 lines) | ✅ Covered |
| 3 | `api/bot.ts` (interactions, signals lifecycle, proposal threads, DMs) | Slash command handlers + signal updates + thread management | `tests/api/bot.test.ts` (1811 lines) | ✅ Covered |
| 4 | `api/trades.ts` (proposal, accept, counter, edit, settled, expired) | Trade lifecycle DMs + thread posts | `tests/api/trades-*.test.ts` (8 files) | ✅ Covered |
| 5 | `lib/sessions.ts` line 1700 (`inviteHandleToSession`) | Discord-DM invite to a trade session | `tests/api/sessions-invite.test.ts` — asserts embed title + handle + URL | ✅ Covered (transitively, via the API handler) |
| 6 | `lib/tradeGuild.ts` lines 270, 296-389, 420 (`ensureSwutradeCategory`) | Bot's first-join onboarding (creates category + 4 channels + welcome message) | `tests/api/bot.test.ts` GUILD_CREATE / APPLICATION_AUTHORIZED tests — assert all 5 channel creates in order, names, types, parent_id linking, @everyone permission bitmasks | ✅ Covered (transitively, via APPLICATION_AUTHORIZED handler) |
| 7 | `lib/proposalResolve.ts` lines 159, 184 | Proposal-accepted edit + proposer DM notify | `tests/api/trades-accept-decline.test.ts` (52 assertions) | ✅ Covered |
| 8 | `api/bot.ts` lines 2341, 2487, 2495 (`buildServerInviteMessage` / `buildServerAutoEnrolledMessage`) | Post-install welcome / auto-enroll / invite DMs | `tests/api/bot.test.ts` — asserts each DM exists, button custom_id format, embed title content, auto-enroll-has-no-buttons invariant | ✅ Covered |

## What this means

**The audit's actual deliverable is smaller than I initially scoped.**
3 of the 4 originally-flagged "gaps" turned out to be covered
transitively when I traced through the API handler tests. Only one
real gap remains.

Lesson: when grepping for coverage, test the *transitive* surface
(API handler tests usually exercise the lib functions they call) —
not just the lib function name.

## The one real gap

### F2 — `handleCallback` unit tests

`tests/api/auth-oauth.test.ts` exists with 15 cases but every one
of them is on `getRedirectUri` or `handleDiscordStart`. The actual
callback handler — which exchanges the OAuth code, fetches
`users/@me`, derives a handle, handles collisions, and runs the
ghost-merge — has zero test coverage.

Mock `arctic`'s `Discord.validateAuthorizationCode` (returns
synthetic tokens) and the global `fetch` (returns a synthetic
`users/@me` payload). Assert:

1. **New-user happy path** — inserts the right row shape (id,
   discordId, handle derivation, public-by-default flags).
2. **Existing-user path** — updates username + avatar without
   re-deriving the handle.
3. **Handle collision** — the random suffix gets appended.
4. **Ghost-merge** — `tradeSessions.userAId` / `userBId` rows that
   point at the prior ghost id get migrated to the resolved real
   id; ghost user row is deleted.
5. **Invalid state cookie** — returns 400 without touching Discord.
6. **Missing code or state** — returns 400 without touching
   Discord.
7. **`users/@me` returns non-2xx** — returns 502 with the right
   error.
8. **`validateAuthorizationCode` throws** — returns 400 with the
   right error message.

## Re-running this audit

When code adds a new outbound Discord caller:
1. Update the table above with the new row.
2. Confirm the test exists and asserts body shape (not just "did
   it call"). Look at the *transitive* surface — API handler tests
   usually cover the lib functions they call.
3. If the test doesn't exist, write one that uses `discordFakes`
   ' `RecordingFakeBot` pattern.

The pattern is well-established — `tests/api/signals.test.ts` is
the canonical reference for what "good" coverage looks like.
