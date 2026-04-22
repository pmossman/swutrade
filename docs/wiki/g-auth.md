# Auth + identity (incl. ghost users)

> **Owner scope**:
> - `lib/auth.ts` — iron-session config, session read/write/destroy helpers, `requireSession` guard.
> - `api/auth.ts` — consolidated dispatcher for `/api/auth/{me,discord,callback,logout}`.
> - `lib/sessions.ts` — `createGhostUser` (the ghost USER primitive) and `mergeGhostIntoRealUser` (the migration called from the OAuth callback). The *session* primitive itself is owned by [`a-sessions.md`](./a-sessions.md); this page documents the auth/cookie/ghost-user angle of those same functions.
> - `lib/schema.ts` — the `users` table and its `isAnonymous` / nullable `discordId` / handle shape.
> - `src/hooks/useAuth.ts` — `useAuth()` hook, `isSignedIn` flag, `swu.signedInHint` localStorage cache.
> - `src/contexts/AuthContext.tsx` — provider wrapping `useAuth()` so the whole app reads one instance.
> - Tests: `tests/api/auth-me.test.ts`, `tests/api/auth-oauth.test.ts`, `tests/api/sessions-merge.test.ts`, `e2e/auth-flow.auth.spec.ts`.

## Overview

SWUTrade has two kinds of authenticated caller: **real users** (Discord OAuth → `users` row with a `discord_id`) and **ghost users** (anonymous participants minted on-demand when someone scans a session QR without signing in). Both speak the same iron-session cookie and are indistinguishable to most endpoints — they're a `users.id` behind `req.cookies.swu_session`. The *difference* is bounded: ghosts have `is_anonymous = true`, no `discord_id`, no community presence, and no preferences beyond the schema defaults. When a ghost later signs in, the OAuth callback migrates the ghost's sessions into the real account and deletes the ghost row.

One sentence: this area owns "who is the caller, and do they have a real Discord identity or a short-lived ghost one?"

## Key concepts / glossary

- **Ghost user** — a `users` row with `is_anonymous = true` and `discord_id = null`, minted by `createGhostUser()` (`lib/sessions.ts:79`) when an unauthenticated client touches a flow that requires a user id (today: `POST /api/sessions/create-open` and `POST /api/sessions/:id/claim`). The ghost is treated as authenticated for cookie purposes but excluded from every community / directory / rollup query (`WHERE is_anonymous = false`).
- **Guest handle** — the human-facing name of a ghost: `guest-<5-char-suffix>`, suffix drawn from `abcdefghjkmnpqrstuvwxyz23456789` (lowercase + digits, no confusables; `lib/sessions.ts:42`). Display username is `Guest <SUFFIX>` uppercased.
- **Iron-session** — sealed-cookie session library. One encrypted cookie (`swu_session`) carries the `SessionData` payload; no DB session table, no JWTs. See `lib/auth.ts:4` for the shape and `lib/auth.ts:24` for cookie options.
- **signedInHint** — a localStorage flag (`swu.signedInHint`) written after each confirmed sign-in. Used to pick the right view on first paint before `/api/auth/me` has round-tripped, eliminating the trade-builder-flash papercut (`src/hooks/useAuth.ts:41` + `:97`).
- **Ghost → real merge** — `mergeGhostIntoRealUser(db, ghostId, realUserId)` in `lib/sessions.ts:856`. Called from the OAuth callback (`api/auth.ts:289`) when a caller hits `/api/auth/callback` while already carrying a ghost session cookie. Rewrites `trade_sessions` + `session_events` references, then deletes the ghost if nothing else still points at it.
- **Bot install URL** — `/api/auth/me` returns a second field, `botInstallUrl`, built server-side by `buildBotInstallUrl()` (`api/auth.ts:73`). Kept off the client bundle so `DISCORD_CLIENT_ID` doesn't ship in Vite output and so permission-bit changes live in one place.
- **Auth guard** — `requireSession(req, res)` at `lib/auth.ts:101`. Returns `SessionData | null`; on null it has already written a 401 JSON body, so callers early-return. The softer `getSession()` returns null without writing a response — use that when a missing session is a valid state (e.g., `/api/auth/me`, open-slot session creation that mints a ghost).

## File map

### Backend

**`lib/auth.ts`** — Iron-session plumbing. Defines `SessionData` (cookie payload), four helpers (`getSession` / `createSession` / `destroySession` / `requireSession`) and one specialised reader (`getDiscordAccessToken`). Every protected API handler calls `requireSession` or `getSession` from here. No DB access.

**`api/auth.ts`** — Single dispatcher serving four external endpoints. `vercel.json` rewrites `/api/auth/me|discord|callback|logout` → `/api/auth?action=…` so we stay comfortably under the Hobby 12-function ceiling. Sub-handlers (`handleMe`, `handleDiscordStart`, `handleCallback`, `handleLogout`) are exported individually so vitest can invoke them without going through the dispatcher.

**`lib/sessions.ts`** (auth-relevant exports only; the rest is owned by [`a-sessions.md`](./a-sessions.md)):
- `createGhostUser(db)` at `:79` — ghost user primitive.
- `mergeGhostIntoRealUser(db, ghostId, realUserId)` at `:856` — ghost-to-real migration.
- Handle alphabet + suffix generator at `:42`–`:53`.

**`lib/schema.ts`** — The `users` table definition at `:18`. Owns the invariants: `discord_id` nullable + unique, `handle` unique + not null, `isAnonymous` boolean (default false, not null), prefs defaults. FK behaviour documented on each referencing table (`trade_sessions.user_a_id` and `user_b_id` are both `ON DELETE CASCADE`; `session_events.actor_user_id` is `ON DELETE SET NULL`). The cascade semantics are load-bearing — see the merge-ordering discussion below.

**`lib/guildSync.ts`** — Called from the OAuth callback with the fresh Discord access token. Reconciles `user_guild_memberships`. Relevant to *this* page only because it runs during sign-in; full docs live on [`f-community-profile.md`](./f-community-profile.md).

### Frontend

**`src/hooks/useAuth.ts`** — Owns the `User | null` state, the `isLoading` flag, the `swu.signedInHint` localStorage cache, and the `login` / `logout` imperatives. Fetches `/api/auth/me` once on mount. `isSignedIn = !!user || (isLoading && initialHint)` is the thing views should branch on for first-paint decisions.

**`src/contexts/AuthContext.tsx`** — A trivial provider so the app calls `useAuth()` exactly once at the `<AuthProvider>` boundary (`src/App.tsx`) and every descendant reads the same instance via `useAuthContext()`. Without this, every `useAuth()` caller would fetch `/api/auth/me` independently.

### Tests

**`tests/api/auth-me.test.ts`** — Minimal coverage for the `handleMe` handler (null session vs valid cookie).

**`tests/api/auth-oauth.test.ts`** — Tests for `getRedirectUri()` host resolution (the beta-subdomain regression lives in these assertions) plus `handleDiscordStart` contract tests: state + verifier cookies, interstitial HTML shape, Secure-flag presence on https vs absence on localhost.

**`tests/api/sessions-merge.test.ts`** — The three merge scenarios: happy-path ghost-into-real, ghost-on-an-open-slot session, and the pair-uniqueness conflict where the ghost row is *deliberately left alive* to avoid cascading-delete data loss.

**`e2e/auth-flow.auth.spec.ts`** — End-to-end sign-in via the Playwright auth helpers. Seeds a test user (`ensureTestUser`), installs the session cookie directly via `signIn(context, user)`, verifies the account menu shows the username, and exercises the sign-out flow. Note: file is `*.auth.spec.ts` so local `npm run e2e` *skips* it — it only runs in the authenticated job against the Vercel preview (see `j-infra.md`).

## Data model

### `users` table (`lib/schema.ts:18`)

| Column | Type | Invariants |
|---|---|---|
| `id` | text PK | For real users, equals their Discord user id. For ghosts, `gst-<5-char-suffix>` (`lib/sessions.ts:81`). |
| `discord_id` | text, **nullable**, unique-when-set | Null iff `isAnonymous = true`. Non-null iff the row was created via OAuth callback. |
| `username` | text, not null | Display name. Real users: `global_name ?? username` from Discord. Ghosts: `Guest <SUFFIX>`. |
| `handle` | text, not null, **unique** | URL-safe identifier. Real users: derived from `discordUser.username` lowercased + `[^a-z0-9_-]` stripped + truncated to 32 chars; if taken, `-<random4>` suffix appended (`api/auth.ts:250`). Ghosts: `guest-<5-char-suffix>`. |
| `avatar_url` | text, nullable | `https://cdn.discordapp.com/avatars/<id>/<hash>.png` for real users; null for ghosts. |
| `is_anonymous` | boolean, default false, not null | The one boolean every public listing filter on. |
| `profile_visibility` | enum `public` / `discord` / `private`, default `discord` | Gates profile discoverability. **Overridden on new-user insert to `public`** (`api/auth.ts:271`, 2026-04-17). |
| `wants_public` | boolean, default true | Whether wants list appears in community queries. |
| `available_public` | boolean, default false | Overridden on new-user insert to `true`. |
| `dm_trade_proposals` / `dm_match_alerts` / `dm_meetup_reminders` / `dm_server_new_install` | booleans | Per-channel DM consent. See [`f-community-profile.md`](./f-community-profile.md) for the three-axis consent model these feed into. |
| `auto_enroll_on_bot_install` | boolean, default false | If true, `guildSync` flips `enrolled` / `includeInRollups` / `appearInQueries` on *existing* memberships when the bot lands in that guild. Aggressive — default off. |
| `communication_pref` | enum, default `allow` | Trade-thread consent (`prefer` / `auto-accept` / `allow` / `dm-only`). Belongs to proposals lifecycle; see [`b-proposals.md`](./b-proposals.md). |
| `created_at` / `updated_at` | timestamptz | `updated_at` bumped on every Discord-profile refresh at callback. |

#### Ghost invariants

The three-way implication chain that every query and UI component can rely on:

```
is_anonymous = true  ⇒  discord_id IS NULL  ⇒  handle starts with "guest-"
```

- `is_anonymous = true` is set only by `createGhostUser` (`lib/sessions.ts:79`), which also writes `discord_id: null` and `handle: 'guest-<suffix>'`.
- `discord_id IS NULL` is written only by `createGhostUser` — the OAuth callback path always sets `discordId: discordUser.id` (`api/auth.ts:267`).
- The `guest-` prefix is enforced at insert time; the merge path deletes the ghost row rather than mutating it, so a `guest-*` handle never survives onto a real user.

The inverse is also true: `is_anonymous = false` users always have a non-null `discord_id` and never a `guest-` handle.

Every public listing (community directory, popular-wants feed, matchmaking) adds `WHERE is_anonymous = false` as a defensive filter. The primitive source is `getSessionForViewer` / `listActiveSessionsForViewer` in `lib/sessions.ts`, which propagate `isAnonymous` out to the viewer so the UI can render a `(guest)` badge on the counterpart label (`src/components/SessionView.tsx:610`).

### `SessionData` cookie payload (`lib/auth.ts:4`)

```
userId, username, handle, avatarUrl, isAnonymous?
discordAccessToken?, discordAccessTokenExpiresAt?   (real users only)
```

The cookie is sealed by iron-session (symmetric encryption with `SESSION_SECRET`), so the browser can't read or tamper with it. The TTL is 30 days (`lib/auth.ts:32`), scoped to path `/`, `httpOnly`, `SameSite=Lax`, `Secure` in production. The Discord access token is stored so Phase 4 flows (guild re-sync, "refresh servers") can hit Discord without forcing a re-OAuth; expiry is checked on read (`getDiscordAccessToken` returns `null` if expired rather than trying to refresh — callers degrade gracefully or prompt re-auth).

### OAuth state cookies

Two short-lived cookies scope one OAuth round-trip: `swu_oauth_state` (CSRF state token) and `swu_oauth_verifier` (PKCE code verifier). Both 10-minute TTL (`api/auth.ts:130`), `HttpOnly`, `Path=/`, `SameSite=Lax`, `Secure` on https. The callback validates `state` matches the cookie (`api/auth.ts:191`) before doing anything else. Both are zeroed at the end of the callback (`api/auth.ts:307`–`:312`).

### localStorage hint

Single key: `swu.signedInHint` (`src/hooks/useAuth.ts:41`). Value `'1'` or absent. Not a trust surface — it can't let anyone do anything; its only job is pre-seeding the view-router so a returning signed-in user doesn't see a one-frame flash of the anonymous trade builder before `/api/auth/me` resolves. Self-correcting: every `/api/auth/me` response overwrites it with the true answer.

## Public surface

### Exports — `lib/auth.ts`

- `getSession(req, res) → Promise<SessionData | null>` — read the cookie. Null if no session or no `userId`. Writes no response. Use this when a missing session is a valid state.
- `createSession(req, res, data) → Promise<void>` — seal a new cookie payload. Always overwrites; no partial updates. Callers: `handleCallback` (`api/auth.ts:297`), `handleCreateOpenSession` (`api/sessions.ts:323`), `handleClaimSession` (`api/sessions.ts:378`).
- `destroySession(req, res) → Promise<void>` — clear the cookie. Only caller: `handleLogout` (`api/auth.ts:87`).
- `requireSession(req, res) → Promise<SessionData | null>` — guard. On null, 401 JSON body is already written — early-return. This is the pattern every authenticated endpoint uses.
- `getDiscordAccessToken(req, res) → Promise<string | null>` — the stored Discord OAuth token if present and unexpired. Returns null on missing / expired — caller decides whether to serve stale data or re-auth.

### Exports — `lib/sessions.ts` (auth-side only)

- `createGhostUser(db) → Promise<GhostUser>` — mint a ghost `users` row. Returns `{ id, handle, username }`. Caller is responsible for installing the iron-session cookie after (pattern: `createGhostUser` → `createSession({ isAnonymous: true, ... })`).
- `mergeGhostIntoRealUser(db, ghostId, realUserId) → Promise<void>` — migrate references from the ghost to the real user. See the State + data flow section for the full choreography.

### Endpoints

- `GET /api/auth/me` (handled by `handleMe`, `api/auth.ts:34`) — returns `{ user: User | null, botInstallUrl: string | null }`. Always 200. No session → `user: null`. Authenticated → user shape includes `isAnonymous`. Never writes cookies.

- `GET /api/auth/discord` (handled by `handleDiscordStart`, `api/auth.ts:111`) — starts OAuth. Generates `state` + `codeVerifier`, writes them as cookies, and returns a **200 HTML interstitial** that redirects to `discord.com/oauth2/authorize`. Scopes requested: `identify` + `guilds` (`api/auth.ts:123`). The interstitial (not a 302) is an iOS Safari cross-origin-redirect workaround documented inline at `api/auth.ts:141`–`:150`: a bare 302 to a JS-heavy target can strand iOS users on a white screen until refresh; giving Safari a real HTML document to render first lets the browser commit to our response before navigating cross-origin.

- `GET /api/auth/callback` (handled by `handleCallback`, `api/auth.ts:181`) — OAuth completion. See the state + data flow section.

- `POST /api/auth/logout` (handled by `handleLogout`, `api/auth.ts:86`) — `destroySession` + `{ ok: true }`. Frontend additionally clears `swu.signedInHint` from localStorage (`useAuth`'s `logout`, `src/hooks/useAuth.ts:91`).

### Hooks / components

- `useAuth()` (`src/hooks/useAuth.ts:60`) — returns `{ user, isLoading, isSignedIn, botInstallUrl, login, logout }`. Owns the single `/api/auth/me` fetch at mount. `isSignedIn` is the view-routing flag — prefer it over `!!user` for first-paint branches.
- `<AuthProvider>` (`src/contexts/AuthContext.tsx:6`) — wraps `useAuth()` once near `<App>` root. Every descendant uses `useAuthContext()` to read the same state; calling `useAuth()` bare elsewhere would duplicate the `/api/auth/me` fetch.

## State + data flow

### Sign-in happy path

1. Client calls `auth.login()` (`src/hooks/useAuth.ts:87`) → `window.location.href = '/api/auth/discord'`.
2. Server handler `handleDiscordStart` generates fresh `state` + `codeVerifier`, writes them as two `HttpOnly` cookies scoped to the **request Host** (not a hardcoded production host — this was the `beta.swutrade.com` regression fixed at `api/auth.ts:94`–`:103`), and returns the HTML interstitial.
3. Browser navigates to `discord.com/oauth2/authorize?...&redirect_uri=https://<host>/api/auth/callback&state=<state>&...`.
4. Discord authenticates the user and redirects back to `/api/auth/callback?code=…&state=…`.
5. `handleCallback` validates the state cookie matches `state` (`api/auth.ts:191`). On mismatch, 400.
6. **Capture the ghost id before anything else**: `const priorSession = await getSession(req, res); const ghostIdToMerge = priorSession?.isAnonymous ? priorSession.userId : null;` (`api/auth.ts:236`). This read MUST happen before `createSession` overwrites the cookie — otherwise we'd lose the ghost id and the migration wouldn't fire.
7. Exchange the code for tokens via Arctic's `Discord` client. On failure, log the redirect URI and return 400 (the redirect URI logging was added after we chased a beta-vs-apex mismatch for a week).
8. Fetch `discord.com/api/users/@me` with the access token. On failure, 502.
9. Look up the user by `discord_id`. If found, **update** username + avatar + `updated_at`. If not found, **insert** a new row with:
   - `handle` derived from `discordUser.username` (`api/auth.ts:250`), with a random 4-char suffix appended on collision.
   - `profileVisibility: 'public'`, `wantsPublic: true`, `availablePublic: true` — the public-by-default commit from 2026-04-17 (`api/auth.ts:260`–`:274`). Beta feedback: private-by-default made every community feature feel walled and forced newcomers to hunt through Settings.
10. Call `syncGuildMemberships(discordUser.id, accessToken)` (`api/auth.ts:281`). This is where the auto-enroll behaviour fires: for each guild the user is in that's also in `bot_installed_guilds`, the `user_guild_memberships` insert flips `enrolled` / `includeInRollups` / `appearInQueries` all to `true` (`lib/guildSync.ts:70`–`:82`). Existing memberships preserve their consent flags (`onConflictDoUpdate` omits them from the SET clause, `lib/guildSync.ts:86`). Errors here are **swallowed** — OAuth shouldn't block on Discord's guilds endpoint being slow.
11. If `ghostIdToMerge` is set and not equal to the real user id, call `mergeGhostIntoRealUser(db, ghostIdToMerge, discordUser.id)` inside a try/catch (`api/auth.ts:289`). Errors are logged but never surfaced — worst case, the ghost's sessions stay under the ghost id until TTL expires, which degrades gracefully.
12. `createSession` seals the new cookie with the real user's data + the Discord access token + expiry.
13. Clear the OAuth state + verifier cookies (`api/auth.ts:307`).
14. 302 to `/`.
15. Frontend: the new page load triggers `useAuth`'s `/api/auth/me` fetch, sees `user` populated, writes `swu.signedInHint=1`. Subsequent loads on this browser short-circuit the flash.

### Ghost creation (two call sites)

Ghosts are minted *only* by two endpoints; no other path creates them.

**`POST /api/sessions/create-open`** (`api/sessions.ts:300`). A signed-in caller gets their own `userId` as the session creator. An anonymous caller triggers `createGhostUser(db)` followed by `createAuthSession(req, res, { ..., isAnonymous: true })` (`api/sessions.ts:322`–`:329`). The new ghost is now the creator of the open-slot session and the browser is "signed in as guest" for the cookie's 30-day TTL. Response body includes the `ghost` object so the client can show "you're joined as Guest XYZ."

**`POST /api/sessions/:id/claim`** (`api/sessions.ts:359`). Someone scans a QR or follows the invite URL; if they're already signed in, their `userId` becomes slot B. If they're anonymous, a ghost is minted identically to `create-open` (`api/sessions.ts:377`–`:386`). Either way, `claimOpenSlot` is called with that `viewerUserId`.

Neither path is idempotent for ghost minting: two consecutive anonymous hits to `create-open` on a fresh browser produce two different ghosts. The iron-session cookie makes this a no-op for the same browser session.

### `mergeGhostIntoRealUser` choreography (`lib/sessions.ts:856`)

The callback captures `priorSession` *before* `createSession` overwrites the cookie. The ordering matters because:

- `getSession` reads the sealed cookie currently on the request.
- `createSession` replaces it in the response. After that point, the old ghost id is only in memory — if we hadn't captured it first, we'd lose the migration signal entirely.

The merge itself, per-session:

1. Load every `trade_sessions` row where `user_a_id = ghostId OR user_b_id = ghostId`.
2. For each row:
   - **Open-slot case** (`user_b_id IS NULL` + ghost was in slot A): simply rewrite `user_a_id` to the real user. No pair conflict possible.
   - **Pair case**: compute `normalizeParticipants(realUserId, otherUserId)` to re-establish the canonical `user_a_id < user_b_id` ordering. The cards travel with whoever *owned* them (not with the slot position), so we swap `user_a_cards` / `user_b_cards` if the normalisation flipped which slot the real user ends up in (`lib/sessions.ts:886`–`:899`).
   - Carry the ghost's confirmation forward: if `confirmedByUserIds` contained `ghostId`, replace it with `realUserId`.
   - If `lastEditedByUserId` was the ghost, promote it to the real user so the debounce-DM job targets the right counterpart.
3. **Pair-uniqueness conflict handling**: the `trade_sessions_active_pair_idx` partial unique index (`lib/schema.ts:564`) rejects an UPDATE that would produce a duplicate active pair. If the real user already had an active session with the same counterpart a ghost session was tied to, the UPDATE throws. We **swallow the error and leave the ghost row alive** (`lib/sessions.ts:907`–`:918`). That's deliberate — deleting the ghost now would cascade-delete the still-referenced session (both session FKs are `ON DELETE CASCADE`), which would destroy actual trade state. The conflicting session degrades invisibly: the user won't see it under the real account, but it lives under the ghost id until TTL expires (14 days of inactivity, `SESSION_TTL_MS` at `lib/sessions.ts:436`).
4. Rewrite `session_events.actor_user_id` from ghost → real (`lib/sessions.ts:925`). `session_events.actor_user_id` is `ON DELETE SET NULL` (`lib/schema.ts:614`), so even if we skipped this step, deleting the ghost wouldn't wipe the audit log — but we rewrite anyway so the audit history stays attributable to the real user.
5. Conditional ghost delete (`lib/sessions.ts:933`): re-query whether any session still references the ghost. If *nothing* does, delete the ghost row. If a conflict-blocked session still points at the ghost, leave the row. This is the cascade-delete guard — without it, the conflict-case ghost would take its blocked session down with it.

The test at `tests/api/sessions-merge.test.ts:131` exercises the conflict path end-to-end: creates a real Bob↔Alice session, creates a ghost↔Alice session, calls merge, and asserts the ghost row *survives* and the conflicting session still references the ghost.

### Auth-guard pattern across `api/*`

Every protected handler opens with either:

```ts
const session = await requireSession(req, res);
if (!session) return;              // 401 already written
```

or the softer:

```ts
const session = await getSession(req, res);
if (!session) { ... handle anon path ... }
```

The pattern sweep: `api/trades.ts`, `api/me.ts`, `api/sync.ts`, `api/popular-wants.ts` use `requireSession` (hard 401). `api/sessions.ts` and `api/auth.ts` use `getSession` because both have legitimate anonymous paths (ghost minting, `/api/auth/me` returning `{ user: null }`).

#### 401 vs 403 on the client

`src/services/apiClient.ts` maps HTTP status to a `reason` discriminator (`apiClient.ts:26`–`:34`):

- `401` → `reason: 'unauthorized'` — "you aren't signed in."
- `403` → `reason: 'forbidden'` — "you're signed in but not allowed to do *this*" (e.g., non-participant on a session).
- `404` → `reason: 'not-found'` — also used when an endpoint deliberately conflates not-found with wrong-viewer so session ids aren't probeable (e.g., `getSessionForViewer` returns null for both cases, `lib/sessions.ts:171`).
- `409` → `reason: 'already-resolved'` — state races.
- `429` → `reason: 'rate-limited'` with a `nextAvailableAt`.

The UI branches on `reason`, never on status. `unauthorized` typically triggers a sign-in prompt; `forbidden` triggers an error state; both are distinguishable without parsing messages.

### `useAuth` first-paint flicker fix

The problem: `AuthProvider` mounts, immediately fetches `/api/auth/me`, and for ~50–300ms `user` is null + `isLoading` is true. Any component rendering `!!user ? <SignedInView /> : <AnonymousView />` shows the anonymous view for that window, then snaps to the signed-in view. On the Home route this meant signed-in users saw a one-frame flash of the trade builder before their dashboard appeared.

The fix (`src/hooks/useAuth.ts:41`, `:67`, `:97`):

1. After every successful sign-in, write `localStorage.setItem('swu.signedInHint', '1')`. Write `'0'`-equivalent (remove key) on logout or confirmed-not-signed-in responses.
2. On mount, read the hint synchronously into `useState` (`:67`). Cannot fetch — fetch is async.
3. Return `isSignedIn = !!user || (isLoading && initialHint)`. Once loading flips false, `!!user` takes over and the hint no longer matters.

The hint is intentionally weak:

- **Not a trust surface.** It can't let anyone do anything — the server gates every actual call. If an attacker crafts `swu.signedInHint=1` they'll just see the signed-in view pretend to load for a moment before `/api/auth/me` tells the truth.
- **Self-correcting.** Every `/api/auth/me` response overwrites it with the real answer. A stale hint (e.g., server-side session expired since last visit) causes one wrong-view frame, then corrects.
- **Safari private-mode safe.** `readHint` / `writeHint` both try/catch around localStorage — storage disabled returns `false` / silently skips, not an exception.

### Sign-out

`auth.logout()` in `useAuth` (`src/hooks/useAuth.ts:91`) does two things: `POST /api/auth/logout` (which calls `destroySession`) and `writeHint(false)`. No redirect — the component tree re-renders with `user: null` and routes to the anonymous view. `e2e/auth-flow.auth.spec.ts` exercises this path to ensure the account-menu sign-out button doesn't leave stale UI.

## UI/UX patterns

- **Two-state user model (2026-04-22)** — from the user's POV, SWUTrade has exactly two states: `guest` (signed-out OR ghost — same chrome in both) and `Discord-signed-in`. Ghost is an internal server concept (a cookie carrying session membership) that no longer leaks into UI. `AccountMenu` shows the "Sign in with Discord" menu whenever `!user || user.isAnonymous`. `NavMenu` splits gating into `hasAccount` (real user — gates "My Communities") + `hasAnySession` (real or ghost — gates "My Trades" so ghosts can still reach their in-flight sessions). Routing's `home` rule narrows to real-signed-in, so ghost `?view=home` falls through to the trade builder. The separate `GhostHomeView` surface was deleted.
- **`GhostSignInBanner`** (`src/components/SessionView.tsx`) — inside a `SessionView` rendered to a ghost, a gold banner nudges sign-in with the promise "sign in and this trade follows you." Full UX content is documented in [`a-sessions.md`](./a-sessions.md). Not part of the collapsed two-state chrome — this one is scoped to the session canvas specifically because the pitch is load-bearing there ("this trade will follow you").
- **`(guest)` counterpart badge** — when a viewer's counterpart is a ghost, the counterpart label in `SessionView` renders `(guest)` next to the username. This IS a deliberate ghost-status leak because it conveys "this counterpart won't survive closing their browser" — actionable information for the viewer.

## Tech debt + known gaps

- **UX-A5 — Ghost → real merge reassurance banner (queued)**. Current merge is *silent*: the user signs in and their ghost's in-progress session just appears under the real account. Silent success in ownership transitions is anxiety-inducing — users wonder whether they lost their work. `NEXT.md:144`–`:148` specifies the fix: a one-shot dismissible gold banner on the first post-merge load that says "We carried your trade with @alice over. View it." The mechanism isn't specified yet — candidates include a `user.pendingMergeBannerSessionIds` column or a transient cookie written by `mergeGhostIntoRealUser`. Unimplemented.

- **Conflict-blocked ghost sessions linger until TTL**. When the pair-uniqueness index rejects a merge UPDATE, the ghost row *and* the conflicting session stay alive (`lib/sessions.ts:907`). The session is invisible to the real user (their client queries filter on their id) and invisible to the counterpart (they see the other, non-conflicting session). Both age out naturally at 14 days. There's no explicit cleanup or error surfaced to the user — an argument could be made for surfacing "we couldn't merge one of your guest sessions because you already had an active trade with @alice; here's the link to view it." Queued under UX considerations but not in NEXT.

- **No ghost garbage collection.** There is no cron that sweeps orphaned ghost rows. A ghost row is deleted in exactly one circumstance: successful merge in `mergeGhostIntoRealUser` (`lib/sessions.ts:942`). A ghost who creates an open session and never signs in, or whose session gets cancelled / settled / expires, leaves a ghost row behind. The rows are cheap (text columns, no relations once the session is gone) but they accumulate monotonically. Low-urgency debt; not currently in NEXT.md. If/when we add it, the cron can safely `DELETE FROM users WHERE is_anonymous = true AND NOT EXISTS (SELECT 1 FROM trade_sessions WHERE user_a_id = users.id OR user_b_id = users.id)`.

- **No iron-session password rotation policy.** `SESSION_SECRET` is a single env var (`lib/auth.ts:26`). Rotating it invalidates every existing cookie instantly — no dual-secret rollover. Low-stakes (cookies are 30-day TTL; worst case is everyone re-signs-in), but worth mentioning if we ever need to force a logout for incident response. Iron-session supports multi-password configs; we don't use them.

- **Discord access token expiry = re-OAuth.** `getDiscordAccessToken` returns null on expiry (`lib/auth.ts:84`). There's no refresh-token flow. Tokens default to 7-day TTL; after that, anything needing Discord on the user's behalf (e.g., "Refresh servers" in Settings) prompts re-auth. Cheap to fix but not yet prioritised — the only consumer today is the manual guild refresh button.

- **Handle collision retry is non-deterministic.** New-user handle insert uses `${handle}-${Math.random().toString(36).slice(2, 6)}` on collision (`api/auth.ts:257`). If the suffix collides too, the `users.handle` unique constraint throws and the OAuth callback 500s. Extremely unlikely at current scale (4^36 suffixes), but the "correct" fix is a retry loop. Debt, not bug.

- **Ghost handle collision is unretried entirely.** `createGhostUser` generates a 5-char suffix from a 31-char alphabet (`~28M` possibilities, `lib/sessions.ts:50`) and inserts without a retry. A collision throws and the caller of `createGhostUser` (today, only `handleCreateOpenSession` and `handleClaimSession`) 500s. At realistic volumes this is theoretical; noting it so future volume doesn't surprise us.

- **`signedInHint` has no expiry**. If a user last signed in six months ago and the session cookie has since expired, the hint still pre-seeds "signed in" until `/api/auth/me` corrects. The wrong-view frame is cheap but visible. We could age-stamp the hint and treat anything >30 days as false.

- **`getSession` is re-entrant on every request.** Each `requireSession` call re-seals the cookie (iron-session's design). Endpoints that call `getSession` multiple times in one request will pay that cost repeatedly. No caller does today; flag for future refactors.

- **No `@ts-expect-error` in auth files.** Checked `lib/auth.ts`, `api/auth.ts`, and the auth surfaces of `lib/sessions.ts` — zero suppressions, zero `TODO`s. The only inline caveats are the documented ones (callback ghost-merge try/catch, ordering note on `priorSession` capture).

- **`handleMe` returns `botInstallUrl` even when signed out.** This is load-bearing: the signed-out anonymous Home view renders an "Install the bot" CTA, and it needs the URL. Flagged here because on a cold read it looks like an oversight.

## Decisions worth remembering

- **Ghost users as real `users` rows, not a separate "guest tokens" namespace.** Alternative: a client-generated UUID treated as a pseudo-session-id, with anonymous-only tables referencing it. Chose real `users` rows with `is_anonymous=true` because (a) every FK already points at `users(id)`, so referential integrity is uniform, (b) the sign-in merge becomes "rewrite refs and delete one row" instead of "translate between two id namespaces," (c) the session cookie shape is identical for real vs ghost users, which means every endpoint's auth check just works — no second code path. The cost is that ghosts live in the same table as real users and every public listing must remember to filter `is_anonymous = false`. Worth it.

- **Iron-session (sealed cookies) over JWT or a server-side session table.** No DB session table means no session revocation story for the ghost-merge case — but we don't need one because the merge *overwrites* the cookie rather than invalidating it. JWT was rejected because we want to be able to carry structured per-session state (the Discord access token + expiry) without exposing it to the client; an encrypted cookie does that; a JWT would either leak it in the payload or require a server-side lookup anyway. Iron-session is the minimal thing that works.

- **`getSession` captured BEFORE `createSession` in the callback.** Documented inline at `api/auth.ts:231`–`:237`. The alternative ordering — `createSession` first, then try to read the prior cookie — loses the ghost id because the response cookie has already been rewritten. This is the kind of ordering that looks arbitrary in code review; it's load-bearing.

- **Non-blocking `syncGuildMemberships` on callback.** Errors are logged and swallowed (`api/auth.ts:281`, `lib/guildSync.ts:36`–`:43`). Discord's guilds endpoint is the least reliable of the three we hit during OAuth; coupling sign-in completion to its availability would leave users stuck on "authenticating…" every time Discord sneezes. Guild list can re-sync on next visit.

- **Non-blocking `mergeGhostIntoRealUser` on callback.** Errors are logged and swallowed (`api/auth.ts:289`–`:295`). If the merge fails outright, the user signs in successfully and their ghost's sessions stay under the ghost id until TTL. Ugly fallback, but strictly better than failing the whole sign-in for a data-migration hiccup.

- **Public-by-default for new users, private-default preserved for existing.** The 2026-04-17 commit (`api/auth.ts:260`–`:274`) flipped `profileVisibility` / `availablePublic` for *new* inserts. Existing users are not migrated — their explicit settings stand. Rationale: beta feedback was specifically about new-user onboarding friction, not about existing users secretly wanting to be public.

- **`identify` + `guilds` scopes, no `email`.** We don't need email; avoiding the scope means we never have to explain "why do you want my email?" at the Discord consent screen. `guilds` is there for Phase 4 — `handleCallback` uses the access token to hit `GET /users/@me/guilds` and populate `user_guild_memberships` (`api/auth.ts:281`, detail in [`f-community-profile.md`](./f-community-profile.md)).

- **Bot install permissions assembled server-side.** `BOT_INSTALL_PERMISSIONS = '360777255952'` sums six bits (`api/auth.ts:52`–`:64`). Keeping the constant server-side means changing permissions is a one-line edit that ships with a deploy rather than a bundle rebuild; it also keeps `DISCORD_CLIENT_ID` out of the Vite bundle.

- **Interstitial HTML instead of 302 for `/api/auth/discord`.** iOS Safari cross-origin-redirect race (`api/auth.ts:141`–`:150`). Tests lock in the interstitial's existence (`tests/api/auth-oauth.test.ts:96`–`:105`).

- **`getRedirectUri` uses the request Host, not a fixed env var.** Regression fix: previously pinned to `VERCEL_PROJECT_PRODUCTION_URL` (= `swutrade.com`), which broke OAuth on `beta.swutrade.com` because state cookies are subdomain-scoped (`api/auth.ts:94`–`:103`, regression asserted at `tests/api/auth-oauth.test.ts:22`–`:28`). Every host that can initiate sign-in must also be registered in Discord's OAuth2 Redirects list.

## Cross-references

- [`a-sessions.md`](./a-sessions.md) — the session primitive itself: `createOpenSession`, `claimOpenSlot`, `createOrGetActiveSession`, the `trade_sessions_active_pair_idx` partial unique index. This page owns how the auth/cookie/ghost angles plug into those flows.
- [`e-home-nav.md`](./e-home-nav.md) — view-router's home-vs-trade fallback; the two-state user collapse that routes ghosts to the trade builder.
- [`f-community-profile.md`](./f-community-profile.md) — profile visibility / three-axis consent / guild-membership consent flags. Sign-in initialises all of these; this page documents the init, that page documents the lifecycle.
- [`b-proposals.md`](./b-proposals.md) — `communication_pref` (trade-thread consent) lives on `users` but belongs to the proposals lifecycle.
- [`i-discord-bot.md`](./i-discord-bot.md) — bot-side signature verification for interaction webhooks (distinct from human OAuth). Shares zero code with this page.
- [`j-infra.md`](./j-infra.md) — why `/api/auth/*` is four rewrites into one file (function ceiling), why `*.auth.spec.ts` is excluded from local e2e.
