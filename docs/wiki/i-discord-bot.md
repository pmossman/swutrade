# I. Discord bot + webhooks

> **Owner scope**
>
> - `api/bot.ts` — unified Discord webhook endpoint. PING / slash commands / button interactions / APPLICATION_AUTHORIZED events. Routed as `/api/bot/interactions` and `/api/bot/events` via `vercel.json` rewrites.
> - `lib/discordBot.ts` — `DiscordBotClient` (outbound HTTP wrapper using `DISCORD_BOT_TOKEN`) with 429 auto-retry + injected sleep/fetch for tests.
> - `lib/discordClient.ts` — `DiscordClient` for the user-OAuth surface (`GET /users/@me/guilds`). Different auth, different scope from the bot client.
> - `lib/discordErrors.ts` — typed error hierarchy + `classifyDiscordError` mapping HTTP status / Discord code → error subclass.
> - `lib/discordSignature.ts` — Ed25519 verification with `maxSkewSeconds` + `now` injection.
> - `lib/errorReporter.ts` — fire-and-forget `#bot-errors` webhook poster with noise filters.
> - `lib/guildSync.ts` — `syncGuildMemberships` reconciles `user_guild_memberships` on sign-in; auto-enrolls members of bot-installed guilds.
> - `lib/prefsRegistry.ts` — typed registry of user prefs (scope × type × surface). Single source of truth.
> - `lib/prefsResolver.ts` — cascade `resolvePref({key, viewerUserId, peerUserId})` → peer override → self → default.
> - `lib/threadConsent.ts` — `deliveryForPair` + `handleThreadRequest` decision matrix over `CommunicationPref`.
> - `scripts/discord-admin.mjs` — dev-ops wrapper that talks to Discord via a SEPARATE admin bot token (not the product bot).
> - `scripts/register-discord-commands.mjs` — one-off slash-command registration against the product bot.
> - Tests: `tests/api/discord-signature.test.ts`, `tests/lib/discordErrors.test.ts`, `tests/api/guild-sync.test.ts`.
> - CI notifier: `.github/workflows/ci.yml` `notify-start` / `notify-live` / `notify-finish` jobs posting to `#releases`.
>
> Everything slash-command / button / preference / webhook-facing is here. The web Settings UI that renders from this registry belongs to [`f-community-profile.md`](./f-community-profile.md); the proposal lifecycle that buttons drive is [`b-proposals.md`](./b-proposals.md).

## Overview

The Discord area is the bot's entire outward face: inbound webhooks (signed interactions + events), outbound REST calls (DMs, thread creation, channel edits), the error-reporting channel, and the preferences registry that drives both the `/swutrade settings` slash command and the web Settings page. One sentence: **`api/bot.ts` is the single verified entry point for everything Discord initiates; `lib/discordBot.ts` is the single wrapped exit point for everything SWUTrade sends to Discord.**

Three things keep this area honest: (1) signature verification happens before any payload parsing; (2) every outbound call is classified into a typed error hierarchy so callers can react meaningfully; (3) the prefs registry is the ONLY place new user-facing options get defined — web Settings, the slash command index, and the DM `⚙ Prefs` button all iterate the same list.

## Key concepts / glossary

- **Interactions Endpoint URL** — the Discord-portal setting pointing at `https://beta.swutrade.com/api/bot/interactions`. Receives PING handshakes, slash commands, button/select submits.
- **Event Webhooks URL** — separate portal setting pointing at `/api/bot/events`. Receives `APPLICATION_AUTHORIZED` (bot installed / user reauth) and similar app-lifecycle events. Same signing key, different enum space (type 0 = PING here, NOT interaction-PING).
- **Ed25519 verification** — `lib/discordSignature.ts:21`. Discord signs `timestamp || body` with the app's private key; we verify with `DISCORD_APP_PUBLIC_KEY` (hex) wrapped in an X.509 SPKI prefix. Failures return false (never throw) so callers don't need try/catch.
- **`maxSkewSeconds`** — `lib/discordSignature.ts:40`. 300s replay-protection window. Tests inject `now: () => <fixed ts>` + `maxSkewSeconds: Infinity` to pin time; production reads `Date.now()`.
- **Test public key fallback** — `api/bot.ts:80` (`resolveTestPublicKey`). Non-production envs can carry `DISCORD_APP_PUBLIC_KEY_TEST`, letting e2e specs sign synthetic interactions. Hard-gated on `VERCEL_ENV !== 'production'` — a leaked test private key never becomes a real forgery vector.
- **`DiscordBotClient`** — `lib/discordBot.ts:50`. Outbound bot API wrapper. 429 auto-retry (once, up to `maxRetrySleepSeconds`=5). Tests swap `fetch` + `sleep` via `CreateBotClientOptions`.
- **Typed error hierarchy** — `lib/discordErrors.ts`. `DiscordRateLimitError` / `Permission` / `NotFound` / `Validation` / `Server` / `Unknown`, all extending `DiscordApiError`. `classifyDiscordError` is the only path from HTTP → typed.
- **`errorReporter` `#bot-errors` webhook** — `lib/errorReporter.ts:52`. Fire-and-forget out-of-band alert. `shouldSkip` filters out transient noise (429, 10003/10008/10013 not-found churn, 50007 DMs-disabled); `isTestTraffic` filters out synthetic e2e IDs so real signals stay loud.
- **Prefs registry** — `lib/prefsRegistry.ts:120` (`PREF_DEFINITIONS`). Each def has `scope` (self/peer/guild), `type` (boolean/enum), `surfaces` (web/discord), `section` (privacy/notifications/communication/membership), `column` (on the scope's backing table). Adding a pref is DB migration + one `definePref()` entry; every consumer iterates the registry.
- **Resolver cascade** — `lib/prefsResolver.ts:31`. For `(key, viewer, peer?)`: peer override on `user_peer_prefs` → viewer's self column on `users` → self-scope def's `default`. Unknown keys throw — no silent fallback at the resolver layer.
- **`CommunicationPref`** — `lib/threadConsent.ts:19`. The 4-state enum driving thread-vs-DM routing: `prefer` / `auto-accept` / `allow` (default) / `dm-only`. Resolved independently for each side of a proposal, then combined via `deliveryForPair`.
- **Per-guild trade channel** — each `bot_installed_guilds` row carries `trades_channel_id` for that guild's `#swutrade-threads` channel, auto-created on install (`api/bot.ts::handleApplicationAuthorized`). The propose flow resolves which guild hosts a given (proposer, recipient) trade via `lib/tradeGuild.ts::resolveTradeGuild` (cascade: most-recent prior trade with this pair → most-recent install → lex). When no qualifying guild exists the proposal is delivered as per-user DMs. Each `trade_proposals` row caches the chosen guild on its `guild_id` column so counters / button-flows can re-resolve the channel without re-running the cascade.
- **`BUTTON_CUSTOM_ID_PREFIX` / `PREF_CUSTOM_ID_PREFIX` / `COMM_PREF_CUSTOM_ID_PREFIX` / `SERVER_INVITE_CUSTOM_ID_PREFIX`** — declared in `lib/proposalMessages.ts`, consumed in `api/bot.ts:224`. The handler dispatches on these prefixes to split trade-proposal buttons from pref selectors from enrollment buttons.

## File map

### Inbound — the signed webhook entry

**`api/bot.ts`** — Single exported `default` handler. 1,928 lines. Owns signature verification, interaction dispatch (PING → PONG, slash commands, message components), event dispatch (`APPLICATION_AUTHORIZED`), and every button-click handler. Consolidation is deliberate — the Hobby-plan serverless function ceiling (see [`j-infra.md`](./j-infra.md)) doesn't leave room to split this file into one-route-per-file. `vercel.json` rewrites give Discord two distinct URLs that both land here with `?action=interactions` or `?action=events`.

**`lib/discordSignature.ts`** — `verifyDiscordSignature({ signature, timestamp, body, publicKeyHex, maxSkewSeconds?, now? })`. Returns `boolean` (never throws). Wraps the raw 32-byte hex key in the X.509 SPKI DER prefix (`302a300506032b6570032100`) that `node:crypto.createPublicKey` expects.

### Outbound — the REST wrappers

**`lib/discordBot.ts`** — `createDiscordBotClient(opts)`. Every outbound Discord call flows through one of its methods (see surface table below). 429 auto-retry with `Retry-After` honored up to `maxRetrySleepSeconds` (5s default — half of the Hobby function timeout). Does NOT retry on 5xx because most bot writes (POST message, PATCH member) aren't idempotent and a blind retry dupes.

**`lib/discordClient.ts`** — Lower-level client for user-OAuth calls (`GET /users/@me/guilds`). Separate from the bot client because the auth header differs (`Bearer <access token>` vs `Bot <token>`) and the scope differs (operating as the signed-in user vs as the bot identity). The seam is at `syncGuildMemberships`.

**`lib/discordErrors.ts`** — `DiscordApiError` abstract base + six concrete subclasses. `classifyDiscordError(status, method, path, bodyText, headers)` maps:
- `429` → `RateLimitError` (header `retry-after` wins over JSON body `retry_after`; `global` flag surfaced)
- `400 + code 40003` → `RateLimitError` too (see "DM-open rate limit" below)
- `403` → `PermissionError`
- `404` → `NotFoundError`
- `400` (other) → `ValidationError`
- `5xx` → `ServerError`
- anything else → `UnknownError`

### Observability

**`lib/errorReporter.ts`** — `reportError(ctx, err)`. Posts an embed to `DISCORD_ERROR_WEBHOOK_URL` (`#bot-errors`). Silent in local dev (env unset). Never throws (a failure in the reporter is swallowed — otherwise the reporter would cascade back into the catch-block it was called from). `shouldSkip` tunes out operational noise; `isTestTraffic` tunes out synthetic e2e IDs (`test-iso-*`, `e2e-sender-*`) plus Discord's `NUMBER_TYPE_COERCE` on `recipient_id` (the signature of "non-snowflake user id — test seeding").

### Guild sync

**`lib/guildSync.ts`** — `syncGuildMemberships(userId, accessToken, discord?, opts?)`. Upserts `user_guild_memberships` from the Discord guild list. Preserves consent fields (`enrolled`, `includeInRollups`, `appearInQueries`) on upsert — a re-sync never flips opt-ins. Auto-enrolls new memberships in bot-installed guilds (reduces "opt-in wall" friction for new users). Swallows Discord errors by default (sign-in must not block on a 401); the explicit "Refresh servers" button passes `propagateDiscordErrors: true` so the user sees failures there.

### Preferences

**`lib/prefsRegistry.ts`** — 8 defs today, across 4 sections:
- **communication** — `communicationPref` (self + peer; `prefer`/`auto-accept`/`allow`/`dm-only`)
- **privacy** — `profileVisibility` (web-only), `shareActivityPublicly` (both)
- **notifications** — `dmTradeProposals`, `dmMatchAlerts`, `dmMeetupReminders`, `dmServerNewInstall` (all both)
- **membership** — `autoEnrollOnBotInstall` (both)

`definePref()` is an identity helper for type inference; `validatePrefValue()` is the belt-and-suspenders schema check used by both the `/api/me/prefs` PATCH handler and the button handler (the Discord `custom_id` is attacker-controlled — never trust a raw string to be a valid enum).

**`lib/prefsResolver.ts`** — Pure cascade: `resolvePref({ key, viewerUserId, peerUserId? })`. Always routes through the self-scoped def even when only `peer` is registered — a peer-only pref with no baseline has no meaningful inherit target.

**`lib/threadConsent.ts`** — Two exports:
- `deliveryForPair(proposer, recipient) → 'thread-immediately' | 'dm-with-request' | 'dm-only'` — the matrix governing initial routing.
- `handleThreadRequest(counterpart) → 'auto-approve' | 'manual-decide' | 'auto-decline'` — what to do when one side clicks `Request thread`.

### Scripts / ops

**`scripts/discord-admin.mjs`** — Dev-ops CLI. Uses a SEPARATE admin-ops bot token (`DISCORD_ADMIN_BOT_TOKEN`, `.env.local` only). Commands: `list-guilds`, `list-channels`, `create-channel`, `create-webhook`, `delete-channel`, `describe-member`. MUST NOT be pushed to Vercel; the product bot's token stays minimal-permission and the admin bot exists precisely so broad-permission dev operations don't need to elevate the product bot.

**`scripts/register-discord-commands.mjs`** — One-off slash-command + user-context-menu registration. PUT semantics: replaces the entire command list at the target scope (global OR guild). Uses the product bot token (different from `discord-admin.mjs`). Guild-scoped registration propagates instantly (good for dev); global propagation takes up to an hour.

### Tests

- **`tests/api/discord-signature.test.ts`** — Locally-generated Ed25519 keypair; exercises the real crypto path. Covers tampered body, tampered timestamp, wrong key, malformed hex, timestamp-window edges (±300s, custom `maxSkewSeconds`), non-numeric timestamp.
- **`tests/lib/discordErrors.test.ts`** — Full mapping table. Verifies header-over-body precedence for 429 `retry_after`, 400+40003 → RateLimit re-classification, and that every subclass extends `DiscordApiError`.
- **`tests/api/guild-sync.test.ts`** — Upsert preservation of consent flags, permission-bit MANAGE_GUILD detection, prune-on-leave, auto-enroll when bot-installed guild.

## Data model

This area reads from and writes to several schemas; most are OWNED elsewhere (users by [`g-auth.md`](./g-auth.md), trade rows by [`b-proposals.md`](./b-proposals.md)), with the exceptions listed below.

### Owned: `bot_installed_guilds`

`lib/schema.ts`. One row per guild the bot is installed in.

| column | notes |
|---|---|
| `guild_id` PK | Discord snowflake |
| `guild_name`, `guild_icon` | cached from the install event; refreshed on re-auth |
| `installed_by_user_id` | the Discord user who added the bot; used for the welcome DM |
| `trades_channel_id` | nullable; set by `handleApplicationAuthorized` after auto-creating `#swutrade-threads` |

### Owned: `user_peer_prefs`

Composite PK `(user_id, peer_user_id)`. Stores a user's per-trader overrides. `communicationPref` is the only column today (an override of `null` means "inherit from self"). Schema is flat — one column per peer-scoped def — so the registry can access it by dynamic column lookup: `userPeerPrefs as Record<string, AnyPgColumn>` in `handlePeerPrefButton` (`api/bot.ts:1398`) and in the resolver (`lib/prefsResolver.ts:46`). Adding a peer-scoped pref = schema column + one registry entry.

### Read: `users`

Self-scoped pref columns live directly on `users`. The registry's `column` field is validated against this schema at test time so typos don't ship. Resolver reads via the same dynamic column trick.

### Invariants worth naming

- **Self + peer enum options MUST match.** The peer-scope `communicationPref` def reuses `COMMUNICATION_PREF_OPTIONS` literally (`lib/prefsRegistry.ts:97`). A unit test asserts the cascade can never yield a value the self column can't store.
- **`type: 12` private threads with `invitable: false`.** `lib/discordBot.ts:219`. Auto-archive 24h (1440 minutes) default. Invisible to anyone not added via `addThreadMember`.
- **Thread name format** — `trade-{proposerHandle}-{recipientHandle}-{shortId}`.slice(0, 100) — Discord's thread-name limit is 100 chars. `api/bot.ts:742` and `api/trades.ts` share the convention.
- **`@everyone` role id equals guild id.** Used by `handleApplicationAuthorized` when computing permission overwrites for `#swutrade-threads`.
- **Bot member lookup uses explicit user id, NOT `/@me`.** Discord rejects `/guilds/:id/members/@me` for bots with a 403. `getGuildBotMember(guildId, botUserId)` takes the id explicitly; callers pull it from `DISCORD_CLIENT_ID` (for bot applications the OAuth client id IS the bot user id).

## Public surface

### Signature verification

- `verifyDiscordSignature(opts) → boolean` — `lib/discordSignature.ts:21`. Never throws. Caller passes raw `body` string (not re-serialized) — `canonicalRequestBody` in `api/bot.ts:64` handles the `@vercel/node` pre-parse by round-tripping `JSON.stringify(req.body)` which works because Discord's emitted JSON is compact and V8 preserves key insertion order.
- `resolveTestPublicKey(env) → string | undefined` — `api/bot.ts:80`. Returns the test-keypair fallback ONLY on non-production envs. Exported so the unit test can assert the production gate directly.

### Bot client methods

`lib/discordBot.ts:50-109`, all on `DiscordBotClient`:

| method | Discord endpoint | used by |
|---|---|---|
| `postChannelMessage(channelId, body)` | `POST /channels/{id}/messages` | initial proposal DM, thread posts, DM follow-ups |
| `editChannelMessage(channelId, messageId, body)` | `PATCH /channels/{id}/messages/{mid}` | replaces the Accept/Decline button row with the outcome banner so stale buttons can't re-fire |
| `createDmChannel(userId)` | `POST /users/@me/channels` | opens a DM channel (idempotent on Discord's side) |
| `sendDirectMessage(userId, body)` | open-then-post composite | proposal DMs, thread-approval prompts, welcome DMs, enrollment invites |
| `getGuild(guildId)` | `GET /guilds/{id}` | fallback when `APPLICATION_AUTHORIZED` event data lacks guild name/icon |
| `createPrivateThread(parentChannelId, {name, autoArchive})` | `POST /channels/{id}/threads` with `type: 12, invitable: false` | both the initial `thread-immediately` path and the later approve-thread flow |
| `addThreadMember(threadId, userId)` | `PUT /channels/{id}/thread-members/{uid}` | adds proposer + recipient to a new thread (Discord emits "X added you to a thread" system message + push) |
| `deleteChannel(channelId)` | `DELETE /channels/{id}` | cleanup of orphaned threads when `addThreadMember` fails (e.g., recipient isn't in the guild or the bot lacks perms) |
| `createGuildChannel(guildId, opts)` | `POST /guilds/{id}/channels` | auto-create `#swutrade-threads` on install |
| `getGuildBotMember(guildId, botUserId)` | `GET /guilds/{gid}/members/{uid}` | resolve the bot's managed-integration role so we can hand it channel overwrites; Discord's `/members/@me` rejects bots with 403 so caller passes the id explicitly |

All calls inject `Authorization: Bot {token}` + `Content-Type: application/json` in `request()` (`lib/discordBot.ts:146`). The retry loop unwraps 429 via `classifyDiscordError`, sleeps up to `maxRetrySleepSeconds`, then re-enters exactly once (`maxRetries` default = 1). Everything else throws the classified error straight through.

### Inbound HTTP

- `POST /api/bot/interactions` — rewritten to `POST /api/bot?action=interactions`. Handshake (type 1) → PONG. Slash/context (type 2) → `handleApplicationCommand`. Button/select (type 3) → `handleTradeProposalButton` / `handlePrefsButton` / `handleServerInviteButton` based on `custom_id` prefix.
- `POST /api/bot/events` — rewritten to `POST /api/bot?action=events`. Type 0 → 204. `APPLICATION_AUTHORIZED` → `handleApplicationAuthorized` (upsert install row, maybe auto-create channel, DM installer, outreach to existing members).

Both paths share the same Ed25519 verification, same `DISCORD_APP_PUBLIC_KEY`, same `maxSkewSeconds`. Both respond 401 on signature failure, 400 on invalid JSON, 405 on non-POST.

### Interaction + event constants (api/bot.ts:88-108)

Named to pair with the Discord-docs enum values so `grep` works both ways:
- `INTERACTION_TYPE_PING=1`, `INTERACTION_TYPE_APPLICATION_COMMAND=2`, `INTERACTION_TYPE_MESSAGE_COMPONENT=3`
- `APPLICATION_COMMAND_TYPE_SLASH=1`, `APPLICATION_COMMAND_TYPE_USER=2`
- `INTERACTION_RESPONSE_TYPE_PONG=1`, `_CHANNEL_MESSAGE=4`, `_DEFERRED_UPDATE=6`, `_UPDATE_MESSAGE=7`
- `MESSAGE_FLAG_EPHEMERAL=64`

### Commands

The product bot registers exactly two commands today (`scripts/register-discord-commands.mjs:52`):

- `/swutrade settings [user: User]` — type 1 slash with a type-1 SUB_COMMAND `settings` carrying an optional type-6 USER option. No user → self-prefs index. With user → peer-prefs index for that target.
- `SWUTrade prefs` — type 2 user-context menu (right-click a member → Apps → SWUTrade prefs). Always the peer-prefs index for the clicked user.

Both route through `handleApplicationCommand` (`api/bot.ts:257`). The slash command drills into `data.options[0].options[?name=user]` to find the target; the context menu reads `data.target_id`. Both set `flags: MESSAGE_FLAG_EPHEMERAL` so the follow-up is only visible to the clicker.

### Button custom_id grammar

Every button carries a `custom_id` the handler pattern-matches on. Prefixes (defined in `lib/proposalMessages.ts`):

| prefix | grammar | dispatched to |
|---|---|---|
| `proposal:` (BUTTON) | `proposal:{tradeId}:{accept\|decline\|counter\|request-thread\|approve-thread\|decline-thread}` | `handleTradeProposalButton` |
| `pref:` | `pref:{key}:{open\|set}[:value]` (self) or `pref:peer:{peerUserId}:{key}:{open\|set}[:value]` or `pref:combo:{peerUserId}:open` | `handlePrefsButton` → self / peer / combined forks |
| `comm-pref:` (legacy) | `comm-pref:{open\|set}[:value]` | `handlePrefsButton` → pinned to `communicationPref` for DMs that shipped before the registry existed |
| `server-invite:` | `server-invite:{guildId}:enroll` | `handleServerInviteButton` |

Unknown prefixes: silent `DEFERRED_UPDATE` ack. Unknown `custom_id` under a known prefix: also silent defer — better than "interaction failed" toast for the user.

### Prefs registry functions

- `PREF_DEFINITIONS: ReadonlyArray<PrefDefinition>` — the list.
- `getPrefDefinition(key, scope)` — `(key, scope) → def | undefined`. Used as the authorization gate in the Discord button handler; an unknown key or a web-only def receives a silent defer (no column read, no surface leak).
- `validatePrefValue(def, value)` — `{ok: true, value} | {ok: false, reason}`. Rejects `null` explicitly — callers handling "clear peer override" check for the literal `'inherit'` before calling the validator (see `handlePeerPrefButton`, `api/bot.ts:1434`).

### Resolver

- `resolvePref({ key, viewerUserId, peerUserId? }) → Promise<PrefValue>` — `lib/prefsResolver.ts:31`. Throws on unknown key (catch at the API boundary, not here).

### Thread consent

- `deliveryForPair(proposerPref, recipientPref) → ProposalDelivery` — `lib/threadConsent.ts:48`. Rules: `dm-only` on either side wins; both "thread-positive" (`prefer`|`auto-accept`) → immediate thread; otherwise DM with the Request button.
- `handleThreadRequest(counterpart) → ThreadRequestOutcome` — `lib/threadConsent.ts:77`. `prefer`/`auto-accept` → `auto-approve`; `allow` → `manual-decide`; `dm-only` → `auto-decline` (defensive — button shouldn't have been offered, but pref may have changed mid-flight).

### Error reporter

- `reportError({ source, tags?, force? }, err) → Promise<void>` — fire-and-forget. `force: true` bypasses `shouldSkip` + `isTestTraffic` for the "normally-noise but actually load-bearing here" case.
- `shouldSkip(err) → boolean` — exported for tests. Skips `RateLimitError`, `NotFoundError` with codes 10003/10008/10013, `PermissionError` with code 50007.
- `isTestTraffic(ctx, err) → boolean` — exported for tests. Checks tag prefixes (`test-iso-`, `e2e-sender-`) + the Discord `NUMBER_TYPE_COERCE` + `recipient_id` body signature.

## State + data flow

### Happy path: user clicks Accept on a proposal DM

1. User clicks the green `proposal:{id}:accept` button.
2. Discord POSTs `/api/bot/interactions` with `type: 3` and signs with its private key.
3. `api/bot.ts:118` reads `DISCORD_APP_PUBLIC_KEY`, extracts headers, `verifyDiscordSignature` returns true (body round-trip via `canonicalRequestBody`).
4. `handleInteraction` inspects `custom_id` prefix → routes to `handleTradeProposalButton`.
5. Handler resolves the trade row + proposer + recipient from DB. Authorization: `recipient.discordId === clickerDiscordId`, else ephemeral "not yours" reply.
6. Status guard: `pending` only — already-resolved falls through to an idempotent `UPDATE_MESSAGE` with the resolved banner (no DB write, no proposer DM).
7. `resolveProposal` (shared with the web path, `lib/proposalResolve.ts`) does the optimistic UPDATE, logs the event, PATCHes the recipient's DM, sends the proposer notification DM.
8. Handler replies `type: 7 UPDATE_MESSAGE` with the resolved body. Discord swaps the button row in place — no flicker, no re-click possible. (`resolveProposal` also PATCHes the same message for the web path; the PATCH is idempotent.)

The shared-module cut (`proposalResolve.ts`) is why the web endpoint and the button endpoint can never drift: both funnel through the same state transition, the same event log, the same Discord side effects.

### Happy path: bot-install arrives

1. An admin installs the bot in a guild. Discord POSTs `APPLICATION_AUTHORIZED` to `/api/bot/events`.
2. `handleApplicationAuthorized` (`api/bot.ts:1535`) upserts `bot_installed_guilds`; fresh install is detected by the absence of a prior row.
3. `getGuildBotMember(guildId, DISCORD_CLIENT_ID)` resolves the bot's managed-integration role. `createGuildChannel` creates `#swutrade-threads` with overwrites granting `@everyone` VIEW_CHANNEL (so the system messages for thread creation aren't invisible) and the bot role the full permission set.
4. `trades_channel_id` gets stored on the guild row — every future trade in this guild prefers a thread by default (assuming both sides' comm prefs allow).
5. If auto-create throws, the error is logged + `reportError`'d; the install itself DOES NOT fail. Trade proposals gracefully degrade to DM in the absence of a trades channel.
6. Welcome DM to the installer (fresh installs only — re-auth shouldn't re-notify).
7. `outreachToMembers` enumerates SWUTrade users who are already in the guild, batches DMs at `BATCH_SIZE = 5` (`api/bot.ts:1740`) via `Promise.allSettled` so one user's DMs-disabled doesn't kill the batch. Per-user prefs gate the DM (`dmServerNewInstall`) and the auto-enroll path (`autoEnrollOnBotInstall`).

### Edge: 400 + Discord code 40003

Someone bulk-declines many proposals; each click opens a DM channel to the counterpart; Discord throttles DM-opens with `{"code": 40003, "message": "You are opening direct messages too fast."}` at HTTP 400 — NOT 429.

`classifyDiscordError` (`lib/discordErrors.ts:138`) re-maps this into `DiscordRateLimitError` with a 2s default `retryAfterSeconds`. The bot client's retry loop applies uniformly; `reportError`'s `shouldSkip` treats it as noise. Without this one-liner, every fast-decline session would spray the `#bot-errors` channel with "validation errors" that are actually transient throttling.

### Edge: recipient is a synthetic test user

`handlePropose` attempts to add both traders to a new private thread. Discord rejects a non-snowflake user id with `NUMBER_TYPE_COERCE` on `recipient_id` — a `ValidationError` in our taxonomy. The caller catches, logs, `reportError`s (filtered out by `isTestTraffic`), deletes the orphan thread (`deleteChannel`) to avoid a landfill of empty proposer-only threads, and falls back to the per-user DM path. The catch block documents this explicitly at `api/trades.ts:301`.

### Edge: auth gate on a stale DM

A user reshares their DM thread with a friend who clicks the Accept button. `clickerDiscordId !== recipient.discordId` → ephemeral "this was sent to someone else" with `flags: EPHEMERAL`. No DB write. Belt-and-suspenders — DMs aren't shareable in practice, but guild-channel delivery could show the button to extras.

## UI/UX patterns (Discord-facing)

- **`UPDATE_MESSAGE` (type 7) over PATCH** where the response can drive the UI update directly. Cheaper than a separate `editChannelMessage` PATCH and avoids the flicker where a button stays clickable between click and edit landing.
- **`DEFERRED_UPDATE` (type 6) for no-op paths** (unknown custom_id, failed authorization without a message to show). Swallows the click cleanly instead of showing a red "interaction failed" toast.
- **Ephemeral responses** (`flags: 64`) for anything scoped to the clicker — pref selectors, error explanations, counter deep-links. Never ephemeral for the DM body itself (that IS the message state).
- **Unicode emojis only** — `#releases` CI notifier uses raw `✅`/`❌`/`🟢`/`⏭`/`🚫` instead of `:white_check_mark:` shortcodes because shortcode names like `:white_check_mark:` contain underscores that Discord's markdown parser interprets as italic markers, corrupting rendering (`.github/workflows/ci.yml:346`). Same rule applies for any embed description we author.
- **Thread name slicing** at 100 chars so Discord never 400s on a long handle pair.
- **Welcome DM gold** — the installer welcome uses `color: 0xD4AF37` (the gold chrome color from the palette). Gold is structural chrome, not celebration — matches the palette rule from project memory.

## Tech debt + known gaps

- **Tier 2 nightly contract probe** — `NEXT.md:174`. No real-Discord monitoring today. Plan is a diagnostic-only nightly hitting `/users/@me`, `/gateway`, and a canonical `POST /channels/{id}/messages` to a dedicated test channel. Deferred until real user traffic is carrying through the bot so we're not watching an empty pipe.
- **Hardcoded retry / thread constants.** Worth making env-tunable once we have real data:
  - `maxRetries: 1` and `maxRetrySleepSeconds: 5` — `lib/discordBot.ts:141`. Fine on Hobby (10s function timeout); may want to raise on Pro.
  - `auto_archive_duration: 1440` (24h) — `lib/discordBot.ts:220`. Reasonable default; a guild admin may want 72h / 7d for long-running negotiations.
  - `BATCH_SIZE = 5` for outreach DMs — `api/bot.ts:1740`. Works for current guild sizes; a 5000-member guild install will take 1000+ batches = minutes of wall time inside one serverless invocation. Needs to move to a queue before we install somewhere that big.
- **DM-open rate-limit retry window** — `lib/discordErrors.ts:141` uses a 2s empirical default because Discord doesn't document the 40003 window. Works in practice; a nightly probe (see above) would confirm it's still enough.
- **Channel/webhook id sprawl.** `DISCORD_ERROR_WEBHOOK_URL` and `DISCORD_RELEASE_WEBHOOK_URL` still live in Vercel env. Trade-thread routing now reads exclusively from `bot_installed_guilds.trades_channel_id` per-guild — the legacy global `TRADES_CHANNEL_ID` env was removed when the picker shipped.
- **`getGuildBotMember` 403 fix.** Discord rejects `/members/@me` for bots with 403. The handler passes `botUserId` explicitly (`api/bot.ts:1603`). Worth auditing any future endpoint that supports `/@me` to confirm no latent case treats bot tokens like user tokens.
- **Prefs registry migrations** — the 8-step migration from hand-coded columns to the registry is complete; `profileVisibility` is still `surfaces: ['web']` only because a 3-option enum with long descriptions overflows Discord's 5-button action row. Fix when we have a Discord string-select renderer.
- **Thread request vs proposal status race.** `handleThreadFlowButton` checks `trade.status !== 'pending'` but reads the row once at the top — a concurrent accept + request-thread could theoretically both see `pending` and both proceed. Low-probability (two humans clicking sub-second), but worth an optimistic `.where(status, 'pending')` guard on the thread-id UPDATE.
- **Dynamic column access via `as Record<string, AnyPgColumn>`.** Repeated in `api/bot.ts:1152`, `1281`, `1398` and `lib/prefsResolver.ts:46`. Works because the registry test asserts every `def.column` exists on the Drizzle schema. A small `getPrefColumn(def)` helper would dedupe and make the invariant locally explicit.
- **`ErrorReporter.isTestTraffic` prefix list** — hardcoded at `lib/errorReporter.ts:85`. Any new test-id convention has to be added here; grep-wide audit needed when we add new e2e patterns.

## Decisions worth remembering

- **Signature-verify BEFORE anything else.** Not after body parsing, not after dispatch. `api/bot.ts:118` reads the public key, `131` verifies, `147` short-circuits on mismatch. Discord rejects the configured URL at portal-save time if any non-signed payload gets a 2xx, and the docs require rejection on bad sig in production. Everything downstream assumes the payload is authentic.
- **One consolidated handler, two virtual URLs.** `vercel.json` rewrites `/api/bot/interactions` + `/api/bot/events` to a single `api/bot.ts` with `?action=`. Plan memory: the Hobby serverless function ceiling means per-route files aren't free. Discord sees two distinct webhook URLs; we spend one function slot. Same pattern as `api/sessions.ts`.
- **Typed error hierarchy over opaque `Error`.** Before `lib/discordErrors.ts`, every Discord failure looked identical to callers: `new Error(status + path)`. That conflation turned real incidents into silent `delivery_status=failed` rows with no actionable signal. The hierarchy lets the 429 retry loop, the `#bot-errors` noise filter, and the UI fallback copy all branch on meaningful categories without re-parsing strings.
- **Retry once on 429, never on 5xx.** Bot writes aren't idempotent (POST message, PATCH members). A blind retry on 5xx can dupe a proposal DM. 429 is safe because Discord hasn't processed the request yet — `Retry-After` is a "try the same request again" signal. Everything else should surface to the caller.
- **Shared `proposalResolve` module over duplicated logic.** The button handler and the web endpoint both need to transition pending → accepted/declined, log an event, PATCH the DM, notify the proposer. Duplication drifts — one path drops an event row, the other doesn't send the notification. One shared module, two native response shapes (type-7 vs JSON).
- **`reportError` filters noise aggressively.** 429s, expected 10003/10008/10013 not-founds, 50007 DMs-disabled all skipped. Without the filter, `#bot-errors` would fill with user-choice signal and real bugs would drown. Callers pass `force: true` for the rare case where "normally-noise" is meaningful — don't sprinkle it.
- **Test-key fallback hard-gated on env.** `resolveTestPublicKey(env)` returns `undefined` on production regardless of whether `DISCORD_APP_PUBLIC_KEY_TEST` is set. A leaked test private key cannot become a path to forging real interactions. The gate is at the point-of-resolution, not at env-load, so even a misconfigured env doesn't weaken prod.
- **Admin bot separate from product bot.** `scripts/discord-admin.mjs` uses `DISCORD_ADMIN_BOT_TOKEN` (broader permissions, dev-only). The product bot (`DISCORD_BOT_TOKEN`) runs minimal. Keeping them split means a leaked production bot token can't create arbitrary channels or invite webhooks in personal dev servers.
- **`#releases` CI notifier flips state in-place.** `notify-start` posts "deploying" and captures the message id; `notify-live` PATCHes it to 🟢 the moment the preview comes up; `notify-finish` PATCHes it to the final outcome. One message per push — no scroll spam. `needs: [notify-live, ...]` prevents the finish-patch from landing before the live-patch on a fast run. (`.github/workflows/ci.yml:252-358`.)
- **`NUMBER_TYPE_COERCE` on `recipient_id` IS the signal for test traffic.** Not a heuristic — it's Discord's exact error text for "you passed a non-snowflake user id." The isTestTraffic check (`lib/errorReporter.ts:94`) is a belt-and-suspenders complement to the tag-prefix check for when a new test helper forgets to set tags.
- **`printf` not `echo` when piping secrets into `vercel env add`.** Discord signing keys are hex without a trailing newline; `echo` appends one, which corrupts the env-var on Vercel's end and every signature verify silently fails on deploy. See project memory `feedback_env_vars`.
- **Vercel protection disabled on beta (2026-04-16).** Preview deploys used to SSO-wall all `/api/*`, which meant Discord's signed webhooks got an HTML 401 they couldn't auth past. Protection off on beta now so webhooks work on preview. Cross-link [`j-infra.md`](./j-infra.md) for the deploy model details.

## Cross-references

- [`b-proposals.md`](./b-proposals.md) — what Accept/Decline actually do after the button click (state machine, events, DM side effects). This page documents the button plumbing; that page documents the lifecycle.
- [`f-community-profile.md`](./f-community-profile.md) — the web Settings page that renders from `PREF_DEFINITIONS`. This page owns the registry + cascade; that page owns the `SettingsView` component.
- [`g-auth.md`](./g-auth.md) — Discord OAuth, iron-session cookies, ghost merge. `syncGuildMemberships` is called by the OAuth callback there; signature verification for interactions is owned here.
- [`j-infra.md`](./j-infra.md) — Vercel function topology, `vercel.json` rewrites, CI pipeline. The `/api/bot/*` rewrites + `notify-start/live/finish` jobs live there; the bodies of those jobs and their channel usage live here.
- [`h-cards-pricing.md`](./h-cards-pricing.md) — no direct overlap. Card data flows into the proposal embed via `lib/proposalMessages.ts`; that module isn't owned here (it's part of the proposals area).
