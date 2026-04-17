# Phase 4 testing strategy

Living doc. The standard we're holding: **green CI means all features
definitely work in production.** Phase 4 introduces Discord API calls,
HTTP Interactions webhooks, and bot behaviors that CI can't directly
exercise. The strategy keeps CI as the merge gate by combining
disciplined mocking with a second-layer nightly drift check and a
third-layer manual runbook. No tier is optional.

## The three tiers

### Tier 1 — Automated CI (merge gate)

Every Discord-touching feature must have Tier 1 coverage. Without
it, the feature doesn't ship to beta.

- **API endpoints**: vitest integration tests against real Neon.
  Seeds all required tables via helpers.
- **UI flows**: Playwright against seeded DB + mocked Discord client.
  Asserts DOM state + DB state after user actions.
- **Signature verification**: vitest test using a locally-generated
  Ed25519 keypair. Exercises the *actual* verification path — only
  the key material differs from production.
- **Discord API calls**: stubbed via an injectable `DiscordClient`
  abstraction (see `lib/discordClient.ts` once it exists). Every
  stubbed response is derived from a fixture under
  `tests/fixtures/discord/` captured from a real Discord response.

**Rule of thumb**: if the only reason a bug could slip through is
"Discord changed its API contract," that's Tier 2's job, not Tier 1.
Everything else — all our logic, all payload construction, all
response handling — belongs in Tier 1.

### Tier 2 — Nightly contract drift check

A single scheduled GitHub Actions workflow, once per day. Hits a
narrow surface of real Discord endpoints (e.g. `GET /users/@me` for
the bot token, `GET /gateway`) and asserts response shapes match our
TypeScript types. Catches the "Discord silently added/removed a
field" class of issue within 24h.

**Diagnostic, not merge-blocking.** A failure opens an issue, it
doesn't block PRs. Merge-blocking on a third-party service is how you
end up unable to ship on a Discord outage.

Stand this up when we have ≥2 production bot endpoints live (i.e.
late in Phase 4 v1, once the bot actually exists).

### Tier 3 — Manual smoke in a test server

A dedicated Discord test server + a separate "SWUTrade Dev" Discord
application (not the production app). Used to verify things only a
real Discord can confirm:

- The bot message actually renders with expected embed/button layout
- Discord delivers webhook on bot install / kick
- DM button interactions fire the expected handler flow
- OAuth install URL successfully installs the bot in a fresh server

Runbook below. Run after every beta → main promotion that touches
the bot.

## Discord-side setup tracker

Things that need to happen on Discord's side, not in code. Checked
off when done.

- [ ] Dedicated test Discord server created
- [ ] "SWUTrade Dev" Discord application created (separate from prod)
- [ ] Dev bot installed in test server
- [ ] Dev bot token added to local `.env.local` (not CI)
- [ ] Nightly contract workflow stood up (after bot ships, see Tier 2)
- [ ] Prod bot OAuth install URL documented for user adoption

## Tier 2 nightly contract checks

Empty until the bot is live. Each entry lists an endpoint + the
response fields we assert against. Starts empty and grows with the
bot.

_No entries yet — bot not built._

## Tier 3 runbook

Manual smoke tests to run after any Phase-4 promotion to main that
touches a Discord-adjacent code path.

### After shipping Slice 1 (guilds OAuth scope)

- [x] Sign in fresh — verify Discord shows the new consent screen
  asking for the `guilds` scope.
- [x] Sign in — verify your `user_guild_memberships` rows populate
  (check the Neon dashboard).
- [x] Leave a Discord server — sign in again — verify the row for
  that guild is removed.
- [x] Verify existing session doesn't force a re-prompt (backward
  compat).

### After shipping Slice 2 (settings + enrollment UI)

- [ ] Sign in fresh (or open `/?settings=1` via account menu) and
  verify the Settings page renders with the correct defaults —
  profile visibility `public`, only "Trade proposals sent to me"
  checked among the bot DM categories.
- [ ] Change profile visibility to `Discord only`, reload the page,
  verify the value stuck.
- [ ] Toggle a bot DM category on, reload, verify it's still on.
- [ ] Verify the Discord servers section shows the expected
  empty-state ("SWUTrade's bot isn't installed in any of your
  Discord servers yet") — expected while the bot is unbuilt and
  `bot_installed_guilds` is empty.
- [ ] If you manually insert a row into `bot_installed_guilds` for
  one of your Discord servers, reload, verify that server appears
  under "enrollable" and the others fall into "Other servers."
  Enroll, verify the card highlights + sub-toggles appear.
  Disenroll, verify sub-toggles disappear and DB flags all clear.
  (Reminder: manually `DELETE` the `bot_installed_guilds` row
  when done if you didn't intend to keep it.)
- [ ] Keyboard-only flow: tab through the settings page, verify
  every interactive element has visible focus + correct order.

### After shipping Slice 3 (community source in picker)

- [ ] Sign in + make sure you're enrolled (+ rollups on) in at
  least one guild where `bot_installed_guilds` has a row. Seed a
  row manually via Neon if the bot isn't built yet.
- [ ] Manually seed a second user in the same guild via SQL (fake
  user row + user_guild_memberships with enrolled=true +
  includeInRollups=true) and give them a wants entry you
  (the viewer) can also provide from your available list.
- [ ] Open the Offering picker — verify "Community wants N" chip
  appears with the right count.
- [ ] Tap the chip — the grid should scope to those cards.
- [ ] Give yourself a want that matches what the peer has
  available (again via SQL seed), open Receiving picker, verify
  "Community has N" chip with the right count.
- [ ] Turn your `includeInRollups` off on the settings page →
  chip shouldn't appear. (Rollups off means you contribute to
  nothing, but also means you CAN still see others — this step
  just verifies the settings integration hasn't regressed.)
- [ ] Clean up the manually seeded rows in Neon when done.

### After shipping the bot (Phase 4 v1 final slice)

- [ ] Install bot in test server via production OAuth URL; verify
  `bot_installed_guilds` row appears.
- [ ] Run the "Share to Discord" action; verify the channel message
  appears with the right embed and the expected buttons.
- [ ] Kick the bot from the test server; verify the
  `bot_installed_guilds` row disappears and the user's enrollment
  UI updates on next refresh.
- [ ] Send a trade proposal; verify the recipient gets a DM with
  Accept / Counter / Decline buttons.
- [ ] Click Accept; verify the trade state updates in the web app.
- [ ] Click Decline; verify the same.

### Per-feature Tier 3 entries

Every PR that touches a Discord-integrated feature must either:
(a) add a Tier 3 entry here with the specific manual check, or
(b) explicitly state in the PR description that the change is Tier
1-complete and Tier 3 is unaffected.

## Authoring discipline for mocked Discord calls

- **Never hand-write a Discord API response in a test.** If you need
  a response shape, capture one from a real Discord call, redact
  sensitive fields, save as `tests/fixtures/discord/<endpoint>.json`,
  and import it.
- **Use the typed `DiscordClient` abstraction.** Mocks replace the
  client, not `fetch`. Keeps the abstraction boundary clean.
- **If you find yourself writing a mock response shape from scratch
  because you don't have a real capture**, stop and go get a real
  capture first, even if it's from the Discord API reference JSON
  examples.
