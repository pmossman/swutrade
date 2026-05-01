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
| 1 | `api/auth.ts` line 233/240 | `handleCallback` (OAuth code exchange + `users/@me` fetch) | `tests/api/auth-oauth.test.ts` | ❌ **GAP** — only handleDiscordStart is tested |
| 2 | `api/signals.ts` lines 374, 501 | Signal post + cancellation embed | `tests/api/signals.test.ts` (890 lines) | ✅ Covered |
| 3 | `api/bot.ts` (interactions, signals lifecycle, proposal threads, DMs) | Slash command handlers + signal updates + thread management | `tests/api/bot.test.ts` (1811 lines) | ✅ Covered |
| 4 | `api/trades.ts` (proposal, accept, counter, edit, settled, expired) | Trade lifecycle DMs + thread posts | `tests/api/trades-*.test.ts` (8 files) | ✅ Covered |
| 5 | `lib/sessions.ts` line 1700 | `inviteHandleToSession` — Discord-DM invite to a trade session | none | ❌ **GAP** — DM body shape unasserted |
| 6 | `lib/tradeGuild.ts` lines 270, 296-389, 420 | `ensureSwutradeCategory` — bot's first-join onboarding (creates category + 4 channels + welcome message) | none | ❌ **GAP** — channel layout + welcome body unasserted |
| 7 | `lib/proposalResolve.ts` lines 159, 184 | Proposal-accepted edit + proposer DM notify | `tests/api/trades-accept-decline.test.ts` (52 assertions) | ✅ Covered |
| 8 | `api/bot.ts` lines 2341, 2487, 2495 | Post-install welcome DMs (`buildServerInviteMessage`, `buildServerAutoEnrolledMessage`) | `tests/api/bot.test.ts` | ⚠️ **PARTIAL** — DB row asserted, DM body shape not |

## Gaps to patch

### F2-a — `handleCallback` unit tests
Mock `arctic`'s `Discord.validateAuthorizationCode` (returns synthetic tokens) and the global `fetch` (returns a synthetic `users/@me` payload). Assert:
- New-user path inserts the right row shape (id, discordId, handle derivation, public-by-default flags).
- Existing-user path updates username + avatar without re-deriving handle.
- Handle-collision fallback adds the random suffix.
- Ghost-merge path migrates `tradeSessions.userAId` / `userBId` from the prior ghost id to the resolved real id, then deletes the ghost user row.
- Invalid-state-cookie returns 400 without making any Discord call.

### F2-b — `inviteHandleToSession` body shape test
Mock `RecordingFakeBot.sendDirectMessage`. Assert:
- DM body uses `buildSessionInviteMessage(...)`.
- Embed includes the inviter handle + the session URL.
- Ghost target (no discordId) returns `dm-failed` without touching the bot.
- Bot throw is caught + returns `dm-failed`.

### F2-c — `ensureSwutradeCategory` channel layout + welcome
Mock `RecordingFakeBot` with `getGuildBotMember`, `createGuildChannel`, `modifyChannel`, `postChannelMessage`. Assert:
- First-time call creates: 1 category + 4 channels (`#swutrade-posts`, `#swutrade-threads`, `#swutrade-announcements`, `#swutrade-discussion`) in that order.
- Each channel's permission_overwrites match the documented shape (e.g. announcements is read-only for `@everyone`).
- Welcome message body posted to `#swutrade-announcements`.
- Re-running the function with all ids already populated is idempotent (zero new bot calls).
- Partial-state recovery — only the missing pieces get created, existing ids are preserved.

### F2-d — Post-install DM body shape
Extend `tests/api/bot.test.ts` to assert the body shapes of `buildServerInviteMessage` and `buildServerAutoEnrolledMessage`. Currently the tests only check that the right DB row exists.

## Re-running this audit

When code adds a new outbound Discord caller:
1. Update the table above with the new row.
2. Confirm the test exists and asserts body shape (not just "did it call").
3. If the test doesn't exist, write one that uses `discordFakes` ' `RecordingFakeBot` pattern.

The pattern is well-established — `tests/api/signals.test.ts` is the canonical reference for what "good" coverage looks like.
