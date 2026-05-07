# K. Card signals (web-authored, bot-broadcast)

> **Owner scope**
>
> The acute side of "what cards do I want / have" — narrow, time-bound broadcasts that go out as Discord embeds in a guild's `#swutrade-threads` channel and trigger a public response thread.
>
> - `lib/schema.ts` (lines 595–676) — `cardSignals` table + `cardSignalKinds` + `cardSignalStatuses`.
> - `api/signals.ts` — HTTP dispatcher for `/api/signals/{create,cancel,mine,seed}`. The web Signal Builder POSTs here; the seed endpoint feeds the trade-builder pre-fill on the "Trade with @author" deep link.
> - `lib/signalMatching.ts` — server-side matcher (`findMatches`) + family/variant resolvers + autocomplete + `lookupSignalCard` / `lookupSignalFamily` over `family-index.json`.
> - `lib/signalMessages.ts` — Discord embed builders, thread-opener, variant picker, button custom_id grammar (`SIGNAL_CUSTOM_ID_PREFIX`).
> - `src/components/SignalBuilderView.tsx` — the web `/?signals=new` authoring surface (multi-card form, guild picker, embed preview).
> - `src/hooks/useMySignals.ts` (if present) — author-side list of in-flight signals; consumed by the Home `MySignalsModule` if surfaced there.
> - `api/bot.ts::handleSignalButton` + `handleSignalGroupAction` + `handleTradeWithAuthor` + `handleMarkFulfilled` + `handleVariantOpen` + `handleVariantPick` — Discord-side button dispatchers. Owned in [`i-discord-bot.md`](./i-discord-bot.md) for the bot-dispatch view; this page documents them from the signals-feature view.
> - `api/bot.ts::handleCronRequest` action `cron-signals` — daily Vercel cron that expires past-due signals + PATCHes their embeds.
> - `vercel.json` rewrites for `/api/signals/*` (create, cancel, mine, seed) and the `/api/cron/signals` cron.
> - Tests: `tests/api/signals.test.ts` (39 cases — create, cancel, list-mine, seed, button handlers, thread spawn, mark-fulfilled).
> - Built-in JSON inputs (read at compile time): `public/data/family-index.json`.

## Overview

A **signal** is a time-bound, public-facing version of a wishlist or binder entry: "I specifically need 1× Luke before Friday's draft" (kind: `wanted`) or "I have an extra Cassian I want to offload" (kind: `offering`). Authored on the web via the Signal Builder, posted to Discord by the bot as an embed in the chosen guild's `#swutrade-threads` channel, with a public response thread spawned underneath. Lives ~7 days unless cancelled, fulfilled, or extended (re-post-bump deferred — see Tech debt).

Signals sit alongside sessions as the second trading primitive after Phase C. Sessions are *live two-sided negotiations*; signals are *one-sided broadcasts* with a one-tap escalation into a session via the embed's "Trade with @author" button. The two surfaces compose: a signal is the discovery surface, a session is where the actual trade happens.

**One-sentence pitch for a new teammate:** users author signals on the web, the bot posts them as Discord embeds with a response thread, and the "Trade with @author" button deep-links anyone — signed-in or anonymous — into the trade builder pre-filled with the signal author as the counterpart.

## Key concepts / glossary

- **Signal** — a row in `card_signals`. Carries `kind` (`wanted` | `offering`), the underlying inventory row id (`wantsItemId` for wanted; `availableItemId` for offering), `guildId` (which guild's channel hosts the embed), `messageId` + `channelId` (where the embed lives), `threadId` (the response thread), `status`, and lifecycle timestamps.
- **Group** — a multi-card signal (1–20 cards) shares one `groupId` so they render as a single embed and respond to one Cancel / Mark fulfilled click. Single-card signals have `groupId === id`.
- **Status** — one of `active` / `cancelled` / `fulfilled` / `expired`. The embed's color + title strikethrough + button list all derive from status. Only `active` carries buttons; the other three render as historical artifacts.
- **`SIGNAL_CUSTOM_ID_PREFIX`** — `'signal'`. All button custom_ids on signal embeds use the grammar `signal:{groupId|rowId}:{action}[:value]`. Group-scoped actions (`cancel`, `fulfilled`, `trade`) take a groupId; row-scoped actions (`variant-open`, `variant-pick`) take a row id; for single-card signals the two coincide.
- **Match listing** — the public list of guild members holding the inverse inventory (for a `wanted` signal: members whose `available_items` contain a matching product; for `offering`: members whose `wants_items` cover the family). Computed by `findMatches` at post time + on every embed PATCH. Rendered in the embed description with `<@discordId>` mentions but `allowed_mentions: { parse: [] }` so the listing doesn't fire pings — the *response thread opener* is the opt-in notification path (`parse: ['users']`).
- **Response thread** — public `type: 11` Discord thread anchored to the signal post via `startThreadFromMessage`. Visible to everyone in the channel. Posts an opener that mentions matched users so they get a Discord notification. Author is auto-subscribed by Discord on thread creation.
- **Trade-with-author deep link** — `/?seedFromSignal=<groupId>` web URL emitted in the ephemeral response to a `signal:{groupId}:trade` button click. Anyone — including anonymous Discord users — can click; the web side handles the sign-in gate. See `useTradeIntent.seedFromSignal` and the App-level translator effect in [`c-trade-builder.md`](./c-trade-builder.md).
- **Family / productId** — same vocabulary as the trade builder. Family = base card identity across prints (e.g. "Luke, Hero of Yavin"); productId = one specific printing. Wanted signals carry a `wants_items.restriction_mode` (`any` or `restricted` to specific variants); offering signals reference one concrete `available_items.product_id`.
- **VariantSpec** — `{ mode: 'any' } | { mode: 'restricted', variants: string[] }`. The matcher's input shape. Single-card author can narrow `any` → `restricted` after-the-fact via the "Pick a printing" button, which both pins the underlying inventory row and PATCHes the embed.
- **Cron expiry** — `/api/cron/signals` daily at 08:00 UTC sweeps `card_signals WHERE status='active' AND expires_at < now()`, flips them to `expired`, and PATCHes each embed with the gray "Expired" treatment. Best-effort PATCH — bot failures are logged + reported via `errorReporter`, not retried.

## File map

### Server

**`api/signals.ts`** (~730 lines) — HTTP dispatcher. `default export` routes on `?action=` to four sub-handlers (`create`, `cancel`, `mine`, `seed`). Each is exported individually so vitest can call them directly without an HTTP mock. Consolidated into one file to stay under the function ceiling (see [`j-infra.md`](./j-infra.md)).

**`lib/signalMatching.ts`** (~540 lines) — Two roles:
1. **Family + variant resolution** for the rest of the app: `lookupSignalFamily(familyId)`, `lookupSignalCard(productId)`, `autocompleteSignalFamilies(query)` — all read from the inlined `family-index.json` (build-time JSON import). `resolveSignalFamily` / `resolveSignalVariantSpec` / `resolveSignalCardsBatch` do the join from a `cardSignals` row to its underlying family + variant spec.
2. **Match computation:** `findMatches({ kind, family, variant, guildId, requesterUserId, eventId? })` returns `MatchedUser[]` (up to 25, ordered by inventory `last_updated DESC`). Filters: recipient must share the guild, have `appearInQueries=true`, and not be the requester. Forward-compat for LGS via the `eventId` arg (no consumer today).

**`lib/signalMessages.ts`** (~350 lines) — Discord message + embed builders, scoped to signals. Owns:
- `SIGNAL_CUSTOM_ID_PREFIX` — exported constant; the bot's interaction dispatcher pattern-matches on it (see [`i-discord-bot.md`](./i-discord-bot.md) for the prefix table).
- `buildSignalPost(ctx)` — the live + retired-state embed (color, status badge, title, description, thumbnail, image, components/buttons). Thumbnail-vs-image logic gates on `imageUrl + cards.length === 1`; multi-card drops the thumbnail.
- `buildVariantPickerEphemeral` — the ephemeral string-select shown after a "Pick a printing" click.
- `buildSignalThreadOpener` — the opener message posted into the response thread; flips `allowed_mentions: { parse: ['users'] }` so matched users get pinged.
- `buildActionRow` — internal; builds the live-status button row in canonical order: **Trade with @author** (PRIMARY) → **Mark fulfilled** (SUCCESS) → **Pick a printing** (SECONDARY, single-card variant=any only) → **Cancel post** (DANGER). Action rows cap at 5 buttons; worst case here is 4.
- `formatExpiryHint(expiresAt)` — friendly "Expires in N days/hours" string. Currently unused in the embed (see Tech debt) but kept for the cron-expiry / management surfaces.

**`api/bot.ts`** signal handlers (the bot side; documented in detail in [`i-discord-bot.md`](./i-discord-bot.md) — listed here for completeness):
- `handleSignalButton` — top-level dispatcher; parses the custom_id, special-cases `trade` BEFORE auth (anonymous Discord users get a useful response), then routes group vs row.
- `handleSignalGroupAction` — auth gate (clicker must own the group), then dispatches to `handleCancelLive` or `handleMarkFulfilled`.
- `handleTradeWithAuthor` — public; returns ephemeral with the `/?seedFromSignal=<groupId>` deep link.
- `handleMarkFulfilled` — flips status, re-renders the embed in `'fulfilled'` state, locks the response thread via `lockThread`.
- `handleCancelLive` — flips status to `cancelled`, re-renders the embed in `'cancelled'` state.
- `handleVariantOpen` / `handleVariantPick` — ephemeral picker → narrows the underlying `wants_items` restriction (or repoints `available_items.product_id`), recomputes matches, PATCHes the embed.
- `handleCronRequest` action `cron-signals` — daily expiry sweep + embed PATCH.

### Client

**`src/components/SignalBuilderView.tsx`** (~810 lines) — the `/?signals=new` page. Multi-card form (max 20 cards via the `CardInputSchema.max(20)` cap on the API), per-card variant restriction picker, qty stepper, optional note (≤500 chars). Includes the "Pull from wishlist priorities" shortcut that pre-fills cards from the user's `wants_items` rows where `isPriority=true`. Guild dropdown shows only guilds where the bot is installed AND the viewer is enrolled. Right-rail embed preview re-renders on every form change.

**Trade-with-author landing flow** (consumer of this area, lives in `src/App.tsx` + `src/hooks/useTradeIntent.ts`): the `seedFromSignal` URL param triggers an effect that fetches `/api/signals/seed`, rewrites the URL to `?propose=<authorHandle>`, and hands off to the existing propose flow. See [`c-trade-builder.md`](./c-trade-builder.md) for the receiving side.

### Tests

**`tests/api/signals.test.ts`** — 39 cases across four describe blocks:
- `POST /api/signals?action=create` — auth gate, body validation, guild-membership gate, enrollment gate, bot-installed gate, happy path (single + multi-card), bot-post-failure rollback, match-listing rendering, **thread spawn + opener mention**, thread-spawn-failure non-fatal.
- `DELETE /api/signals?action=cancel` — auth, missing/unknown groupId, non-owner 403, owner cancel + embed PATCH, idempotency 409.
- `GET /api/signals?action=mine` — auth, empty list, active-only filter.
- `GET /api/signals?action=seed` — public read, missing-groupId 400, unknown-group 404, cancelled-group 404, method gate.
- `signal: button handler` — cancel (owner click + non-owner + no-account); variant-open + variant-pick + non-owner; **trade button** (anonymous-OK + unknown-group + cancelled-group); **fulfilled button** (owner flips + locks thread + non-owner ephemeral + already-cancelled idempotent).

## Data model

### `card_signals` table (`lib/schema.ts:606-676`)

| column | notes |
|---|---|
| `id` PK | Random UUID per row. Single-card signals: `groupId === id`. |
| `userId` FK → `users.id` | Author. Cascade on delete (deactivated users don't leave dangling signals). |
| `kind` enum | `'wanted'` or `'offering'`. Drives embed color, match-listing direction, button visibility. |
| `groupId` | Multi-card group anchor. NULL for ungrouped (legacy) rows; same-as-id for single-card; shared across rows for multi-card. |
| `wantsItemId` FK → `wants_items.id`, nullable | Set when `kind='wanted'`; FK cascades on delete (deleting the wishlist row implicitly cancels its signal). |
| `availableItemId` FK → `available_items.id`, nullable | Set when `kind='offering'`; same cascade. |
| `guildId` FK → `bot_installed_guilds.guild_id` | Where the embed posts. Cascades — uninstalling the bot from a guild implicitly cancels its signals. |
| `channelId` | Discord channel id. Computed at create time via `ensureSwutradeCategory + ensureTradesChannel`. |
| `messageId`, nullable | Set after the embed posts. Used by Cancel + Mark-fulfilled + cron-expiry to find the message to PATCH. |
| `threadId`, nullable | Set after `startThreadFromMessage` succeeds. Best-effort — null when thread spawn fails. Used by Mark-fulfilled to lock. |
| `eventId`, `lgsId`, nullable | LGS forward-compat. No consumer today. |
| `status` enum | `'active'` / `'cancelled'` / `'expired'` / `'fulfilled'`. Default `'active'`. |
| `expiresAt` | 7 days from create. Cron sweep flips overdue rows to `expired`. |
| `fulfilledAt`, `cancelledAt`, nullable | Audit trail; set when status flips. |
| `createdAt` | Default `now()`. |
| `signalNote`, nullable, ≤500 chars | Free-text override rendered as a blockquote in the embed. Distinct from any `wants_items.note` on the underlying inventory row. |
| `maxUnitPrice`, nullable | **Deprecated** (2026-05-01). Pre-existing rows may carry a value; new writes always null. Pricing is conversation, not pre-commitment. |

**Indexes:**
- `card_signals_active_match_idx` partial — `(guildId, kind)` WHERE `status='active'`. Powers the matcher's per-guild scan.
- `card_signals_group_idx` — `(groupId)` for the cancel/fulfilled fan-out.

**Invariants worth knowing:**
- Exactly one of `wantsItemId` or `availableItemId` is non-null per row (matched to `kind`).
- A row's `messageId` is null between `INSERT` and the embed post; if the post fails, the rollback flips `status='cancelled'` rather than deleting (audit preservation).
- `threadId` is null for old rows + when thread spawn failed; downstream (Mark-fulfilled lock) treats null as "no-op" rather than an error.
- Cancel / fulfilled / expire are state transitions, not deletes — the row stays for analytics + the historical embed re-renders correctly.

### `MatchedUser` (`lib/signalMatching.ts:255`)

```ts
{
  userId: string;
  discordId: string;
  handle: string;
  username: string;
}
```

Returned by `findMatches`; rendered in the embed match listing (deduped + truncated to 5 + "+N more") and in the thread opener (deduped across cards in a multi-card group). Always at most 25 per match call.

### `VariantSpec` (`lib/signalMatching.ts:269`)

```ts
type VariantSpec =
  | { mode: 'any' }
  | { mode: 'restricted'; variants: string[] };
```

Carrier shape between the matcher, the resolver, and the embed builder. `restricted` with one variant means "this specific printing"; `restricted` with multiple is "any of these printings"; `any` is "any printing in the family." Wanted signals can be in any of the three states (driven by `wants_items.restriction_mode`). Offering signals are always `restricted` to the chosen product's single variant.

### Family-index data shape

Inlined at compile time via `with { type: 'json' }` ESM import (same pattern `api/og.ts` uses to dodge runtime self-fetch). Built by `scripts/enrich-cards.ts` from the per-set price catalogs + the swuapi metadata join. See [`h-cards-pricing.md`](./h-cards-pricing.md) for the build-time pipeline.

## Public surface

### Endpoints

- `POST /api/signals?action=create` — auth required. Body: `{ kind: 'wanted'|'offering', cards: Array<{ familyId, variants?: string[]|null, qty }> (1-20), note?: string ≤500, guildId }`. Validates: caller is enrolled member of `guildId`, bot is installed there. Inserts `card_signals` rows + the underlying inventory rows (creates `wants_items` or `available_items` if not present, marks them `isPriority=true` for wanted), posts the embed, spawns the response thread, posts the opener mentioning matched users. Returns `{ groupId, messageId, channelId, threadId, guildId, messageUrl, matchSummary }`. 502 with `'cancelled'` rollback when the bot post fails.
- `DELETE /api/signals?action=cancel&groupId=<id>` — auth + ownership required. Flips every row in the group to `cancelled`, attempts an embed PATCH (best-effort). 409 when the group is already cancelled (idempotency guard so accidental double-clicks don't re-fire the embed PATCH).
- `GET /api/signals?action=mine` — auth required. Returns `{ groups: [{ groupId, kind, guildId, channelId, messageId, messageUrl, expiresAt, note, cards }] }` for every active group the viewer authored. Used by the Home `MySignalsModule` and by the Signal Builder's "your active signals" affordance.
- `GET /api/signals?action=seed&groupId=<id>` — **no auth**. Returns `{ groupId, kind, note, author: { id, handle, username, avatarUrl }, cards: TradeCardSnapshot[] }` for an active group. Used by the App-level `seedFromSignal` translator on the web side. 404 for missing/cancelled/expired/fulfilled groups (only active is seedable). 400 when `groupId` missing. Method-gated to GET.

### Discord button custom_id grammar

`signal:{groupId|rowId}:{action}[:value]` — see the table in [`i-discord-bot.md`](./i-discord-bot.md) for the dispatch view. Action set:
- Group-scoped: `cancel`, `fulfilled`, `trade`.
- Row-scoped (single-card variant=any only): `variant-open`, `variant-pick:<variantValue>`.

### Library exports (server)

From `lib/signalMatching.ts`:
- `lookupSignalCard(productId) → SignalCard | null` — synchronous family-index lookup.
- `lookupSignalFamily(familyId) → SignalFamily | null` — same; family-level.
- `autocompleteSignalFamilies(query, limit?) → SignalFamilySearchResult[]` — for the Signal Builder's typeahead.
- `findMatches({ kind, family, variant, guildId, requesterUserId, eventId? }) → Promise<MatchedUser[]>` — server-side matcher.
- `resolveSignalFamily(db, signal)`, `resolveSignalVariantSpec(db, signal)`, `resolveSignalCardsBatch(db, rows)` — database-backed resolvers for re-renders (cancel, fulfilled, expire, list-mine, seed).

From `lib/signalMessages.ts`:
- `SIGNAL_CUSTOM_ID_PREFIX = 'signal'`.
- `buildSignalPost(ctx)`, `buildSignalThreadOpener(args)`, `buildVariantPickerEphemeral(args)`, `formatExpiryHint(expiresAt, now?)`.

### Components / hooks (client)

- `<SignalBuilderView auth allCards wants />` — mounted by `App.tsx` when the router resolves `?signals=new`. Reads the viewer's `wants` for the priority shortcut; reads `allCards` for typeahead.
- `seedFromSignal` intent on `useTradeIntent` — set by Discord button deep link, consumed + cleared by an App-level effect that translates to `?propose=<authorHandle>`. See [`c-trade-builder.md`](./c-trade-builder.md).

## State + data flow

### Happy path: web author → Discord embed + thread

1. User opens `/?signals=new` (`SignalBuilderView`). Picks `kind`, picks 1–20 cards (variant restriction per card), picks a guild. Optionally adds a note.
2. Submit → `POST /api/signals?action=create`. Server:
   - Validates body (zod schema), auth, guild membership + enrollment, bot install.
   - For each card: inserts a `wants_items` (kind=wanted) or `available_items` (kind=offering) row if one doesn't already match the family + variant; flips `isPriority=true` for wanted entries.
   - Inserts a `card_signals` row per card, all sharing the same `groupId`.
   - Computes match listings via `findMatches` per card (capped at 25 per call).
   - Builds the embed via `buildSignalPost`, posts it via `bot.postChannelMessage`. On failure, rolls back: flips every group row to `cancelled` and returns 502.
   - Spawns a public response thread via `bot.startThreadFromMessage`. **Best-effort** — failure logs + `reportError`s but doesn't roll back the embed. The post is already up; we'd rather have a signal without a thread than no signal.
   - If the thread succeeds, posts the opener via `bot.postChannelMessage(threadId, body)` — mentions the deduplicated set of matched discord ids with `parse: ['users']` so they ping. Same best-effort treatment if the opener fails.
   - Stamps `messageId` (always) + `threadId` (when present) on every group row.
   - Returns 201 with `{ groupId, messageId, channelId, threadId, ... }`.
3. Client navigates to `/?signals=mine` (or wherever the post-create UI lands).

### Trade-with-author flow

1. Discord user clicks **Trade with @author** on the embed → `POST /api/bot/interactions` with `custom_id: 'signal:<groupId>:trade'`.
2. `handleSignalButton` parses, sees `action === 'trade'`, special-cases BEFORE the clicker auth check (no SWUTrade-account requirement — that's the conversion funnel).
3. `handleTradeWithAuthor` looks up the signal author's handle, builds the ephemeral response with the deep link `${SWUTRADE_PUBLIC_URL}/?seedFromSignal=<groupId>`. Returns ephemeral CHANNEL_MESSAGE.
4. User clicks the link → web app boots, App-level effect detects `seedFromSignal`, fetches `/api/signals/seed?groupId=<id>` (public, no auth).
5. Effect rewrites the URL to `?propose=<authorHandle>&view=trade`, sets `viewMode='trade'`, hands off to the existing propose-mode trade builder. The user lands with the author selected as the counterpart. Cards from the signal aren't auto-added to a side (deferred — see Tech debt); they're surfaced as picker chips via the existing propose-mode `useRecipientProfile` fetch.

### Mark-fulfilled flow

1. Author clicks **Mark fulfilled** → `signal:<groupId>:fulfilled`.
2. `handleSignalGroupAction` enforces ownership (every row in the group has the same `userId`).
3. `handleMarkFulfilled` checks all rows are `'active'` (rejects if any are already terminal — idempotency).
4. Updates every row: `status = 'fulfilled'`, `fulfilledAt = now()`.
5. Re-renders the embed via `buildSignalPost` with `status: 'fulfilled'` (gray color, strikethrough title, no buttons).
6. If `threadId` is set, calls `bot.lockThread(threadId)`. Best-effort — Discord may have already auto-archived after 24h idle, in which case the lock still succeeds and re-archive is a no-op.
7. Returns type-7 UPDATE_MESSAGE so the embed flips in place for the clicker.

### Cron expiry (daily 08:00 UTC)

1. Vercel fires `/api/cron/signals`, rewritten to `api/bot?action=cron-signals`. Bearer-authed with `CRON_SECRET`.
2. `handleCronRequest` selects `card_signals WHERE status='active' AND expires_at < now()`.
3. For each, flips status to `'expired'`, then attempts an embed PATCH via `editChannelMessage`. PATCH failures (channel deleted, message deleted, bot kicked) are logged + `reportError`'d but don't block the next iteration — the row is still expired in the DB.
4. Returns `{ expired: <count>, patched: <count>, errors: <count> }` for cron-log inspection.

## UI/UX patterns

### Embed shape

- **Color** — blue (`#3B82F6`) for wanted, emerald (`#10B981`) for offering. Matches the trade-builder's reserved side palette. Cancelled / expired / fulfilled flips to neutral gray (`#6B7280`).
- **Title** — `🔍 Looking for · <card>` (single-card) or `🔍 Looking for · N cards` (multi). Strikethrough when retired (` ~~Looking for...~~`).
- **Author** — `@handle` + avatar.
- **Description** — bullet list of cards with qty + variant restriction, then optional `> note`, then a single CTA line at the bottom: `✨ [Join SWUTrade with Discord to build your virtual trade binder →](origin/api/auth/discord)`. The CTA is the only link in the embed (Discord embeds don't render buttons in the description; the actionable CTAs live in the action row below).
- **Match listing** (per card) — `Has it: <@a>, <@b>, <@c> +2 more` (or `Wants it:` for offering). Capped at 5 mentions; overflow truncates to "+N more". `allowed_mentions: { parse: [] }` so the listing doesn't fire pings.
- **Thumbnail** — only when single-card AND no `imageUrl`. Multi-card drops the thumbnail in favor of the bullet list as the focal element.
- **Image** — full-width OG-style composite, only on `active` posts. Retired posts drop it so the strikethrough title + status badge carry the visual weight.
- **Footer** — plain `SWUTrade`. No expiry hint (deliberately omitted — viewers see signals as Discord messages, not lifecycle objects).

### Action row (live status only)

Order: **Trade with @author** (primary blue) → **Mark fulfilled** (success green) → **Pick a printing** (secondary, single-card variant=any only) → **Cancel post** (danger red). Worst case 4 buttons; well under the 5-button row cap.

### Response thread

- Public type-11 thread anchored to the signal post.
- Name format: `signal-{authorHandle}-{shortId}` (≤100 chars per Discord's thread name cap; `shortId` is the first 8 hex chars of the group id with dashes stripped).
- Opener message mentions matched users with `parse: ['users']`. Empty-state copy when there are zero matches: "No matches in this server yet — reply here if you can help @author, or hit **Trade with @author** on the post to start a session."
- No bot moderation of the thread — Discord users converse freely.

### Signal Builder layout (web)

Two-column on desktop: form on the left, embed preview on the right. Mobile stacks. Form has:
- Kind toggle at top (radio: Looking for / Offering).
- Guild picker (only enrolled-with-bot guilds appear).
- Per-card row repeater (max 20). Each row has card autocomplete, variant restriction picker, qty stepper, remove-button.
- Optional note textarea (≤500 chars).
- "Pull from wishlist priorities" shortcut for the wanted kind.
- Submit button (disabled until valid).

## Tech debt + known gaps

- **Re-post-same-card bump deferred.** The original PR 2 plan included "POST `/api/signals` for an already-active card bumps `expires_at` rather than duplicating." Carried over from the proposal-shaped plan but not shipped — design has open questions (delete + re-post for visibility, or silent expires_at bump? does the embed re-post visibly?). Track under NEXT.md follow-ups.
- **Card-on-canvas pre-seed deferred.** The seedFromSignal flow currently translates to `?propose=<authorHandle>`, which scopes the picker to the recipient but doesn't auto-add the signal's cards to a side of the trade builder. Auto-add was deferred — picking a side based on `kind` (wanted → clicker offers; offering → clicker wants) is a UX choice worth iterating on once the surface is in real use.
- **No re-render on inventory change.** If the author edits the underlying `wants_items.qty` after the signal is posted, the embed doesn't auto-refresh. The qty in the embed becomes stale. Cron expiry doesn't re-fetch live qty either. Acceptable today (signals are short-lived), worth a re-render-on-edit path if signals start lasting longer.
- **Match listing snapshot at post time.** The embed is PATCHed only on cancel / fulfilled / expire / variant-pick. New matched members joining the guild after a signal posts don't show up in the listing until one of those events fires. The thread opener also only mentions the original matched set.
- **`maxUnitPrice` column is dead** — kept on the schema for backwards-compat with old rows. New writes always null. A future migration could drop the column once we're confident no consumer reads it.
- **`formatExpiryHint` is unused on the embed.** The function is kept for management surfaces (Signal Builder, MySignalsModule) but the embed deliberately drops the hint — viewers see signals as plain Discord messages, not lifecycle objects with countdowns.
- **No analytics on the trade button.** We don't track click-through on **Trade with @author**, conversion to session-create, or session-settled-from-signal. Once the surface has volume, add a `card_signals.first_trade_session_id` denorm or an `analytics_events` table to measure the funnel.
- **Thread retention follows Discord defaults** — 24h auto-archive on idle, no archive sweep on signal terminal states (cancel / expire). Mark-fulfilled is the only action that explicitly archives + locks. Cancel and expire leave the thread open until Discord auto-archives. Slight inconsistency; defensible because cancel/expire are author-side decisions and the conversation in the thread might still be useful.

## Decisions worth remembering

- **Discord-native response surface over modal-driven proposal flow** (PR 2 redesign, 2026-05-06). Original PR 2 plan was proposal-shaped: modal → `trade_proposals` row → ghost-mint on response → fulfillment-detect on accept. Phase C deleted proposals. Redesigned the slice from scratch as Discord-native — auto-spawn a public thread, mention matched users, single "Trade with @author" escalation that deep-links to a pre-seeded session, manual "Mark fulfilled." Drops the modal dispatcher, the `signal-respond:*` custom_ids, the ghost-mint-on-response wedge, and PR 3 entirely. Sign-up funnel moves from "anonymous click → ghost mint" to "anonymous click → web sign-in" — better fit with the mission memory ("Discord augments local/in-person trading; web authors, bot broadcasts"). See `feat(signals): Discord-native response surface (PR 2)` commit.
- **Trade button is publicly clickable** — including by Discord users without a SWUTrade account. The `handleSignalButton` dispatch special-cases `'trade'` before the clicker auth check so anonymous users get a useful response (the deep link). Anonymous users are exactly the audience the conversion funnel targets; gating the button on having a SWUTrade account would make the funnel useless.
- **Thread spawn is best-effort, not part of the critical path.** If `startThreadFromMessage` throws (permission issue, transient API failure), the embed still ships and `threadId` stays null. Rationale: a signal without a thread is still useful (matches in the embed listing, "Trade with @author" still works); rolling back the embed because Discord refused a thread would punish the user for an environmental issue they can't fix.
- **Thread opener mentions matched users; embed match listing doesn't.** The embed sets `allowed_mentions: { parse: [] }` so the public match list is a discovery surface, not a notification firehose. The thread opener flips to `parse: ['users']` because the thread itself is the opt-in attention channel — entering a thread is a deliberate signal of interest, so a ping there isn't spam.
- **Public type-11 threads over private type-12.** Original session-collaboration code used `createPrivateThread`. Signals deliberately use `startThreadFromMessage` (which creates a public, message-anchored thread) because the response trail is meant to be visible to everyone in the channel — anyone might chime in with "I have one too" or "I'd take that for $X." Privacy would defeat the purpose.
- **Manual Mark fulfilled over auto-detection on session-settle.** Original PR 3 plan was to PATCH the embed on `session_events.kind='settled'` if any participant had created a session via the seed flow. Dropped because: tracking `originatingSignalId` on sessions would add a denorm column; the inverse query (find-signal-from-session) gets expensive at scale; manual close matches the in-person reality where the actual trade happens offline and the user knows when they're done. Author hits a button when ready.
- **`signalMessages.ts` separate from `discordMessages.ts`.** Could have lived together. Kept separate so the signals subsystem is self-contained — adding a card to a signal doesn't risk regressing a session-invite DM. The two builder modules share no helper functions (intentional; the embed shapes are different enough that abstraction would be premature).
- **Web-authored, bot-broadcast.** The `/looking-for` and `/offering` slash commands were prototyped then killed before PR 1 shipped — Discord's structural limits (option count, modal complexity, inability to surface a real card-typeahead) made the web Signal Builder strictly better. The bot's job is rendering + button interactions; authoring stays on the web. See [`project_swutrade_mission`](../../README.md) memory.
- **Signal cards mark `wants_items.isPriority=true` on insert.** The signal IS the priority signal — the underlying wishlist row gets pinned to the top of the user's wishlist for the lifetime of the signal. Cancellation / expiry doesn't unset it (the user's intent persists past the broadcast).

## Cross-references

- [`i-discord-bot.md`](./i-discord-bot.md) — Discord bot dispatch view of signal buttons + the bot client's `startThreadFromMessage` / `lockThread` / `editChannelMessage` methods. The custom_id-grammar table lives there.
- [`c-trade-builder.md`](./c-trade-builder.md) — the `seedFromSignal` URL intent + the App-level translator effect that turns it into `?propose=<authorHandle>`.
- [`a-sessions.md`](./a-sessions.md) — sessions are the primitive that signal responses escalate into. The Trade-with-author flow lands in propose mode, which is the launch pad for `ShareLiveTradeButton` → session-create.
- [`f-community-profile.md`](./f-community-profile.md) — guild membership + `appearInQueries` consent gate that the matcher reads.
- [`h-cards-pricing.md`](./h-cards-pricing.md) — `family-index.json` + `lookupSignalFamily` ride on this subsystem's build-time data.
- [`j-infra.md`](./j-infra.md) — Vercel cron config + dispatcher consolidation (function ceiling).
