# A. Trade sessions (live / shared)

> **Owner scope**
>
> - `lib/sessions.ts` — core domain module; every state transition lives here.
> - `api/sessions.ts` — HTTP dispatcher for `/api/sessions/*` actions.
> - `src/hooks/useSession.ts` — client polling, mutation mutex, optimistic updates.
> - `src/components/SessionView.tsx` — the `/s/:id` canvas (InvitePrompt, OpenSlotInvite, InviteByHandleForm, GhostSignInBanner, SessionIdentityStrip, TerminalBanner, SessionActionBar).
> - `src/components/ShareLiveTradeButton.tsx` — "Invite someone" button in the trade builder's action strip.
> - `tests/api/sessions-read.test.ts`, `tests/api/sessions-write.test.ts`, `tests/api/sessions-claim.test.ts`, `tests/api/sessions-invite.test.ts`, `tests/api/sessions-merge.test.ts`.
> - `e2e/session-live-trade.auth.spec.ts`, `e2e/session-lifecycle.auth.spec.ts`.
> - Schema rows in `lib/schema.ts` lines 496–622 (`tradeSessions`, `sessionEventTypes`, `sessionEvents`).
> - `vercel.json` rewrites for `/s/:id` and `/api/sessions/*`.

## Overview

A **trade session** is a Phase 5b primitive that lets two users collaboratively edit the same trade at `/s/:id`. Unlike proposals (async one-shot DMs with accept/decline/counter), a session is a mutable shared canvas: both parties have their own editable half, the balance strip updates live, and the trade doesn't finalize until **both** sides hit Confirm. The session lifecycle is `active` (optionally `active + openSlot` while waiting for a scanner) → one of `settled | cancelled | expired`. Sessions are the primitive that makes the "two people at a game store with phones" flow work — QR-code handoff, anonymous ghost users, no Discord account required.

## Key concepts / glossary

- **Session short code** — `lib/sessions.ts:38` — 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0/O/1/I`, ambiguity-resistant for read-aloud or paper hand-off). `~32^8 ≈ 1.1×10¹²` codes, generated with `crypto.getRandomValues`; no collision-retry because the keyspace dwarfs active-session volume.
- **Canonical participant order** — `lib/sessions.ts:111` — whenever both slots are filled, `user_a_id < user_b_id` lexicographically. The storage layer and the partial unique index depend on this; `normalizeParticipants()` is the one chokepoint that enforces it. Viewers never see a/b — `getSessionForViewer` flips storage into `yourCards` / `theirCards`.
- **Open slot** — a session where `user_b_id IS NULL`. The creator is in slot A, the session renders the QR / share-link invite surface, and anyone with the URL can claim slot B via `POST /api/sessions/:id/claim`.
- **Ghost user** — `lib/sessions.ts:79` — an anonymous placeholder user row (`is_anonymous = true`, `discord_id = null`, handle `guest-<5char>`). Minted on demand by `create-open` or `claim` so the URL/QR flow works without Discord sign-in. Merged into the real user row by the OAuth callback (see `g-auth.md`).
- **Viewer-centric view** — `lib/sessions.ts:126` — the `SessionView` shape returned to clients. Hides canonical a/b ordering and returns `yourCards` / `theirCards` / `confirmedByViewer` / `lastEditedByViewer` relative to whoever's asking.
- **Session preview** — `lib/sessions.ts:237` — the small "someone invited you" payload returned to non-participants on an open session. Exposes creator identity + card count; deliberately omits the card list so URL harvesters can't browse offers.
- **Mutation mutex** — `src/hooks/useSession.ts:134` — `mutationInFlightRef`. A boolean ref flipped true at the top of every save/confirm/cancel/claim; the 2.5-second poll early-returns while it's held. Without this, a poll landing between an optimistic local update and the server response would visibly revert the edit.
- **Terminal state** — any `status !== 'active'`. The poll stops firing (`useSession.ts:189`), `TradeSide` flips to `readOnly` on both halves, `SessionActionBar` hides entirely, and a `TerminalBanner` names the state.
- **Counterpart-edit banner** — `SessionView.tsx:214` via `hasUnseenCounterpartEdit` — "Alice made changes. Tap to dismiss." Seeded as "already seen" on first render so the banner doesn't fire on page load; any later counterpart edit flips it on.
- **Promote to session** — `lib/sessions.ts:988` (`promoteProposalToSession`). The recipient of a pending proposal converts it into a shared session. The proposal transitions to `countered` and a new session row holds both sides' cards. See `b-proposals.md` for the proposal-side view.

## File map

### Server

**`lib/sessions.ts`** — Domain module. Every session state transition lives here: `createOrGetActiveSession`, `createOpenSession`, `claimOpenSlot`, `editSessionSide`, `confirmSession`, `cancelSession`, `inviteHandleToSession`, `promoteProposalToSession`, `mergeGhostIntoRealUser`. Also owns `generateSessionCode`, `normalizeParticipants`, `getSessionForViewer`, `getSessionPreview`, `listActiveSessionsForViewer`, `recordSessionEvent`, and the `SESSION_TTL_MS` + `SESSION_INVITE_DEBOUNCE_MS` constants.

**`api/sessions.ts`** — HTTP dispatcher. `default export` routes on `?action=` to the nine sub-handlers (`get` / `list` / `create` / `edit` / `confirm` / `cancel` / `create-open` / `claim` / `invite-handle`). Consolidated into one file to stay under the Vercel function ceiling (see `j-infra.md`). Sub-handlers are exported for direct-call integration tests.

**`lib/schema.ts`** (lines 496–622) — `tradeSessions` table + `sessionEvents` append-only log. Partial unique index, jsonb `last_notified_at`, FK policies (cascade on session, set-null on event actor) all defined here.

**`lib/proposalMessages.ts`** `buildSessionInviteMessage` (line 1064) — the DM body rendered by `inviteHandleToSession`. Uses a link in the embed description rather than a LINK button for client compatibility.

### Client

**`src/components/SessionView.tsx`** — The `/s/:id` canvas. Mounts via `App.tsx:486` when the router detects the session view mode. Owns the whole stage-→-confirm layout (identity strip → balance → two panels → action bar) plus the InvitePrompt, OpenSlotInvite, InviteByHandleForm, GhostSignInBanner, SessionIdentityStrip, TerminalBanner, and SessionActionBar sub-components.

**`src/hooks/useSession.ts`** — Client-side state machine. Fetches via `GET /api/sessions/:id`, polls every 2.5s with visibility pause + mutation mutex + terminal skip, maintains a module-scoped cache (`createKeyedCache`), exposes `saveCards` / `confirm` / `cancel` / `claim` with optimistic updates.

**`src/components/ShareLiveTradeButton.tsx`** — The "Invite someone" action in the trade builder's action strip. Posts to `/api/sessions/create-open` with BOTH halves of the current calculator seeded, then navigates to `/s/<id>`.

**`src/contexts/NavigationContext.tsx:66/334`** — `toSession(id)` exposed via the nav API. Full navigation (`window.location.href`) so `App` remounts and `SessionView` reads the pathname cleanly — no SPA intent state is mirrored because sessions are server-authoritative.

**`src/App.tsx:479-487`** — Router dispatch: when `viewMode === 'session'`, extracts the id from the pathname and renders `<SessionView sessionId={...} />`.

### Routing

**`vercel.json`** — `/s/:id` rewrites to `/` so the SPA boots for every session URL (the `session-live-trade.auth.spec.ts` header comment notes this was a shipped bug — without the rewrite, Vercel served its platform 404 HTML and the SPA never booted to render the in-view not-found state). Also the nine `/api/sessions/*` rewrites that turn pretty URLs into `?action=` dispatches.

### Tests

- **`tests/api/sessions-read.test.ts`** — `GET /api/sessions/:id` + `/api/me/sessions` (list). Non-participant 404, viewer-centric rehydration, list ordering.
- **`tests/api/sessions-write.test.ts`** — `create` / `edit` / `confirm` / `cancel`. Pair-uniqueness redirect (201 vs 200 + `created:false`), self-trade 400, counterpart-half untouched, confirmations cleared on edit, both-confirm → settled.
- **`tests/api/sessions-claim.test.ts`** — Open-session creation + claim. Anonymous-create mints a ghost, non-participant GET returns preview, claim is idempotent, third-party claim after fill → 409.
- **`tests/api/sessions-invite.test.ts`** — `invite-handle`: happy-path DM + event, 404 unknown handle, 403 non-creator, 400 self-invite, 409 closed session, 403 ghost creator, debounce within the 10-min window.
- **`tests/api/sessions-merge.test.ts`** — Ghost → real user migration. Confirmation carry-over, last-edited-by promotion, pair-uniqueness conflict leaves ghost row alive.
- **`e2e/session-live-trade.auth.spec.ts`** — Browser-layer smoke: `/s/<unknown>` renders the SPA (not platform 404), anonymous "Invite someone" click yields `/s/<code>` with a QR. Two bugs documented in the file header as the reason this spec exists.
- **`e2e/session-lifecycle.auth.spec.ts`** — Serial spec: two anonymous contexts walk create → claim → both-add → both-confirm → settled, plus the cancel-one-side-locks-both-sides path.

## Data model

### `trade_sessions`

Lives at `lib/schema.ts:499-573`. Canonical row:

| column | type | notes |
|---|---|---|
| `id` | `text` primary key | 8-char code from `CODE_ALPHABET` |
| `user_a_id` | `text NOT NULL, FK users(id) ON DELETE CASCADE` | always set; canonical-ordered |
| `user_b_id` | `text NULL, FK users(id) ON DELETE CASCADE` | null for open-slot sessions |
| `user_a_cards` | `jsonb DEFAULT []` | `TradeCardSnapshot[]` |
| `user_b_cards` | `jsonb DEFAULT []` | `TradeCardSnapshot[]` |
| `status` | `active \| settled \| cancelled \| expired` | default `active` |
| `confirmed_by_user_ids` | `text[]` | participants who tapped Confirm; cleared on any edit |
| `last_edited_at` | `timestamptz` | bumped on every edit; drives "most recent" sort |
| `last_edited_by_user_id` | `text NULL, FK users(id) ON DELETE SET NULL` | debounce-DM job reads this to pick the OTHER user |
| `last_notified_at` | `jsonb DEFAULT {}` | `Record<userId, ISOTimestamp>` — last DM fired to each user |
| `expires_at` | `timestamptz NOT NULL` | rolling; bumped on edit + claim |
| `created_at` / `updated_at` | `timestamptz` | standard |
| `settled_at` | `timestamptz NULL` | captured on first transition out of `active` (symmetric with `trade_proposals.respondedAt`) |

**Indexes:**

- `trade_sessions_active_pair_idx` — **partial unique** on `(user_a_id, user_b_id) WHERE status = 'active' AND user_b_id IS NOT NULL` (`schema.ts:564`). Two properties that matter: (a) only one active session per canonical pair, and (b) **open-slot sessions are exempt** — a user can host multiple open invites in parallel (two tables at the same LGS). Once slot B fills, the index kicks in.
- `trade_sessions_user_a_status_idx` / `trade_sessions_user_b_status_idx` — viewer-lookups.
- `trade_sessions_status_expires_idx` — for the not-yet-shipped TTL-expiry cron.

**FK policies:**

- `user_a_id` / `user_b_id` → `ON DELETE CASCADE`. Deleting a user nukes their sessions. This is why `mergeGhostIntoRealUser` must rewrite session participant columns **before** deleting the ghost row.
- `last_edited_by_user_id` → `ON DELETE SET NULL`. Safe to drop; only used as a target for the debounce-DM job.

**Invariants:**

1. `user_a_id IS NOT NULL` always — someone originates the session.
2. When `user_b_id IS NOT NULL`: `user_a_id < user_b_id` lexicographically. Violating this breaks `findActiveSessionForPair` because it always normalizes before the lookup.
3. After `mergeGhostIntoRealUser` or `claimOpenSlot`, cards travel with whoever owned them — the merge re-normalizes the pair and swaps `user_a_cards` ↔ `user_b_cards` to match if the sort flipped (`lib/sessions.ts:598`, `:896`).

### `session_events` (append-only log)

`schema.ts:606-622`. Event types: `created | edited | confirmed | unconfirmed | settled | cancelled | expired | notified`. FK to `tradeSessions` with cascade delete; FK to `users.actor_user_id` with set-null (ghost merges rewrite actor refs before deleting the ghost row, but set-null is the safety net).

**Payload discriminants worth remembering:**

- `created { openSlot: true }` on `createOpenSession`.
- `created { claimed: true }` on `claimOpenSlot` filling slot B.
- `created { promotedFromProposalId }` on `promoteProposalToSession`.
- `notified { kind: 'invite', targetHandle, targetUserId }` on successful `invite-handle` DM.
- `notified { kind: 'invite-debounced', targetHandle, targetUserId }` on a suppressed duplicate within `SESSION_INVITE_DEBOUNCE_MS`.
- `edited { side: 'a' | 'b', count }` — recorded on every `editSessionSide`.
- `unconfirmed { cleared: N }` — emitted alongside `edited` when the edit cleared existing confirmations.

The `notified` type reuses a single enum value with payload discriminants rather than adding `invited` / `invite-debounced` / future-`notified-change` values. This is **deliberate**: avoids a schema migration every time we add a new kind of DM. See `lib/sessions.ts:1143` for the reasoning comment.

### `TradeCardSnapshot`

Shared with proposals (see `b-proposals.md`). `{ productId, name, variant, qty, unitPrice }`. Stored verbatim in the jsonb columns — snapshots deliberately don't track card index revisions, so a card that changes sets after the session freezes still renders with its stored name and unit price.

### `SessionView` (viewer-centric)

Mirrored client-side in `src/hooks/useSession.ts:24`. Key derived fields:

- `yourCards` / `theirCards` — storage-layer `user_a_cards` / `user_b_cards` flipped to the viewer's perspective.
- `openSlot: boolean` — true iff `user_b_id IS NULL`.
- `confirmedByViewer` / `confirmedByCounterpart` — membership flags derived from `confirmed_by_user_ids`.
- `lastEditedByViewer: boolean` — `lastEditedByUserId === viewer`. Drives the counterpart-edit banner logic.
- `counterpart: {…} | null` — `null` when `openSlot`, otherwise the other user's identity (handle, username, avatarUrl, isAnonymous).

### `SessionPreview` (non-participant view)

Limited payload: `{ id, creator: {…}, creatorCardCount, createdAt, expiresAt }`. **Never includes card details** — preview-URL harvesting shouldn't leak offer contents. The full card list only renders after a claim.

## Public surface

### Exports (lib)

- `generateSessionCode() → string` — 8-char id from `CODE_ALPHABET`.
- `normalizeParticipants(a, b) → { userAId, userBId }` — canonical sort. Call before every session insert.
- `nextExpiresAt(from?) → Date` — `SESSION_TTL_MS` = 14 days (`lib/sessions.ts:436`) from `from`.
- `createGhostUser(db) → GhostUser` — mints an anonymous user row. Caller is responsible for installing the iron-session cookie.
- `getSessionForViewer(db, sessionId, viewerUserId) → SessionView | null` — 404-on-wrong-viewer is a policy choice: same as `trade_proposals` detail, session ids aren't probeable by non-participants.
- `getSessionPreview(db, sessionId) → SessionPreview | null` — null for unknown id, terminal session, OR both-slots-filled.
- `listActiveSessionsForViewer(db, viewerUserId, opts) → SessionView[]` — active only, most-recently-edited first, limit clamped `[1, 100]`.
- `findActiveSessionForPair(db, a, b) → string | null` — belt-and-suspenders companion to the partial unique index.
- `createOrGetActiveSession(db, args) → { created, id }` — see **State + data flow** below.
- `createOpenSession(db, args) → { id }` — slot A populated, slot B null.
- `claimOpenSlot(db, args) → ClaimOpenSlotResult` — discriminated union: `{ ok: true, view, claimed }` or `{ ok: false, reason: 'not-found' | 'self' | 'conflict' | 'terminal' }`.
- `editSessionSide(db, args) → EditSessionResult` — replaces the viewer's half, clears confirmations, bumps expiry, records events.
- `confirmSession(db, args) → ConfirmSessionResult` — `{ ok, view, settled }` or reason. `settled` flips to true only if the counterpart had already confirmed.
- `cancelSession(db, args) → CancelSessionResult` — idempotent against terminal states.
- `inviteHandleToSession(db, args)` — DMs the session URL to a handle; debounced per `SESSION_INVITE_DEBOUNCE_MS` (10 min, `lib/sessions.ts:1148`).
- `promoteProposalToSession(db, args) → PromoteProposalResult` — recipient-only, re-uses `countered` proposal status, returns `already-active-session` with the winning id on pair conflict.
- `mergeGhostIntoRealUser(db, ghostId, realUserId) → void` — called from `api/auth.ts:291` in the OAuth callback. See `g-auth.md`.
- `recordSessionEvent(db, opts) → void` — fire-and-forget; logged failures, never throws (same as `proposalEvents`).

### Endpoints

All at `/api/sessions/*`, dispatched by `api/sessions.ts` via `vercel.json` rewrites:

- `GET /api/sessions/:id` — no auth required. Participant → `{ session: SessionView }`, non-participant on open session → `{ preview: SessionPreview }`, else 404. `Cache-Control: private, no-store`.
- `GET /api/me/sessions?limit=…` — auth required; active sessions for the viewer, most-recent first.
- `POST /api/sessions/create` — auth required. Body `{ counterpartHandle, initialCards }`. 201 + `{ id, created: true }` on fresh insert, 200 + `{ id, created: false }` when redirecting into existing active session, 400 self-trade, 404 unknown handle.
- `POST /api/sessions/create-open` — auth NOT required. Mints a ghost + sets cookie if the caller has no session. Body `{ initialCards, counterpartInitialCards }` — both halves seeded (the counterpart half is a **starting suggestion** the scanner can edit, not a constraint).
- `POST /api/sessions/:id/claim` — auth NOT required. Mints a ghost + sets cookie if needed. `201` on fresh claim, `200` on idempotent re-claim by same viewer, `400` self-claim, `409` conflict, `409` terminal.
- `PUT /api/sessions/:id/edit` — auth required. Body `{ cards }`. 404 non-participant (no-leak), 409 terminal.
- `POST /api/sessions/:id/confirm` — auth required. Idempotent.
- `POST /api/sessions/:id/cancel` — auth required. Idempotent on already-terminal.
- `POST /api/sessions/:id/invite-handle` — auth required, **not ghosts** (403 if `session.isAnonymous`). Body `{ handle }`. 502 on `dm-failed`, 404 on unknown handle, 400 self-invite, 409 closed session, 403 non-creator.

### Endpoint error-mapping table

Useful when debugging production logs. Library `reason` strings get mapped to HTTP codes in `api/sessions.ts`:

| Handler | Reason string | HTTP status | Notes |
|---|---|---|---|
| `get` | (no body) | `404` | participant-404 + non-participant-404 + no-preview all collapse |
| `create` | self-trade | `400` | check happens in `api/sessions.ts:195` before hitting lib |
| `create` | handle not found | `404` | before hitting `createOrGetActiveSession` |
| `claim` | `not-found` | `404` | |
| `claim` | `self` | `400` | creator can't claim their own session |
| `claim` | `terminal` | `409` | session is settled/cancelled/expired |
| `claim` | `conflict` | `409` | slot B was filled by someone else mid-flight |
| `edit` | `not-found`, `not-participant` | `404` | collapsed to avoid leaking session existence |
| `edit` | `terminal` | `409` | |
| `confirm` | `not-found`, `not-participant` | `404` | same collapse |
| `confirm` | `terminal` | `409` | |
| `cancel` | `not-found`, `not-participant` | `404` | cancel is idempotent on terminal — no 409 here |
| `invite-handle` | (ghost viewer) | `403` | gate at the API layer before lib call |
| `invite-handle` | `not-found` | `404` | |
| `invite-handle` | `not-creator` | `403` | |
| `invite-handle` | `not-open` | `409` | terminal OR both-slots-filled both collapse |
| `invite-handle` | `self-invite` | `400` | |
| `invite-handle` | `no-such-handle` | `404` | |
| `invite-handle` | `dm-failed` | `502` | bot threw, or target has no `discord_id` |

Note the **participant-vs-non-participant collapse** on read endpoints. Returning `403 not-participant` would leak "this session id exists but isn't yours," letting an attacker enumerate valid codes. Collapsing to `404` keeps session ids unprobeable (same policy as `trade_proposals` detail).

### Hooks / components (frontend)

- `useSession(sessionId)` — returns `{ session, preview, status, saveCards, confirm, cancel, claim, hasUnseenCounterpartEdit, markCounterpartSeen }`. Status enum `'loading' | 'ready' | 'preview' | 'not-found' | 'error'`.
- `<SessionView sessionId={…} />` — the canvas. Mounts at `App.tsx:486` when the router matches `/s/:id`.
- `<ShareLiveTradeButton yourCards={} theirCards={} />` — the trade builder's "Invite someone" action (see `c-trade-builder.md`).

## State + data flow

### Lifecycle (ASCII)

```
                 ┌─────────────────────────────────────┐
                 │                                     │
                 │  (nothing)                          │
                 │                                     │
                 └──────────────┬──────────────────────┘
                                │
    ┌───────────────────────────┼───────────────────────────┐
    │                           │                           │
    ▼                           ▼                           ▼
POST /create           POST /create-open         POST /trades/promote-
(known handle)         (QR handoff)              to-shared (recipient)
    │                           │                           │
    │                           │                           │
    ▼                           ▼                           ▼
┌─────────────┐       ┌──────────────────┐       ┌─────────────┐
│   active    │       │ active+openSlot  │       │   active    │
│ pair: A,B   │       │ A in slotA, B=∅  │       │ pair: P,R   │
└──────┬──────┘       └────────┬─────────┘       └──────┬──────┘
       │                       │                        │
       │               POST /:id/claim                  │
       │               (another user)                   │
       │                       │                        │
       │                       ▼                        │
       │               ┌──────────────┐                 │
       │               │   active     │                 │
       │               │ pair: A, X   │                 │
       │               └──────┬───────┘                 │
       │                      │                         │
       └───────────┬──────────┴─────────────────────────┘
                   │
             (edit / confirm)
                   │
    ┌──────────────┼──────────────┐
    │              │              │
    ▼              ▼              ▼
 both         /cancel         TTL cron
 confirm     (either           (not yet
    │        party)            shipped)
    ▼              ▼              ▼
┌────────┐   ┌─────────────┐  ┌─────────┐
│settled │   │  cancelled  │  │ expired │
└────────┘   └─────────────┘  └─────────┘
     (all terminal; readOnly canvas on load, no further transitions)
```

Each transition writes a row to `session_events` (best-effort; failures log but don't roll back the parent write).

### Creating a session: three entry points

**Signed-in, known counterpart**: user clicks a "Start shared trade" affordance (e.g. from a community-activity row or a profile). `POST /api/sessions/create` runs `createOrGetActiveSession` which (a) looks up any existing active session for the pair with `findActiveSessionForPair`, (b) falls through to insert, (c) catches the partial-unique-index rejection and re-looks-up as a belt for the suspenders. Returns `created:true/false` so the UI can render the "you already had a session" copy.

**Anonymous or signed-in, QR handoff**: user is mid-trade in the builder, clicks "Invite someone" (`ShareLiveTradeButton`), server `POST /api/sessions/create-open` mints a ghost if needed (new iron-session cookie on the response), inserts with `user_b_id = null`, seeds **both halves** from the calculator, navigates to `/s/<id>`. The creator now sees `OpenSlotInvite` (QR + shareable URL + invite-by-handle form if signed in).

### Claim: the slot-B fill

1. Scanner opens `/s/<id>` from QR / link.
2. `GET /api/sessions/<id>`:
   - If they have no cookie → `preview` response, `SessionView` renders `InvitePrompt` ("You're invited to a trade / @alice / Join this trade").
   - If they already have a cookie (ghost or real) and they're NOT a participant → `preview` same as above.
   - If they ARE a participant (idempotent re-load) → full `session` response.
3. Scanner taps "Join this trade" → `POST /api/sessions/:id/claim`.
4. Server mints a ghost if the caller has no cookie, then `claimOpenSlot`:
   - Already a participant → idempotent no-op, return current view.
   - Slot B already filled by someone else → `conflict` → `409`.
   - Slot B null → normalize the pair (the claimer's id might sort BEFORE the creator's, in which case we swap slot-A/slot-B assignments AND the cards so ownership tracks identity, not position — `lib/sessions.ts:594-612`), set `expires_at = nextExpiresAt(now)`.
5. `SessionView` re-fetches; the `OpenSlotInvite` chrome goes away; both sides now see `SessionIdentityStrip` + balance + two panels + action bar.

### Editing: optimistic updates + mutex

`useSession.saveCards(cards)` at `src/hooks/useSession.ts:239`:

1. `mutationInFlightRef.current = true` — hold the mutex.
2. Build an optimistic `SessionView`: `yourCards = cards`, both `confirmed*` flags cleared, `lastEditedByViewer = true`, `lastEditedAt = now`.
3. Apply to local state + module cache → canvas reflects the edit immediately.
4. Reset `seenCounterpartEditAt = optimistic.lastEditedAt` so the viewer's own edit doesn't trigger the counterpart-change banner.
5. `PUT /api/sessions/:id/edit` with `{ cards }`.
6. On success: overwrite with server-authoritative view, update seen pointer.
7. On failure: clear the mutex first, then `fetchOnce()` to roll back to canonical server state.
8. `finally { mutationInFlightRef.current = false }`.

The mutex matters because the 2.5s poll also calls `fetchOnce`. Without the mutex, a poll landing between step 3 and step 6 would temporarily revert the edit (the server hasn't seen it yet, so the poll payload reflects old state). With the mutex, `fetchOnce` early-returns during the in-flight window AND after the response is applied (`useSession.ts:144, :149`).

### Polling

`useSession.ts:180-215`:

- Cadence: `POLL_INTERVAL_MS = 2500`. Fast enough to feel live; slow enough for an async session with days between edits.
- Paused on `visibilitychange`. When the tab becomes visible, fire an immediate catch-up fetch so the user doesn't stare at stale state during the interval.
- Skipped when `latestRef.current.status !== 'active'` — the server won't mutate terminal rows from under us.
- Skipped when `mutationInFlightRef.current` is held (see above).

### Invariants harvested from tests

Tests don't just cover code paths — they pin behaviors the implementation alone doesn't make obvious. The ones worth internalizing:

- **`sessions-read.test.ts:116`** — A non-participant viewer GETting a known session id returns `404`, not `403`. This is the "session ids not probeable" invariant. If you change this to 403, an attacker can enumerate the code space to find valid sessions.
- **`sessions-read.test.ts:162-168`** — Cancelled sessions DO NOT appear in `/api/me/sessions`. The list endpoint filters `status = 'active'` unconditionally; historical sessions need a different (not-yet-built) endpoint.
- **`sessions-write.test.ts:83-95`** — Creating a second session between the same pair while the first is active returns the SAME id with `created: false`. The UI uses this to switch to "you already had a shared trade with @X" copy.
- **`sessions-write.test.ts:219-247`** — Cancelling a session unblocks creating a new one between the same pair (the partial unique index only applies to `active` rows). This is important for the "we cancelled because we changed our minds, let's start fresh" flow.
- **`sessions-write.test.ts:111-152`** — When A edits after B confirmed, B's confirmation is cleared. `confirmedByUserIds` returns to `[]` on every edit, regardless of who confirmed before.
- **`sessions-write.test.ts:249-270`** — A non-participant PUTting `/edit` returns `404`, not `403`. Same collapse as GET — no session-existence leakage.
- **`sessions-claim.test.ts:148-179`** — Anonymous claim actually mints a NEW ghost user row (not reusing any existing ghost) and sets the iron-session cookie. The DB has both rows afterward; the ghost is marked `isAnonymous = true, discordId = null`.
- **`sessions-claim.test.ts:209-230`** — Re-claiming as the same viewer is idempotent (200, not 201). The HTTP code is the only way to distinguish a fresh claim from an idempotent re-claim.
- **`sessions-claim.test.ts:232-262`** — A third party trying to claim after slot B is filled gets `409`, not `404`. UX needs to say "someone else already joined" rather than "this trade doesn't exist."
- **`sessions-invite.test.ts:273-319`** — Debounced re-invites within 10 min return `200` with no DM AND log an `invite-debounced` breadcrumb event. This makes the timeline answer "why didn't Alice get a second DM?" without needing to dig through bot logs.
- **`sessions-invite.test.ts:237-271`** — Ghost creators trying `/invite-handle` get `403`. The QR/share-link path on the same session still works for them.
- **`sessions-merge.test.ts:131-165`** — If the real user already has an active session with the same counterpart a ghost was trading with, the ghost row IS NOT deleted — we leave it alive so the blocked session isn't cascaded into oblivion. It TTLs out eventually. This is the "merge can be partial" invariant.
- **`session-lifecycle.auth.spec.ts:134-149`** — After `settled`, both `Confirm trade` AND `Cancel trade` buttons disappear from the DOM (not just disabled). Terminal state is total — no action bar, no edit affordance.
- **`session-live-trade.auth.spec.ts:33-46`** — `/s/<bogus>` must return 200 from Vercel (SPA boot) so `SessionView` can render the in-app "not found" message. A platform 404 here breaks the user-facing error UX.

### Counterpart-edit banner

`useSession.ts:221-237` + `SessionView.tsx:214`. On first successful fetch, `seenCounterpartEditAt = session.lastEditedAt` (treat initial load as "already seen" — banner shouldn't fire on page-load). On any later poll that returns `lastEditedByViewer === false && lastEditedAt > seenCounterpartEditAt`, `hasUnseenCounterpartEdit` flips true. The UI renders a cyan button that, on click, calls `markCounterpartSeen()` to advance the pointer. Viewer's own edits also advance it (see `saveCards` step 4) so a self-edit immediately after a counterpart edit doesn't leave a stale banner.

### Confirm and settle

`confirmSession` (`lib/sessions.ts:727`):

1. Not participant → `not-participant`. Terminal → `terminal`. Already in `confirmedByUserIds` → idempotent no-op (return current view).
2. Compute `counterpartAlreadyConfirmed`. If the session is open-slot, counterpart is null — confirm still succeeds but **can't settle** (nothing to settle with).
3. Append viewer to `confirmed_by_user_ids`. If both now present → `status = 'settled', settled_at = now`. Record `confirmed` + (if settling) `settled` events.
4. Return `{ settled: boolean }` so the client can render "You confirmed / Trade settled" copy.

Both parties must re-confirm from scratch after any edit (`editSessionSide` clears the array unconditionally, `lib/sessions.ts:686`). The `unconfirmed { cleared: N }` event records how many confirmations the edit invalidated — the future timeline UI uses this to surface "Alice edited, cleared your confirmation."

### Cancel

`cancelSession`: either participant can cancel at any point while `active`. Idempotent if already terminal (returns current view without re-recording an event). Cancel does NOT set `confirmed_by_user_ids` — settlement requires both parties to have confirmed AT THE TIME of the transition, not retroactively.

### Expiry

Rolling. Every edit + claim bumps `expires_at = now + 14 days` (`nextExpiresAt`, `SESSION_TTL_MS`, `lib/sessions.ts:436`). Rationale (from the source comment): proposals have a 30-day absolute TTL; sessions are expected to span days-to-weeks of async back-and-forth, and expiring mid-negotiation because life got in the way for a week would be painful. The TTL-enforcement cron isn't shipped yet — the `expired` status exists and the `trade_sessions_status_expires_idx` is in place for it.

### Ghost → real user merge

Happens in the OAuth callback (`api/auth.ts:291`) when a user hits `/api/auth/discord` while already carrying a ghost session cookie. `mergeGhostIntoRealUser` (`lib/sessions.ts:856`):

1. Select every `trade_sessions` row where the ghost is either slot.
2. Per session:
   - Open-slot (`user_b_id = null`, ghost was creator): rewrite slot A to real user, done.
   - Filled session: normalize `(realUser, otherParticipant)`, swap cards if the sort flipped, carry confirmation (ghost in `confirmed_by_user_ids` → real user in the new array), promote `last_edited_by_user_id` if it was the ghost.
   - If the UPDATE hits the pair-uniqueness index (real user already had an active session with this counterpart), log and leave the ghost row in place. The ghost session TTLs out eventually.
3. `UPDATE session_events SET actor_user_id = realUser WHERE actor_user_id = ghost` for cleaner audit history.
4. Only `DELETE FROM users WHERE id = ghost` if NO session still references the ghost — otherwise the cascade-delete FK would wipe those sessions. This is the "leave the ghost alive if migration was incomplete" branch; covered by `tests/api/sessions-merge.test.ts:131`.

Full OAuth merge flow lives in `g-auth.md`; this page only documents the session-row rewriting half.

### Promote proposal → session

`promoteProposalToSession` (`lib/sessions.ts:988`). Happens when the **recipient** of a pending proposal clicks "Edit together" in the proposal DM/view. The proposal-side wiring is in `b-proposals.md`; the session-side semantics:

1. Gate: must be the `recipientUserId` (proposers can't promote their own proposals — they already have `trades/counter`), proposal must be `pending`.
2. `findActiveSessionForPair` — if a session already exists for this pair, return `already-active-session` with the existing id so the caller redirects in rather than colliding on the partial unique index.
3. Insert the new session row: cards travel with the proposer vs recipient identity. `offeringCards` are the proposer's, `receivingCards` are the recipient's starting half (what the proposer wanted them to contribute; the recipient can edit freely). `lastEditedByUserId = viewerUserId` — the recipient just pressed Edit-Together; the debounce-DM job should target the PROPOSER next.
4. **Write ordering is deliberate**: session insert first, proposal transition second. If the session insert fails mid-flight the proposal stays `pending` (retry-friendly).
5. Proposal transition: `status = 'countered'` with `respondedAt = now`. We re-use `countered` rather than adding a `promoted` terminal status — a promoted proposal has been effectively replaced by the session, which is the same semantic as a counter-offer superseding the original.
6. **Orphan cleanup**: if the proposal UPDATE fails after the session was inserted, `DELETE FROM trade_sessions WHERE id = sessionId` and rethrow the original error. If the cleanup itself fails, log but surface the original transition error (debugging the primary failure matters more than the cleanup trace).
7. Event bookkeeping: `sessionEvents.created { promotedFromProposalId }` and `proposalEvents.countered { promotedToSessionId }` — cross-referenceable from both timelines.

### Invite by handle

`inviteHandleToSession` (`lib/sessions.ts:1150`), surfaced by `POST /api/sessions/:id/invite-handle`:

1. Session must be active AND `user_b_id === null` (both collapse to `not-open` reason — terminal and already-claimed are UX-equivalent "nothing to invite into").
2. Viewer must be the creator (slot A). Non-creators 403.
3. Normalize the handle (strip leading `@`, trim). Look up target user; 404 if unknown.
4. Self-invite → 400.
5. **Debounce**: scan `sessionEvents` for recent `notified` rows with `kind === 'invite'` targeting this handle or userId. Any hit within `SESSION_INVITE_DEBOUNCE_MS` (10 min) → idempotent success + `invite-debounced` breadcrumb, no DM. Rationale: stops repeat clicks from tripping Discord's DM-spam heuristics, explains the silence in the timeline.
6. No `discord_id` on target (ghost invitee) → `dm-failed`. Ghosts can't receive DMs; the inviter's QR/share-link path still works.
7. `DiscordBotClient.sendDirectMessage` with `buildSessionInviteMessage` body (link in embed description; see `i-discord-bot.md` for delivery). Any throw → `dm-failed`.
8. On success: `notified { kind: 'invite', targetHandle, targetUserId }` event.

Ghost creators are blocked at the API layer with `403` (`api/sessions.ts:470`) — they have no Discord identity to originate a DM from. The UI reflects this: `InviteByHandleForm` only renders for non-ghost creators (`SessionView.tsx:710`).

### Fetch-response dispatch in `SessionView`

When `useSession` reports a `status`, `SessionView` renders different branches (`SessionView.tsx:158-293`):

- `'loading'` + no cached session/preview → `<LoadingState label="Loading shared trade…" />`.
- `'error'` + no cached session → `<ErrorState>` with "Couldn't load this trade. Try refreshing." No automatic retry — the user refreshes the page or the poll eventually succeeds.
- `'not-found'` → `<ErrorState>` with "This shared trade doesn't exist or is no longer available. It may have been cancelled, expired, or already claimed by someone else." Note the copy is ambiguous on purpose — don't distinguish cancelled/expired/unknown-id, because they're all the same UX (dead-end).
- `'preview'` + preview data → `<InvitePrompt>` (scanner view with Join button).
- `'ready'` + session with `openSlot` → `<OpenSlotInvite>` (creator view with QR + URL + invite-by-handle).
- `'ready'` + session without `openSlot` → full canvas: identity strip → terminal-or-edit-banner → balance → two panels → action bar.

The branches are NOT mutually exclusive — `OpenSlotInvite` and `GhostSignInBanner` can both render above the main canvas at once (creator is a ghost with an unclaimed session, unusual but possible).

### The `NavigationContext.toSession` escape hatch

`src/contexts/NavigationContext.tsx:334-340` — navigating to a session uses `window.location.href` (full page load) rather than SPA pushState. The comment spells it out: "Session id lives in the pathname, not the querystring — full navigation so App remounts and SessionView reads the pathname cleanly. No intent state to mirror; sessions are server-authoritative." The tradeoff: session creation feels slightly slower (full boot, re-hydrate contexts) but the code path is simpler, there's no client-side cache we need to invalidate, and the user sees the loading state briefly (which is honest — the session IS loading).

## UI/UX patterns

### Post-Phase-5b layout (stage → confirm)

The `SessionView` canvas (`SessionView.tsx:204-293`) enforces the flow explicitly top-to-bottom:

1. **`SessionIdentityStrip`** — counterpart avatar + handle + lifecycle badge (`Shared · both editing` in cyan, `Settled` emerald, `Cancelled` / `Expired` neutral) + two `ConfirmBadge`s for each side's confirmation state. Never carries action buttons.
2. **`TerminalBanner`** OR **counterpart-edit banner** OR nothing — mutually exclusive, terminal takes priority.
3. **`TradeBalance`** — the shared balance strip (cyan accent; see `c-trade-builder.md`).
4. **Two-panel `TradeSide` grid** — left emerald (viewer's half, editable), right blue (counterpart's half, `readOnly`). Both panels render the same per-card price breakdown so the counterpart view isn't a second-class render. `readOnlyEmptyLabel` on the counterpart panel says "Waiting for @alice to add cards."
5. **`SessionActionBar`** — Confirm + Cancel. Only renders when `!terminal`. Confirm label is context-sensitive: `"Confirm trade"` / `"Waiting on @alice"` (if viewer already confirmed) / disabled when the canvas is empty.

The "action bar below the cards" placement is a deliberate invariant noted at `SessionView.tsx:38`: confirming a trade before either side has added cards makes no sense, so the flow reads top-to-bottom as "here's who you're trading with → here's the balance → build both halves → confirm."

### Terminal states

Any `status !== 'active'` triggers:

- `TerminalBanner` in place of the counterpart-edit nudge.
- Both `TradeSide` panels flip `readOnly` (`SessionView.tsx:249`, `:273`). Readonly hides Add Card / qty steppers / remove.
- `SessionActionBar` hides entirely — no button to "cancel a cancelled trade."

### Open-slot states

- **Creator view** (`SessionView.tsx:183`): `OpenSlotInvite` replaces the normal two-panel layout. Renders the QR (`qrcode.react` `<QRCodeSVG>` at 192px), the copyable share URL, the invite-by-handle form (if non-ghost), and a "Cancel this invitation" link. Balance / counterpart panel don't render — they'd be empty, and the creator is focused on getting someone to scan.
- **Non-participant scanner view** (`SessionView.tsx:168`): `InvitePrompt` — creator avatar, "You're invited to a trade / @alice / (guest)" badge if creator is a ghost, the card-count teaser copy, and a single Join button. Anonymous visitors see a "no account needed" hint.
- **Participant view**: normal canvas renders, with the `OpenSlotInvite` banner shown ABOVE if `session.openSlot` — the creator can still edit their half while waiting for a claim.

### Ghost sign-in nudge

`GhostSignInBanner` (`SessionView.tsx:556`) renders for ghost viewers on a non-open session (i.e. a claimed session). Gold accent (chrome, per the palette invariants). Clicking Sign in does a full navigation to `/api/auth/discord`; the OAuth callback's `mergeGhostIntoRealUser` rewrites session rows before redirecting to `/`. The in-banner copy deliberately names the merge guarantee: "Sign in to keep this trade and see it on Home later."

### Colors

Viewer side = emerald, counterpart side = blue (per the SWU palette invariants — emerald/blue are reserved for sides). Balance cyan. Terminal banners: emerald for settled, neutral gray for cancelled / expired. Identity-strip `Shared · both editing` badge is cyan to match the "live collaboration" theme. Gold is reserved for the ghost sign-in banner chrome.

### Mobile

Both panels collapse to a single column below `md` breakpoint (`SessionView.tsx:229`). `SessionActionBar` wraps on `<sm` with the copy above and buttons below. QR at 192px renders in a white-padded `<div>` so it stays scannable on dark-mode phones. Invite-by-handle form shares its input styling with the trade-builder handle picker.

## Tech debt + known gaps

- **No TTL expiry cron**. The `expired` status and `trade_sessions_status_expires_idx` are both in place but no `api/cron/*.ts` sweeps `WHERE status='active' AND expires_at < now()`. Active sessions accumulate until explicitly cancelled or completed. `lib/sessions.ts:431-440` spells the policy but the sweeper is unwritten.
- **`stubCard` fallback for unknown productIds** — `SessionView.tsx:824`. If a snapshot's `productId` isn't in the live `CardIndexContext` (stale snapshot, unreleased card, mid-card-data refresh), we synthesize a minimal `CardVariant` with `set: '?'` and `marketPrice = unitPrice`. Keeps the row from crashing the panel, but the price breakdown won't reconcile with current TCGPlayer data. A proper fix would refetch missing product ids; for now, the stub is correctness-adjacent but UX-compromised.
- **Empty-confirm guard is in the UI layer only** — `SessionActionBar` disables Confirm when `yourCards.length === 0 && theirCards.length === 0` (`SessionView.tsx:445`). The server would happily settle an empty-both session. This is fine because nothing in the flow leads to it, but the invariant isn't enforced at the API layer — a scripted client could bypass it.
- **`TradeSide` key parsing is fragile** — `SessionView.tsx:114, :120`. `handleRemove` / `handleChangeQty` decode the `key` prop by `key.split('-').slice(0, -1).join('-')`. This assumes the productId never contains a dash that gets mistaken for the `-set` suffix, AND that `tradeCardKey(card)` always includes the set slug. Any change to `tradeCardKey`'s format breaks session edits silently. A cleaner fix would be to invert the ownership — TradeSide should surface the productId directly in its callbacks rather than a composite key.
- **QR encodes the browser origin**, not the canonical `beta.swutrade.com` — `SessionView.tsx:658`. A creator on a Vercel preview deploy would QR out a preview URL the scanner can't auth past (SSO-wall on preview `/api/*` — see `project_swutrade_vercel_protection`). In production this is fine because the browser origin IS `beta.swutrade.com`.
- **No rate limit on `invite-handle`**. The 10-minute per-target debounce is enforced, but a motivated creator can cycle through handles. The API already has auth, creator-only gating, and per-target debounce; a global per-inviter cooldown would be a defensible addition if abuse surfaces.
- **`mergeGhostIntoRealUser` loops over sessions serially**. Fine in practice (ghosts rarely have more than a handful of sessions), but each iteration is its own UPDATE. No transactional guarantee across sessions — a partway-failed merge leaves inconsistent state until the next sign-in (the function re-runs cleanly because it's idempotent per session).
- **Polling cadence hardcoded** — `useSession.ts:106`. `POLL_INTERVAL_MS = 2500`. Should probably scale with `lastEditedAt` age (poll slower when the session has been idle for hours), or tune per-viewport visibility. Low priority until we have enough traffic for the extra requests to matter.
- **`session_events` has no pagination or query surface**. The table is write-only from the app's perspective; there's no timeline UI yet that reads it. When we build one, we'll want a `GET /api/sessions/:id/events` endpoint and an index on `(sessionId, createdAt DESC)` (already present) is sufficient for a reverse-chronological feed.
- **`last_notified_at` jsonb is unused**. The column exists for the planned debounce-DM job (ping the counterpart when the session's been edited and they haven't opened it in N minutes). No code currently writes to it beyond the `{}` default. Ship target is phase 4+ per `project_swutrade_mission`.
- **Cancel has no reason field**. A participant can cancel with no explanation. The `cancelled` event payload is empty. If we ever add "why was this cancelled" analytics, we'll need to extend the API + event payload.

## Decisions worth remembering

- **Session primitive is separate from proposals, not a proposal state**. Early sketches modeled "shared mode" as a proposal sub-state; the `trade_sessions` table exists because mutation cadence (both sides editing freely, confirmations clearing on each edit) fits badly on `trade_proposals`' ping-pong-immutable shape. Proposals are async one-shots with a single respondedAt; sessions are collaborative canvases with rolling edits. Different primitives, different tables. Promote-to-session bridges the two directions.
- **Canonical `user_a_id < user_b_id` over composite "pair key"**. Alternative was a synthesized `pair_key = sorted(a,b).join('|')` column for uniqueness. Chose the sort-on-insert approach because (a) lexicographic sort is cheap and readable, (b) a separate column would need its own synchronization invariant, (c) partial unique indexes are a native Postgres feature. `normalizeParticipants` is the single chokepoint.
- **Partial unique index over app-layer locking**. The "one active session per pair" guarantee is enforced in the DB via the partial unique index rather than by a Redis-style mutex or an app-layer check-then-insert. The `findActiveSessionForPair` lookup IS there (belt), but the index (suspenders) is what protects against races. Both `createOrGetActiveSession` and `claimOpenSlot` try/catch the index violation and re-lookup to fall back gracefully.
- **Open slot exempt from the unique index**. `WHERE status = 'active' AND user_b_id IS NOT NULL`. A user can host multiple concurrent open-slot invites (two tables at the same LGS, two different prospective trade partners walking up). The pair-uniqueness concept only makes sense once both slots are filled — trying to enforce it on open sessions would force a "close this invite before starting another" constraint that breaks the in-person flow.
- **Ambiguity-resistant 8-char code alphabet**. `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — drop `0/O/1/I` because session codes get read aloud at game stores ("your code is A-L-P-H-A-3-B-Q-R-Zero" is a failure mode). 32^8 keyspace; no retry logic for collisions because the probability is negligible.
- **Ghost users over "unauthenticated sessions"**. Alternative was a client-generated UUID as a session "guest token" not backed by a user row. Chose to mint real user rows with `is_anonymous = true` because (a) all session FKs point at `users(id)` — uniform referential integrity, (b) sign-in merge becomes "rewrite refs and delete the ghost row" instead of "translate a token namespace into a user id," (c) `confirmedByUserIds` / `lastEditedByUserId` work identically for ghosts and real users.
- **`notified` event reuses one enum value with payload discriminants**. Alternative was adding `invited`, `invited-debounced`, `change-ping` etc. as new enum values. Chose payload discriminants (`kind: 'invite' | 'invite-debounced'`) because each enum addition is a Postgres schema migration; payload shapes are free. Explicitly documented at `lib/sessions.ts:1143`.
- **Write ordering in promote-to-session: session first, proposal transition second, orphan cleanup on transition failure**. Alternative was a single transaction spanning both writes. The tradeoff: a transaction would avoid orphans but also would take longer to commit (and Vercel's serverless connection pooling isn't ideal for multi-statement transactions). Chose sequential writes with explicit orphan cleanup because the failure mode is rare and the cleanup is straightforward. Documented at `lib/sessions.ts:971-979`.
- **Creators seed BOTH halves on `ShareLiveTradeButton`**. Alternative was seeding only the creator's side, making the scanner build their own half from scratch. Chose to seed both because the mental model is "here's the trade I was thinking about" — dropping the counterpart-side work the creator just did in the calculator would be disrespectful of their effort. The scanner can edit their half freely post-claim.
- **Counterpart panel renders the full price breakdown, not a stripped readonly list**. Alternative was showing just names + quantities on the counterpart side. Chose the full breakdown because both sides need to see the per-card prices to evaluate the balance — asymmetry would make the counterpart's contribution feel like a black box.
- **14-day rolling TTL instead of absolute-from-creation**. Proposals are 30-day absolute; sessions are 14-day rolling. Chose rolling because sessions are active back-and-forth collaborations; ticking down a hard deadline while two people are negotiating is hostile. Short enough (14 days) that abandoned sessions do eventually expire — `project_swutrade_phase2` notes this was a deliberate choice to avoid infinite-lived session rows.

## Operational notes

### How to debug a "session disappeared" report

1. User gives you the session code (the 8-char string in the URL). Query `tradeSessions WHERE id = '<code>'` directly — if no row, the session was either never created or was cleaned up by an orphan-cleanup branch (`promoteProposalToSession` failure mid-flight, `lib/sessions.ts:1085`).
2. Check `session_events` for the session id ordered by `createdAt DESC`. The last event tells you the terminal transition (`cancelled`, `settled`, `expired`).
3. If the session exists but the user can't see it: check `user_a_id` / `user_b_id` against the user's id. If the user signed in via Discord recently, they might have been merged — check for their old ghost id in `session_events.actor_user_id` (merge rewrites these, but partially-failed merges leave breadcrumbs).
4. If the user is a ghost and complains sessions vanished: check if they recently signed in. The OAuth callback's `mergeGhostIntoRealUser` rewrites sessions to the real user; if they were looking for sessions under their ghost id, the sessions are now under their Discord user id.

### How to manually cancel/expire a session

Not recommended — use the UI. If absolutely necessary, direct DB update:

```sql
UPDATE trade_sessions
SET status = 'cancelled', settled_at = NOW(), updated_at = NOW()
WHERE id = '<CODE>';
```

No event row is written for manual updates; that's a debug feature, not a bug. If you need the audit trail, insert a `session_events` row manually with `actor_user_id = NULL` and a `{ manualAdmin: true }` payload.

### Cache semantics on the client

`useSession.cache` is module-scoped (`src/hooks/useSession.ts:92`) — survives component unmount/remount within the same SPA lifetime. A user navigating away from `/s/X` to Home and back will see the last-known session state immediately while the fresh fetch lands. This is deliberate — sessions are server-authoritative so stale-cache corrections are bounded (at most 2.5s until the next poll). The cache is cleared on SPA reload (module re-init). `__resetSessionCache()` is exported for tests only.

## Cross-references

- [`b-proposals.md`](./b-proposals.md) — the async proposal primitive sessions compete with. Documents the promote-to-session call site (proposal-side).
- [`g-auth.md`](./g-auth.md) — ghost user merge (OAuth callback), iron-session cookies, `requireSession` middleware, ghost-cookie setup during `create-open` + `claim`.
- [`c-trade-builder.md`](./c-trade-builder.md) — the builder's action strip that hosts `ShareLiveTradeButton`, the TradeSide component, TradeBalance.
- [`h-cards-pricing.md`](./h-cards-pricing.md) — `CardIndexContext` that `SessionView` uses to rehydrate `TradeCardSnapshot[]` into renderable `TradeCard[]`. `stubCard` fallback lives in this page's tech debt.
- [`i-discord-bot.md`](./i-discord-bot.md) — `DiscordBotClient.sendDirectMessage` delivery for `inviteHandleToSession` (invite-by-handle DMs).
- [`j-infra.md`](./j-infra.md) — Vercel function ceiling (why `api/sessions.ts` is a query-dispatch), `vercel.json` rewrites for `/s/:id` and `/api/sessions/*`, CI pipeline.
- [`e-home-nav.md`](./e-home-nav.md) — `toSession(id)` nav API, the "Active sessions" Home module that reads from `/api/me/sessions`.
