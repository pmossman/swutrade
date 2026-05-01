# Auth & identity audit — 2026-05-01

Scope: `api/auth.ts`, `lib/auth.ts`, ghost-merge subset of
`lib/sessions.ts`, `lib/guildSync.ts`, `api/me.ts`,
`src/contexts/AuthContext.tsx` + `src/hooks/useAuth.ts`, and the four
`tests/api/auth-*.test.ts` files.

## High-impact findings

### 1. Stale OAuth state + verifier cookies on every error path
- **What:** `swu_oauth_state` / `swu_oauth_verifier` are only cleared
  on `handleCallback`'s success branch. Every 400/502 (missing code,
  state mismatch, token exchange failure, users/@me 5xx) leaves both
  cookies for the full 600s `maxAge`.
- **Where:** `api/auth.ts:212-244` early returns vs `:344-350` clear.
- **Why it matters:** A failed sign-in's verifier cookie sitting next
  to a fresh state opens a small replay window if `state=` leaks via
  referrer/logs. Also dirties cookie-jar diagnostics.
- **Proposed fix:** Hoist clear-cookies into a helper called from
  every early-return, or reset at the top regardless of outcome.
- **Risk:** low. **Effort:** XS. **Confidence:** high.

### 2. `syncGuildMemberships` blocks OAuth redirect; sequential upserts inside
- **What:** `await syncGuildMemberships(...)` at `api/auth.ts:310`
  blocks the callback redirect on a Discord call plus N sequential
  DB upserts (`for (const g of guilds)` with awaited inserts at
  `lib/guildSync.ts:68-95`). Sign-in latency scales with guild count.
- **Why it matters:** The header at `lib/guildSync.ts:21` calls it
  "non-blocking" but it isn't — a 30-guild user pays a 2-3s tax on
  every sign-in. Errors already swallowed, so the await adds latency
  without safety.
- **Proposed fix:** Batch the upsert loop with `Promise.all`. Keep
  the await so the work lands before the worker exits — don't drop
  it; Vercel Fluid Compute doesn't guarantee dangling promises land.
- **Risk:** low. **Effort:** S. **Confidence:** medium-high.

### 3. Orphan ghost users accumulate on merge active-pair conflict
- **What:** `mergeGhostIntoRealUser` swallows per-session UPDATE
  errors at `lib/sessions.ts:1336-1347` (active-pair partial-unique
  collision). Comment says "ghost row stays, sessions fall out of TTL
  eventually" — but `users` has no TTL, only `trade_sessions.expiresAt`
  cascades. Once the conflicting session CASCADE-drops, the ghost user
  row remains forever with `is_anonymous=true`, zero references.
- **Where:** `lib/sessions.ts:1336-1372`.
- **Why it matters:** Slow leak of orphan rows that community queries
  scan past. Bounded by re-OAuth-with-conflict events, never GC'd.
- **Proposed fix:** Nightly cron sweep: `users WHERE is_anonymous AND
  id NOT IN (FK sources) AND created_at < NOW() - 30d`. Matches cron
  patterns; simpler than transactional delete-and-retry in the merge.
- **Risk:** low. **Effort:** S. **Confidence:** medium.

### 4. `handleLogout` accepts any HTTP method
- **What:** `handleLogout` (`api/auth.ts:115-118`) doesn't gate
  method. `<img src="/api/auth/logout">` from any origin clears the
  session. SameSite=Lax (`lib/auth.ts:39`) limits to top-level navs /
  form-POSTs but doesn't block. Compare `handleDismissMergeBanner`
  (`api/auth.ts:68-71`) which gates POST.
- **Why it matters:** Logout-CSRF is mostly griefing (recoverable)
  but the kind of footgun external security review flags.
- **Proposed fix:** Gate POST-only, return 405 otherwise.
  `useAuth.logout` already POSTs.
- **Risk:** low. **Effort:** XS. **Confidence:** high.

### 5. `SessionData` ↔ wire `User` shape drift, no shared type
- **What:** `lib/auth.ts:4-30` defines `SessionData` (`userId`).
  `src/hooks/useAuth.ts:4-13` defines `User` (`id`). Wire shape
  hand-mapped at `api/auth.ts:40-53`. Adding a field touches three
  places; `tests/api/auth-me.test.ts` (28 lines) doesn't pin shape.
- **Why it matters:** UX-A5 grew `pendingMergeBanner` across all
  three layers; the next field will too. One missed touch and the
  client silently drops it.
- **Proposed fix:** Define `MeResponse` in a shared module, import
  both sides. Server constructs via that type; `apiGet<MeResponse>`
  on the client.
- **Risk:** low. **Effort:** S. **Confidence:** medium.

## Lower-priority debt

- `getRedirectUri` (`api/auth.ts:133-138`) trusts `req.headers.host`;
  Vercel sets it, surface bounded by Discord's redirect-uri allowlist
  — worth a security comment.
- `auth-callback.test.ts:295-355` ghost-merge test asserts the
  trade_session migrated but not that the ghost user row was deleted.
- `auth-merge-banner.test.ts:79` TODO: cookie round-trip verification.
- `BOT_INSTALL_PERMISSIONS = '360777255952'` (`api/auth.ts:93`) is a
  hand-summed decimal string; switch to bit-OR computation so the
  comment-to-code link is auditable.
- `api/me.ts` is 1230 lines, 12 actions (`api/me.ts:35-65`); Hobby-
  cap bundling justifies one file but `handleCommunityMembers`
  (200+ LOC) could split into a sibling import.
- `handleCallback` opens iron-session twice (`getSession` + `createSession`).
- `useAuth.ts:121` `isSignedIn` derivation deserves a post-load flip comment.

## Anti-recommendations (don't re-flag)

- The 5-action dispatcher (`api/auth.ts:22-30`) is intentional —
  bundle pattern fits the 12-function Hobby cap; documented at
  `api/auth.ts:11-19`.
- `getRedirectUri` using `req.headers.host` rather than env is the
  fix for the beta-subdomain regression pinned in
  `auth-oauth.test.ts:23-28`. Don't revert.
- The HTML interstitial (`api/auth.ts:179-198`) is the iOS Safari
  cross-origin-redirect workaround. Don't simplify to `res.redirect(302)`.
- iron-session's "open and re-save" in `setPendingMergeBanner`
  (`lib/auth.ts:87-100`) looks redundant but is the documented way
  to mutate one slot — there's no in-memory session object to PATCH.
- `createSession` only setting `pendingMergeBanner` when truthy
  (`lib/auth.ts:77`) is intentional — re-OAuth without a fresh merge
  shouldn't null-overwrite a banner that's still pending dismissal.
- `syncGuildMemberships` swallowing Discord errors by default
  (`lib/guildSync.ts:32-44`) is correct — sign-in must not block on
  Discord availability. The `propagateDiscordErrors` opt-in is the
  explicit refresh-button path.
- Public-by-default for new users (`api/auth.ts:289-303`) is
  beta-feedback driven; don't revert.
- `auth-callback.test.ts:18-25` arctic mock is module-scoped so
  `auth-oauth.test.ts` keeps real arctic. Don't merge them.
