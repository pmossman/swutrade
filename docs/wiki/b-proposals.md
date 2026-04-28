# B — Proposals lifecycle

> **Owner scope** — the async Discord-DM trade flow: composer → delivered DM/thread → recipient responds (accept / decline / counter / edit-together) → terminal state + event log. This page owns:
>
> Backend
> - `lib/proposalResolve.ts` — shared accept/decline transition used by both the Discord button handler and the web endpoints
> - `lib/proposalEvents.ts` — append-only `proposal_events` log + `lastNudgedAt` cooldown helper
> - `lib/proposalMessages.ts` — every Discord message body a proposal emits (initial, resolved, countered, thread-*, bulk-decline summary, proposer notification, session invite)
> - `lib/threadConsent.ts` — pure decision matrix for "thread vs DM" based on both parties' `communicationPref`
> - `lib/communityEvents.ts` — guild-scoped activity writes triggered on accept (`recordTradeAcceptedAcrossGuilds`)
> - `api/trades.ts` — dispatcher for every proposal action: `propose`, `get`, `proposals` (list), `cancel`, `accept`, `decline`, `counter`, `edit`, `nudge`, `bulk-resolve`, `promote-to-shared`
> - `lib/schema.ts` — `trade_proposals` + `proposal_events` tables (schema shared with area A for `sessions`)
>
> Frontend
> - Hooks: `useTradeDetail.ts`, `useTradesList.ts`, `useMyTrades.ts`, `useComposerBar.ts`
> - Service wrapper: `src/services/tradeActions.ts`
> - Composers: `ProposeBar.tsx`, `CounterBar.tsx`, `EditBar.tsx`
> - Views: `TradeDetailView.tsx`, `TradesHistoryView.tsx`, `TradeExpandPeek.tsx`
> - Dialog: `NudgeDialog.tsx`

## Overview

A proposal is SWUTrade's async commit-first trade. One user composes an offer against another's handle, the site persists an immutable-ish row, and the Discord bot delivers the result as either a private thread (if both parties allow it) or per-user DMs. The recipient responds with Accept / Decline / Counter — in Discord (button click) or on the web (`/?trade=<id>` detail view) — and both surfaces funnel through the same code so state transitions never drift between channels.

The proposal is deliberately "heavy" compared to a session (area A): every state change is auditable, card snapshots are frozen at compose time, Discord is a transport layer rather than state of record, and the backend is structured so the DB commit is always authoritative — Discord can fail, stay stale, or be edited by the user, and the web app still renders the truth.

## Key concepts / glossary

- **Proposal** — a row in `trade_proposals` (`lib/schema.ts:286`). Proposer + recipient + two frozen card snapshots + a status enum. Once terminal it never reopens; the proposer submits a new one.
- **Frozen snapshot** — `offeringCards` / `receivingCards` are `TradeCardSnapshot[]` jsonb columns with the card's name, variant, qty, and unit price captured at compose time (`lib/schema.ts:279-284`). Prices drift; lists mutate; the proposal keeps showing what was offered.
- **Status vs delivery_status** — two orthogonal axes on the same row. `status` ∈ `pending | accepted | declined | cancelled | expired | countered` is the logical lifecycle; `delivery_status` ∈ `pending | delivered | failed` is the Discord transport result (`lib/schema.ts:296-325`). A proposal can be `status=pending, delivery_status=failed` — saved, but the bot couldn't reach the recipient; the composer UI surfaces the "Discord wouldn't let us DM them" banner but the row is fine.
- **Optimistic concurrency** — every transition `UPDATE ... WHERE id = ? AND status = 'pending'` then checks `updated.length`. See the pattern in `api/trades.ts:704-718` (cancel) and `lib/proposalResolve.ts:89-103` (accept/decline). If the check loses, the caller folds the race into `already-resolved` (409 response) and does not fire any side effects.
- **Counter chain** — `trade_proposals.counter_of_id` is a self-FK (`lib/schema.ts:306-309`). The original has `counter_of_id = null`; a counter has `counter_of_id = original.id`. Siblings share no direct link — you walk backwards via the FK. `on delete set null` is a deliberate degradation: if an ancestor is ever deleted the chain breaks gracefully instead of cascading.
- **Event log** — `proposal_events` (`lib/schema.ts:406`) is an append-only audit trail. Lifecycle writers fire-and-forget `recordEvent` (`lib/proposalEvents.ts:31`) so a failed insert can't roll back the parent transition. Render via `listEvents` on the detail view (`api/trades.ts:495`).
- **Delivery cascade** — on `propose`, the backend resolves the host guild via `lib/tradeGuild.ts::resolveTradeGuild` (proposer ∩ recipient ∩ bot-installed). When a guild is found AND both parties' `communicationPref` agrees, delivery is a private thread in that guild's `#swutrade-threads` channel; otherwise the recipient gets a DM with a `Request thread` button conditionally attached. Decision matrix in `lib/threadConsent.ts:48-61`. The chosen guild is persisted on `trade_proposals.guild_id` so counters / button-flows can re-resolve the channel without re-running the cascade.
- **Discord as transport, DB as source of truth** — every bot call is wrapped in try/catch + `reportError` and never 5xxs the primary transition. See the "best-effort" comment threaded through `resolveProposal` (`lib/proposalResolve.ts:59-63`), `handleCancel` (`api/trades.ts:726-757`), `handleEdit` (`api/trades.ts:1145-1172`), `handleNudge` (`api/trades.ts:1276-1319`).
- **Coalesced bulk-decline** — `handleBulkResolve` groups declines by proposer so N per-row DMs collapse into one summary DM per unique proposer (`api/trades.ts:1519-1553`). Works around Discord's rate-limit on DM-channel opening (error 40003).
- **Promote-to-shared** — recipient-only action that converts a pending proposal into a shared trade session (area A). Proposal flips to `countered` (reusing the terminal state — see the `lib/sessions.ts:966-969` comment); a new session row is seeded. Cross-link: [`a-sessions.md`](./a-sessions.md).
- **TradeRow** — the unified client shape merging proposals + sessions into one list (`src/hooks/useMyTrades.ts:47`). Callers branch on `kind: 'proposal' | 'session'` for kind-specific actions; state palette + chrome stays shared.
- **Composer bar** — three sibling sticky bars (`ProposeBar` / `CounterBar` / `EditBar`) that share `useComposerBar` (send state + snapshot + note) but keep their own mount-fetch + seed-once logic. See the R4 refactor note in `src/hooks/useComposerBar.ts:13-19`.

## File map

### Backend

**`lib/schema.ts`** — defines `tradeProposals` (`:286`) + `proposalEvents` (`:406`). Schema comment (`:268-285`) names the "frozen snapshot" invariant; the `status` and `counter_of_id` comments pin the enum and self-FK semantics. Four indexes cover the hot paths: `counter_of_id`, `status`, `(proposer, updated_at desc)`, `(recipient, updated_at desc)` (`:360-363`). See `NEXT.md` "Foundation slice 2" (2026-04-17) for the EXPLAIN-backed decision to add them.

**`api/trades.ts`** — single dispatcher (`:41-60`) for the whole proposal surface. Each sub-handler owns: zod body parse, auth + precondition checks, optimistic-concurrency UPDATE, `recordEvent` write, best-effort Discord side effect. Kept in one file because Vercel Hobby caps at 12 serverless functions — see `project_swutrade_function_ceiling` memory.

**`lib/proposalResolve.ts`** — shared `resolveProposal` entry point for accept/decline (`:61-195`). Both `api/trades.ts::handleAcceptDecline` and `api/bot.ts::handleTradeProposalButton` call through here so the state transition + event write + DM edit + proposer notification stay identical across surfaces. Returns a structured `ResolveResult` the caller maps to its native response shape (`UPDATE_MESSAGE` for Discord, JSON for web).

**`lib/proposalEvents.ts`** — `recordEvent` (`:31`) swallows + console-logs insert errors so audit-log loss never rolls back the parent transition. `listEvents` (`:63`) joins actors in-query so the detail view can render "@bob nudged this 2h ago" without a follow-up user fetch. `lastNudgedAt` (`:102`) powers the 24h cooldown in `handleNudge`.

**`lib/proposalMessages.ts`** — every Discord message body the proposal flow ships. Entry builders: `buildProposalMessage` (initial + nudge reuse), `buildCounterProposalMessage`, `buildCounteredProposalMessage`, `buildResolvedProposalMessage` (accepted/declined/cancelled, unified because they all strip buttons + add a status line), `buildProposerNotification` (concise DM to proposer on terminal), `buildBulkDeclineNotification` (coalesced summary). Also hosts the thread-lifecycle variants (`buildThreadRequestedProposalMessage`, `buildThreadApprovalRequestMessage`, `buildThreadMovedProposalMessage`, `buildThreadRequestDeclinedMessage`) and the cross-subsystem session-invite DM (`buildSessionInviteMessage`). The shared constants (`COLORS`, `COMPONENT_TYPE_*`, `BUTTON_STYLE_*`, `EMBED_FIELD_SOFT_CAP`) live at the top so copy/color tweaks are one-file changes.

**`lib/threadConsent.ts`** — pure function over `(proposerPref, recipientPref) → 'thread-immediately' | 'dm-with-request' | 'dm-only'` (`:48-61`) and a second pure function `handleThreadRequest(counterpartPref)` for runtime thread-request outcomes (`:77-87`). No side effects — makes the matrix trivially unit-testable, and lets `api/trades.ts::handlePropose` resolve each side's effective pref through `resolvePref` (peer override → self default → registry default) before calling in.

**`lib/communityEvents.ts`** — `recordTradeAcceptedAcrossGuilds` (`:66`) writes one `community_events` row per guild where BOTH parties are enrolled AND `appearInQueries=true`. Fired only from the accept terminal (`lib/proposalResolve.ts:113-119`) — declines are private by design.

### Frontend — state

**`src/hooks/useTradeDetail.ts`** — single-proposal fetch + mutation wrapper (`:132`). Module-scoped cache (`detailCache` at `:118`) lets the inline expand-peek flip open instantly on repeat; cache is `.delete`d before a reload tick after a successful mutation (`:192-193`) so concurrent consumers never see pre-mutation data.

**`src/hooks/useTradesList.ts`** — paginated list + recent-activity feed for the proposals history view (`:83`). Module-scoped singleton cache (`:70`) powers stale-while-revalidate on return navigation. `TradeActivityType` (`:26`) narrows the server's noisy-types filter to the events the Home "My Trades" feed actually shows.

**`src/hooks/useMyTrades.ts`** — viewer-centric unified stream that merges proposals + sessions into one `TradeRow[]` (`:95`). Client-side join: proposals from `/api/trades/proposals` + sessions from `/api/me/sessions`, sorted by `lastActivityAt` desc. `kind` discriminates; `state` is the shared palette (see below). Realizes the Phase 5b "one first-class trade object with state-driven UI" goal at the UX boundary even though storage stays split.

**`src/hooks/useComposerBar.ts`** — shared send state machine + card snapshot + note plumbing (`:96`). Owned state: message string, message-open toggle, `ComposerSendState` discriminated union (`:30-35`). `submit` (`:138`) merges card snapshots + trimmed note into the caller's body, POSTs via `apiPost`, and maps the response into the state machine (`already-resolved` split out from generic `error` for distinct UX copy).

**`src/services/tradeActions.ts`** — thin POST wrappers used by hooks + views. `ActionResult<T>` discriminated union (`:22-31`) splits `already-resolved`, `rate-limited`, `not-found`, `forbidden`, `unauthorized`, `error` so UI can branch without parsing error strings. `rate-limited` carries `nextAvailableAt` for the nudge cooldown.

### Frontend — UI

**`src/components/TradeDetailView.tsx`** — `/?trade=<id>` single-proposal page. Role-aware `ActionBar` (`:259`): recipient-pending gets Accept / Counter (deep-link to composer) / Decline / Edit Together (promote); proposer-pending gets Edit (deep-link) / Nudge (dialog) / Cancel. Closed proposals render no actions — the status badge + timestamps tell the story. Includes an open-in-Discord deep link for thread-backed proposals (`:367`) and an `ActivityTimeline` (`:382`) driven by the event log.

**`src/components/TradesHistoryView.tsx`** — `/?trades=1` three-tab history (`:42`). Default tab chosen by bucket heuristic (`:75-81`): incoming → outgoing → history. Incoming + outgoing tabs support bulk selection (50 cap, matching the server), inline expand-peek via `TradeExpandPeek`, per-row role-aware actions. The sticky `BulkActionBar` (`:585`) arms on first click and fires on second tap within 4s.

**`src/components/ProposeBar.tsx`** — sticky bottom bar for `/?propose=<handle>`. Send opens a confirm modal (`ConfirmProposalDialog` at `:428`) with the two-side summary + totals strip + optional note textarea. The confirm modal exists because beta feedback flagged the earlier inline "add a note" disclosure as too subtle — the note is important context that deserves room. Match suggestions split across two buttons (`Suggest a match` for minimize-imbalance, `★ Priorities` for maximize-priorities) when the two modes would produce different picks (`:129-132`).

**`src/components/CounterBar.tsx`** — sticky bar for `/?counter=<id>`. Fetches the original proposal, seeds the trade panels with SIDES SWAPPED (`:135-139`) because the recipient's counter offers what was asked of them. Seed is one-shot (`autoAppliedRef` at `:63`) so manual edits aren't re-overridden.

**`src/components/EditBar.tsx`** — sticky bar for `/?edit=<id>`. Proposer-only. Seeds the panels with the CURRENT sides (no swap, `:139-141`) and the existing message (unless the user already started typing, `:113-114`). On save, the server re-renders the same Discord message in place with the updated content — status stays `pending`, buttons stay live.

**`src/components/TradeExpandPeek.tsx`** — inline peek rendered under a My Trades row when it's expanded. Deliberately has no chrome of its own (`:17-21`) so it reads as a continuation of the row container rather than an orphaned card below it. Viewer-centric labels: "You offer / You receive" for sent, "You'd give / You'd get" for received (`:69-70`).

**`src/components/NudgeDialog.tsx`** — modal for the proposer-side nudge action. Plain fixed overlay (no Radix — "textarea + two buttons" doesn't need the dep, `:18-22`). Surfaces the server's `rate-limited` response as "Try again after …" rather than a generic error (`:63-66`).

## Data model

### `trade_proposals` (`lib/schema.ts:286`)

```
id                                 text  PK
proposer_user_id, recipient_user_id text  FK users.id, on delete cascade
status                             enum  pending|accepted|declined|cancelled|expired|countered
counter_of_id                      text  FK self, on delete set null (breaks chain gracefully)
offering_cards, receiving_cards    jsonb TradeCardSnapshot[]  — frozen at compose time
message                            text  optional note, ≤500 chars
delivery_status                    enum  pending|delivered|failed  — Discord transport axis
discord_dm_channel_id              text  nullable
discord_dm_message_id              text  nullable
discord_thread_id                  text  nullable (set when thread flow wins)
discord_thread_parent_channel_id   text  nullable
thread_approval_dm_channel_id      text  ephemeral — cleared when request resolves
thread_approval_dm_message_id      text  ephemeral — cleared when request resolves
created_at, updated_at, responded_at  timestamptz
```

Indexes (`:360-363`):
- `counter_of_id` — child-of-parent lookup for chain walks.
- `status` — the optimistic-concurrency `WHERE status='pending'` clause.
- `(proposer_user_id, updated_at DESC)`, `(recipient_user_id, updated_at DESC)` — the history list query.

Non-obvious invariants:
- **`respondedAt` marks first transition out of `pending`.** A re-declined/re-accepted row is impossible — terminal states are final.
- **`deliveryStatus = 'pending'` is only an initial state.** After the first delivery attempt it's always `delivered` or `failed`. The client reads it to decide whether to surface the "saved but couldn't DM them" fallback banner.
- **`channel_id = thread_id` when the thread flow wins.** `handlePropose` at `api/trades.ts:309` stores the thread id in the DM channel column so `editChannelMessage` works uniformly for both transports — the edit path doesn't have to know whether it's editing a DM or a thread post. `discord_thread_id` is the separate "this is actually a thread" flag.
- **No user-level dedupe.** Two open proposals from @alice to @bob are allowed; they're separate rows. Sessions (area A) enforce "one active session per pair" via a partial unique index; proposals deliberately do not.

### `proposal_events` (`lib/schema.ts:406`)

```
id            text  PK
proposal_id   text  FK trade_proposals.id, on delete cascade
actor_user_id text  FK users.id, on delete set null, null for system events
type          enum  created|delivered_ok|delivered_failed|edited|nudged|accepted|declined|cancelled|countered|expired
payload       jsonb optional per-type bag
created_at    timestamptz
```

Index: `(proposal_id, created_at)` — powers the detail view's oldest-first timeline.

Per-type payload shapes (`lib/schema.ts:383-387`):
- `edited` → `{ cardsChanged, messageChanged }`
- `nudged` → `{ note: string | null }`
- `delivered_failed` → `{ error: string }`
- `counter-of-a-proposal` (the `created` event on a counter child) → `{ counterOfId }`
- `countered` (on the parent when a child lands) → `{ counterId }`

The client's activity feed filters `['created', 'delivered_ok', 'delivered_failed']` as "noisy" (`api/trades.ts:599`) — delivery + creation are implied by the row itself, so surfacing them would clutter the feed. The detail-view timeline shows everything, including the delivery events, because that's a debug-valuable surface.

### Client types

- `TradeDetail` (`src/hooks/useTradeDetail.ts:61`) — detail-view shape, carries chain stubs (`counterOfStub`, `counteredByStub`) so the page can render "counter to …" / "countered by …" links without a second fetch.
- `TradeListEntry` (`src/hooks/useTradesList.ts:6`) — compact row shape for history. `topCard` (highest-priced across both sides) disambiguates dense lists where repeat rows from the same counterpart would otherwise look identical.
- `TradeRow` (`src/hooks/useMyTrades.ts:47`) — unified proposal-or-session shape. `kind` discriminates; `state` is the shared palette.

### Shared state palette (`TradeRowState` at `useMyTrades.ts:23-37`)

```
shared         — session, both slots filled, active
shared-waiting — session, slot B still open (QR handoff pending)
pitched        — proposal pending, viewer is proposer
awaiting       — proposal pending, viewer is recipient  (attention-grabbing)
settled        — session settled OR proposal accepted   (shared terminal)
declined | cancelled | expired | countered  — proposal-only terminals
```

Tone map (applied at render time — the visual layer lives in HomeView; E's area documents the palette):
- **cyan** — `shared` (live session, neutral positive)
- **gold** — `awaiting` (needs viewer response; matches the gold-is-chrome palette rule)
- **emerald** — `settled` (success terminal)
- **red** — `declined` / `cancelled` (failure terminals)
- **neutral** — `pitched` / `shared-waiting` / `expired` (informational, not attention-grabbing)
- **purple** — `countered` (hand-off — a new row has taken over; same color the Discord `buildCounteredProposalMessage` uses, `lib/proposalMessages.ts:766`)

## Public surface

### Endpoints (all under `/api/trades?action=<x>` — see `api/trades.ts:41-60`)

- `POST propose` — create a new proposal. Body: `{ recipientHandle, offeringCards, receivingCards, message? }`. 201 → `{ id, deliveryStatus }`. Private-recipient + self-propose folded into 404 (same message) to avoid existence leaks.
- `GET get` (querystring `id=`) — single proposal detail. Viewer must be proposer OR recipient; anyone else gets 404. Returns the full row shape + chain stubs + event log.
- `GET proposals` — list of proposals involving the viewer, capped at 100, newest `updated_at` first. Includes `recentActivity` (5 most recent non-noisy events across all proposals).
- `POST cancel` — proposer-only. `pending` → `cancelled`. 409 on race-lost, idempotent when already `cancelled`.
- `POST accept` / `POST decline` — recipient-only. Both funnel through `resolveProposal` (`lib/proposalResolve.ts`). 404 folds both "not found" and "not your proposal" to avoid probing.
- `POST counter` — recipient-only. Inserts a new `trade_proposals` row with `counter_of_id = original.id`; transitions the original to `countered`. 409 on race-lost + orphan-row cleanup (see tech debt).
- `POST edit` — proposer-only. Mutates cards / message in place; re-renders the Discord message; preserves buttons. Requires `status='pending' AND responded_at IS NULL`.
- `POST nudge` — proposer-only. 24h cooldown enforced via `lastNudgedAt`. Posts a FRESH Discord message (DM or thread) so the recipient actually gets a push notification — editing is silent.
- `POST bulk-resolve` — viewer-only. Decline (recipient) or cancel (proposer) up to 50 ids in one request. Coalesces decline-notification DMs to one summary per unique proposer.
- `POST promote-to-shared` — recipient-only. Creates a shared session from a pending proposal; returns `{ sessionId, created }`. 200 + `created=false` when the pair already had an active session (the caller redirects into it).

### Hooks

- **`useTradeDetail(id)`** — fetch + mutation wrappers (cancel/accept/decline/nudge/promoteToShared). Module-scoped cache + reload-tick pattern for instant expand-peek. Nudge doesn't share the `mutating` flag because it's a bump, not a state transition.
- **`useTradesList()`** — stale-while-revalidate list + activity feed.
- **`useMyTrades()`** — merges proposals + sessions into one sorted `TradeRow[]`. Exposes `needsResponse` (pending received) as a distinct stream for the Home "needs your response" callout.
- **`useComposerBar({ yourCards, theirCards })`** — send state machine + snapshot builder, shared by all three bars.

### Components

- `<TradeDetailView tradeId>` — mounts at `/?trade=<id>`.
- `<TradesHistoryView>` — mounts at `/?trades=1`.
- `<ProposeBar recipientHandle … />` — sticky bottom bar on `/?propose=<handle>`.
- `<CounterBar originalTradeId … />` — sticky bottom bar on `/?counter=<id>`.
- `<EditBar editingTradeId … />` — sticky bottom bar on `/?edit=<id>`.
- `<TradeExpandPeek proposalId onOpenDetail>` — inline row peek (History view + Home).
- `<NudgeDialog open recipientHandle onClose onNudge>` — modal triggered from proposer-side actions.

## State + data flow

### Happy path: propose → DM → accept

1. **Compose.** User lands on `/?propose=@bob`. `ProposeBar` mounts, `useRecipientProfile` fetches @bob's public wants + available; the matchmaker computes both match modes eagerly so the two Suggest buttons can light up. User picks/adjusts cards, optionally adds a note, clicks Send → `ConfirmProposalDialog` opens.
2. **Send.** `useComposerBar.submit` POSTs `/api/trades/propose` with the frozen card snapshot + note. `handlePropose` (`api/trades.ts:160`) runs: recipient lookup + private-profile gate (`:181-202`), `INSERT` the row with `delivery_status='pending'`, `recordEvent('created')`.
3. **Delivery cascade.** `handlePropose` resolves both sides' `communicationPref` through `resolvePref` (cascade: peer override → self default → registry default) and passes the pair to `deliveryForPair` (`lib/threadConsent.ts:48`). The result picks one of three paths:
   - `thread-immediately` + `resolveTradeGuild` returned a qualifying guild + proposer has `discordId` → bot creates a private thread in that guild's `#swutrade-threads` channel, adds both users in parallel (`Promise.all` — fail-fast kicks into DM fallback, `api/trades.ts:302-328`), posts the proposal message.
   - `dm-with-request` or fallback → DM the recipient with `includeRequestThreadButton` set; either side can escalate to a thread later.
   - `dm-only` → DM only, no thread button.
4. **Persist transport columns.** Whichever path wins, `handlePropose` writes back `delivery_status`, `discord_dm_channel_id`, `discord_dm_message_id`, and (when threaded) `discord_thread_id` + `discord_thread_parent_channel_id`. `recordEvent('delivered_ok' | 'delivered_failed')`.
5. **Recipient sees the DM/thread.** The Discord embed carries `[Accept] [Counter] [Decline]` buttons (+ optional `[Request thread]` + `[⚙ Prefs]` rows). Clicking Accept routes through `api/bot.ts::handleTradeProposalButton` → `resolveProposal({ actorUserId, newStatus: 'accepted' })`.
6. **State transition.** `resolveProposal` (`lib/proposalResolve.ts:61`):
   - Loads the row. Collapses "not found" + "not your proposal" to the same outcome (`:78-80`) — probability of probing is low but the guard costs nothing.
   - Checks `status === 'pending'`; otherwise returns `already-resolved`.
   - Runs the optimistic-concurrency UPDATE (`:89-100`). If 0 rows are returned the race is lost; return `already-resolved` without side effects.
   - `recordEvent('accepted')`.
   - On accept only: `recordTradeAcceptedAcrossGuilds` fans out one `community_events` row per guild where BOTH parties are enrolled + queryable (`lib/communityEvents.ts:66`).
   - Best-effort: edit the original DM/thread message in place via `buildResolvedProposalMessage` (strips the action row, adds a green "Accepted" status line). Failures go through `reportError` but never fail the primary transition.
   - Best-effort: DM the proposer a concise outcome notification via `buildProposerNotification`. Skipped silently when the proposer has no `discord_id` (Phase 5b ghost users, `:177`).
7. **Web surface reconciles.** Either viewer's next `useTradeDetail` hit re-fetches and picks up `status='accepted'`; the detail view flips the badge + renders the new event on the timeline; the list view refreshes its cache after a mutation.

### Optimistic-concurrency pattern (critical)

Every mutating handler uses the same three-step dance:

1. `SELECT` the row.
2. Check preconditions (actor is the right party, `status === 'pending'`, etc.).
3. `UPDATE ... WHERE id = ? AND status = 'pending' RETURNING id`, check `updated.length`.

When step 3 loses the race — another actor transitioned between the select and update — `updated.length === 0` and we return `'already-resolved'` (409 from the HTTP surface, `already-resolved` from the service layer). **No side effects fire in the race-lost branch.** The two DB writes (status change + event insert) haven't happened; the Discord edits don't run; the proposer notification doesn't fire.

Consequences when the precondition check loses:
- **Counter specifically** inserts its child row BEFORE the transition update (`api/trades.ts:918-933`), so race-loss leaves an orphan. The handler cleans it up (`:959-964`) and logs the cleanup failure if the delete itself fails — see tech debt.
- **Promote-to-shared** has the same orphan risk — see `lib/sessions.ts:1086-1097` for the session-cleanup-on-transition-failure pattern, documented more fully in `a-sessions.md`.
- **Accept/decline/cancel/edit** have no orphan risk; their race-loss branch is purely a read-and-skip.

### Counter chain mechanics

Counters form a linked list walked backward via `counter_of_id`. `handleCounter` (`api/trades.ts:855`):

1. Loads the original; validates recipient + `status=pending`.
2. `INSERT` the counter row with `counter_of_id = original.id`, its own `status=pending`, `deliveryStatus=pending`. Proposer/recipient are the original's swapped pair.
3. `recordEvent('created', { counterOfId })` on the counter.
4. Optimistic-concurrency UPDATE on the original → `countered`. **If this loses**, the inserted counter is an orphan — we `db.delete` it with a logged-on-failure catch (`api/trades.ts:959-964`, from the 2026-04-17 foundation slice; see tech debt).
5. `recordEvent('countered', { counterId })` on the original.
6. Best-effort: edit the original's DM with `buildCounteredProposalMessage` (purple "Countered by @x" line, no buttons). Send a new DM to the original proposer with `buildCounterProposalMessage`.
7. Persist the new row's `delivery_status` + channel/message ids.

The detail view surfaces chain stubs (`counterOfStub`, `counteredByStub` at `api/trades.ts:453-469`) so the user can navigate up or down the chain one hop at a time. Full chain walking is deliberately NOT a detail-view concern — the UI isn't a tree viewer; it's a two-hop context pointer.

### Delivery cascade + thread consent

The matrix (`lib/threadConsent.ts:48`):

| proposer / recipient | `prefer`    | `auto-accept` | `allow`           | `dm-only` |
|----------------------|-------------|---------------|-------------------|-----------|
| `prefer`             | thread      | thread        | dm-with-request   | dm-only   |
| `auto-accept`        | thread      | thread        | dm-with-request   | dm-only   |
| `allow`              | dm-w/req    | dm-w/req      | dm-with-request   | dm-only   |
| `dm-only`            | dm-only     | dm-only       | dm-only           | dm-only   |

Two pieces fall out of this:
- **`dm-only` on EITHER side forces dm-only.** No "Request thread" button surfaces in that case — we don't want `dm-only` users to get badgered.
- **Both sides need to be thread-positive for thread-immediately.** `prefer` + `auto-accept` qualifies; `allow` + anything needs an explicit request handshake.

The thread path exists because a two-sided trade conversation in separate DM windows is hostile to the actual negotiation users want to have. Putting both traders in one private thread with a shared message history is closer to how in-person trades actually work — the whole point of area B is that local/in-person trading is the mission; the proposal flow is the async-but-still-conversational prelude.

Thread creation is best-effort. If the bot can't add a user (common: recipient isn't in the same guild as the bot, or the bot lacks the right perms), `Promise.all` rejects, we clean up the orphan thread (`api/trades.ts:323-327`), and fall through to DM delivery. The caller gets `deliveryStatus='delivered'` either way.

### Event log invariants

`proposal_events` is append-only and single-writer. Insert failures swallow + console.log (`lib/proposalEvents.ts:40-46`) — we use `console.error` rather than `reportError` because the error reporter itself can emit bot calls that write events, and an event-insert failure in the reporter path could recursively fail into a tight loop. The missing event is an audit-log loss; the row state has already committed.

The detail view reads oldest → newest (`:63-78`). The "recent activity" slot on the Home module reads newest → oldest but filters `['created', 'delivered_ok', 'delivered_failed']` as noisy — see the rationale in the data-model section. The narrowed union `TradeActivityType` at `useTradesList.ts:26` is the client's type-level mirror of the server filter.

### Nudge mechanics

`handleNudge` (`api/trades.ts:1210`):
- Proposer-only, `status=pending` only.
- 24h rate-limit check reads `lastNudgedAt(db, id)` — returns the most recent `nudged` event timestamp. If within cooldown, returns 429 with `nextAvailableAt` ISO.
- Fetches proposer + recipient; builds `buildProposalMessage` with `nudgeNote` prefix embed (gold-bordered, `:186-190` in `proposalMessages.ts`). The prefix matters — without it the re-post would look identical to the original and the recipient wouldn't realize it's a bump.
- Posts a FRESH Discord message. Thread path → new post in thread (pings every member); DM path → new DM (fresh push notification). Editing the existing message would be silent — no push.
- **Event is recorded unconditionally, even if the Discord post fails.** That's deliberate: the event log IS the cooldown's source of truth. If a failing bot could bypass the cooldown, a buggy transport could let proposers spam-nudge.

### Bulk-resolve mechanics

`handleBulkResolve` (`api/trades.ts:1369`):
- 50-id cap (zod-enforced at `:1336`, UI-capped at `TradesHistoryView:40`).
- Loops each id running the same auth + optimistic-concurrency dance as the single-row handlers. Per-row DM edits (the in-place "cancelled/declined" banner) fire inside the loop.
- **Per-row proposer-notification DMs are NOT fired from the loop.** They're stashed in a `declinesByProposer` map keyed by `proposerUserId` (`:1398, :1504-1511`).
- After the loop, one summary DM (`buildBulkDeclineNotification`) is sent per unique proposer, sequentially, with `BULK_SUMMARY_DM_SPACING_MS = 200ms` between sends (`:1348`).
- Response: `{ results: [{id, outcome}], okCount, notificationsSent }`.

The coalescing exists because Discord rate-limits DM-channel creation separately from its usual 429 — error code 40003 "You are opening direct messages too fast". A recipient clearing ~10 proposals produced 10 DM-channel opens in a tight loop and tripped 40003 in production. One summary per proposer + 200ms spacing is defense-in-depth.

Accept is deliberately excluded from bulk-resolve — accept has downstream effects (coordination message, `community_events` fan-out) that aren't safely batchable.

### Promote-to-shared mechanics

`handlePromoteToShared` (`api/trades.ts:1581`) → `promoteProposalToSession` (`lib/sessions.ts:988`):
- **Recipient-only guard.** Proposers who want to iterate on their own proposal use the existing edit flow; promoting would be a no-op for them (they already have authorship).
- **`already-active-session` branch** — if the pair already has an active session (partial unique index on `trade_sessions` enforces one active at a time), return its id with `created: false`. The HTTP surface maps this to 200 (not 201) so the client knows to redirect instead of minting a new session.
- On success: flips the proposal to `countered` (reuses the existing terminal state — a promoted proposal is effectively replaced by the session, so `countered` is the right hand-off color/word) and inserts a new `trade_sessions` row seeded with the proposal's card snapshots.
- **Orphan cleanup**: if the proposal transition fails after the session insert, the new session is deleted with a logged-on-failure catch (`lib/sessions.ts:1088-1097`) — same pattern as the counter-cleanup fix.

See [`a-sessions.md`](./a-sessions.md) for the session side of this hand-off.

### Caches + invalidation

Module-scoped caches keyed by id (for detail) or singleton (for the list):

- `useTradeDetail.detailCache` (`:118`) — `Map<id, TradeDetail>`. Seeded synchronously on mount from `useState` initialiser, so repeat expands render zero-flicker. On successful mutation the entry is `.delete`d and `reloadTick` is incremented, triggering a fresh `apiGet`. The delete-before-reload ordering matters: if we set the new data first, a concurrent reader would see the mutation's client-inferred state; the reload tick ensures the re-fetch is the source of truth.
- `useTradesList.cache` (`:70`) — singleton `{ proposals, recentActivity }`. Stale-while-revalidate: on a failed refresh with cached data present, keep showing the cache rather than flipping to `'error'`.
- `useMyTrades.cache` (`:88`) — singleton `{ rows }`. Merges two fetches (`/api/trades/proposals` + `/api/me/sessions`) with a ts-desc sort before writing.

All three caches clear on full page reload (correct TTL for session-scoped stale-while-revalidate). `__reset*Cache` helpers exist for tests to isolate cases.

## UI/UX patterns

### The composer bar trio

All three composer bars (`ProposeBar` / `CounterBar` / `EditBar`) are sticky bottom bars using the same gold-tinted container chrome (`bg-gold/10 border border-gold/30`) and share `useComposerBar`. Per-bar differences:

| Bar      | URL                | Seeds                            | Submit                | Copy-over    |
|----------|--------------------|-----------------------------------|------------------------|--------------|
| Propose  | `/?propose=@bob`   | Matchmaker result (manual Suggest)| `/api/trades/propose` via confirm modal | new row |
| Counter  | `/?counter=<id>`   | Original cards SWAPPED            | `/api/trades/counter`  | new row linked via `counter_of_id` |
| Edit     | `/?edit=<id>`      | Existing cards unchanged + existing note (unless dirty) | `/api/trades/edit` | in-place update |

The R4 refactor (R4 = "composer refactor #4" in the repo history) pulled the shared tail end (send state machine + snapshot + note textarea) into `useComposerBar` but intentionally left the mount-fetch + seed-once pattern inline in each component — the fetch shapes differ enough (user profile vs. proposal row) that a shared fetch abstraction would be more indirection than win.

### TradeDetailView response buttons

Recipient + pending renders four response buttons:

- **Accept** — emerald primary (success tone, matches the "offering" side color).
- **Counter** — deep-link anchor to `/?counter=<id>`. Secondary tone.
- **Decline** — red danger.
- **Edit together** — secondary tone. Fires `promoteToShared` → navigates to `/s/<sessionId>` on success.

**Known vocabulary mismatch (UX-A3 in `NEXT.md:132-136`):** the first three buttons are proposal vocabulary; "Edit together" is session vocabulary. The planned reframe is "Accept as-is · Edit together · Counter offer · Decline" — grouping Accept and Edit-together as adjacent positive responses — but that rework hasn't shipped.

### State badges

`StatusBadge` (rendered in both `TradeDetailView` and `TradesHistoryView`) consumes the `TradeStatus` union. Colors follow the palette invariants (`project_swutrade_palette` memory): gold for the primary chrome (proposal-gold is the pending color), emerald for accepted, red for declined/cancelled, neutral for expired, purple for countered. The state badge shape is documented here; the visual layer belongs to E ([`e-home-nav.md`](./e-home-nav.md)) because HomeView owns the unified tone map.

### Empty states + defaulting

- `TradesHistoryView` picks its default tab heuristically on first render: incoming (if any pending received) → outgoing (if any pending sent) → history. Never silently drops the user into History when there's live work elsewhere.
- Per-tab empty states have distinct copy so the user knows WHY it's empty (incoming → "check Outgoing for trades you've sent"; outgoing → "visit a community member's profile to send one"; history → the archive framing).
- Full-empty (no proposals at all) keeps the legacy "No trade proposals yet" headline because an existing e2e pins that text.

### Mobile + desktop parity

Both surfaces (List and Detail) are first-class on mobile + desktop. ConfirmProposalDialog is a bottom sheet on mobile (max-height 90dvh, rounded top) and a centered modal on desktop (`ProposeBar.tsx:478-485`). Composer bars are sticky bottom on every viewport. Row selection checkboxes in the history view are sized to be thumb-friendly on mobile (w-5 h-5 hit target) while staying compact on desktop.

### Discord deep links

`TradeDetailView` renders an "Open thread in Discord" link only when `discord_thread_id` is present (`:210-216`). Uses `https://discord.com/channels/@me/<threadId>` rather than the `discord://` URI — Discord auto-detects the installed desktop app when the https form is followed, so one link covers both paths and falls back to browser rendering when the app isn't installed.

## Tech debt + known gaps

- **Response-button vocabulary (UX-A3).** `TradeDetailView.ActionBar` mixes proposal verbs (Accept / Counter / Decline) with session verbs ("Edit together"), which the audit flagged as confusing. See `NEXT.md:132-136` for the planned reframe. No code change shipped yet.
- **Proposal expiry cron is unscheduled.** Proposals sit `pending` indefinitely today. `NEXT.md:170-172` describes the planned `/api/jobs/expire-proposals` daily cron (30-day TTL). The `expired` status enum value exists and the event log already has an `expired` type, but nothing fires them. Downstream consequence: the "Expired" badge color + timeline row in `TradeDetailView` is dead code until this lands.
- **Counter-cleanup race logging (2026-04-17 foundation slice 1, `NEXT.md:399-400`).** `handleCounter` at `api/trades.ts:959-964` used to silently swallow the orphan-delete failure. Now it logs — but the orphan row still exists if the delete fails, and there's no reconciler that sweeps them. A rare but real audit-log foot-gun. Same pattern lives in `handlePropose` thread cleanup (`:323-327`) and `promoteProposalToSession` (`lib/sessions.ts:1086-1097`).
- **`useTradeDetail` module-scoped cache never evicts.** It only clears on successful mutation or full reload. Long-lived SPA sessions accumulate entries for every proposal the user has viewed. Acceptable today (proposals are small + the count doesn't get large for real users), but a bounded LRU would be the right shape if it grows.
- **Large proposals and the 1024-char embed cap.** `formatCardList` (`lib/proposalMessages.ts:67-89`) reserves a 94-char buffer for a "+N more — open the web app" summary line because Discord embed field values cap at 1024 chars. Fixed 2026-04-17 (`NEXT.md:288-289`). If someone proposes a 100-card trade and the list gets truncated, the Discord DM shows the top N + a pointer to the web view — the row data stays complete.
- **Thread creation failure silently degrades to DM.** Good UX-wise, but the log line at `api/trades.ts:313` is the only observable signal. No metric on "threads attempted vs DMs fallen back to," so we can't easily tell if a guild-level permission regression tanks thread delivery for everyone.
- **`handlePropose`'s thread-immediately path uses `Promise.all` for member-adds (`:302-305`), which fail-fasts.** That's deliberate — partial adds are worse than no thread — but it means one flaky member-add aborts the whole flow. Works in practice because both parties are always-adds; not robust against Discord-side partial outages.
- **No idempotency key on proposal creation.** A double-click that slips past the composer's `sending` guard could produce two rows. The `sending` guard in `useComposerBar.submit` (`:142`) covers the happy path, but the mobile-browser "tab backgrounded, network hiccup, retry" case could theoretically double-send.
- **`delivered_failed` payload is loose.** Schema comment says `{ error: string }` but `handlePropose` passes `undefined` on the failed branch (`:379-382`). Debugging a silent delivery failure means correlating `reportError` logs rather than reading the event payload.
- **`TradesHistoryView`'s bulk-cap is a silent-cap.** Selecting past 50 silently no-ops (`:117`); the "50 of 200" hint in `SelectAllBar` explains it but users can still end up confused if they're spam-clicking rows rather than Select-All.
- **Promote-to-shared reuses `countered` as the proposal terminal.** Not bad — the hand-off reading is right — but it conflates two distinct reasons a proposal ends up `countered` (someone sent a counter vs. someone promoted to a session). The event log disambiguates (`promoted` doesn't exist as an event type today; the transition is recorded via session-side events instead). If surfacing "countered vs. promoted" ever matters, this is where to start.
- **No coverage for the "proposer has no `discord_id`" path** in `resolveProposal` (`:177-178`). The guard exists for ghost-user edge cases but the test suite doesn't exercise it.

## Decisions worth remembering

- **DB is authoritative; Discord is transport.** Every Discord side effect after a state transition is wrapped in try/catch + `reportError`; none of them can fail the primary response. This is why `delivery_status` exists as a separate axis — the status transition can succeed with a failed delivery, and the UI surfaces both.
- **Optimistic concurrency over row locks.** We UPDATE-WHERE-status='pending' rather than `SELECT ... FOR UPDATE`. Cheaper (Postgres doesn't have to take a row lock), and we're never dealing with long transactions here anyway. The race window is single-digit milliseconds.
- **Folding "not found" and "not your proposal" to the same 404.** `resolveProposal:78-80` + `handleGetProposal:432-434` + bulk decline: none of these endpoints leak proposal existence to non-parties. Probability of probing is low but cost is zero.
- **One dispatcher file for the whole proposal surface.** Vercel Hobby function ceiling (see `project_swutrade_function_ceiling` memory). All `/api/trades/*` actions live in one handler with an `action` query param + `vercel.json` rewrites.
- **Frozen card snapshots.** Alternatives considered: store `productId[]` and look up current names/variants/prices at read time. Rejected because (a) prices drift — the proposal represents the pricing context at compose time, not today's quote, and (b) either party may have removed cards from their lists between send and response; showing what was offered is more useful than showing "that card's not in my list anymore." See `lib/schema.ts:279-284`.
- **Counter chains via self-FK, not a separate `counter_chains` table.** Walking the chain is a two-hop UI concern; the list view shows the latest leaf; the detail view shows one-hop context. A dedicated chain table would be overkill.
- **Append-only event log vs. computed timeline.** Computing "edited at X" from `updated_at` would drop history the moment the next edit lands. The event log stays cheap ('delete on cascade' when the proposal dies) and makes the detail timeline trivial.
- **Nudge event recorded even on Discord failure.** See "Nudge mechanics" above. Feature > transport.
- **Bulk-decline coalesces per proposer.** See "Bulk-resolve mechanics." Discord's 40003 rate-limit drove the design.
- **Thread immediacy requires both sides.** The consent model's default is `allow` (neither opted in, neither refused), which forces the button-request handshake. `dm-only` on either side is absolute — we don't re-request. See `lib/threadConsent.ts:32-61`.
- **Composer bars aren't one component.** The R4 refactor considered collapsing ProposeBar + CounterBar + EditBar into one configurable component. Rejected because the per-mount fetch + seed-once lifecycle differs enough that the union type would be messier than three focused siblings with one shared hook.
- **Promote-to-shared is a recipient action.** The design intent: proposers iterate on their own proposal via edit; recipients who want to collaborate instead of responding up-or-down have the promote escape hatch. See `lib/sessions.ts:956-965` for the full rationale.
- **Accept fires community events; decline does not.** Declines are private by design — a declined trade isn't a public event in the community activity feed. Only the accept terminal triggers `recordTradeAcceptedAcrossGuilds`.

## Cross-references

- [`a-sessions.md`](./a-sessions.md) — `promoteProposalToSession` hand-off, `already-active-session` dedupe, and the shared canvas the recipient lands on after clicking "Edit together."
- [`c-trade-builder.md`](./c-trade-builder.md) — the two-panel builder + matchmaker that feeds the compose step; AutoBalanceBanner vs. ProposeBar distinction.
- [`d-lists.md`](./d-lists.md) — the wants + available lists that the compose-time matchmaker reads from (and that the frozen snapshots don't) — including the priority-flag wiring referenced in the `★ Priorities` suggest button.
- [`e-home-nav.md`](./e-home-nav.md) — HomeView's My Trades module, the unified state-badge tone palette (cyan/gold/emerald/red/neutral/purple) that applies to `TradeRow` rendering.
- [`f-community-profile.md`](./f-community-profile.md) — community activity feed (`recordTradeAcceptedAcrossGuilds` writes there), profile views that launch propose flows.
- [`g-auth.md`](./g-auth.md) — `requireSession` guard used by every proposal endpoint; ghost-user `discord_id IS NULL` case that makes proposer-notification best-effort.
- [`h-cards-pricing.md`](./h-cards-pricing.md) — card index + pricing service used by `buildSnapshot` to freeze prices at compose time.
- [`i-discord-bot.md`](./i-discord-bot.md) — `createDiscordBotClient`, signature verification, `handleTradeProposalButton`, the prefs registry that powers the `⚙ Prefs` button on proposal DMs.
- [`j-infra.md`](./j-infra.md) — Vercel function ceiling + `vercel.json` rewrite that routes `/api/trades/:action` to the single dispatcher.
