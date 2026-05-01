# Discord OAuth e2e — setup runbook

**Status:** deferred. The autonomous run wrote this doc but did NOT
execute any of these steps. Phase E (real Discord OAuth specs)
requires decisions and account creation only parker can do; the
specs themselves are intentionally not written until the prereqs
exist.

This document is the playbook for getting two real Discord-OAuth
e2e specs into the nightly job.

## Why we don't have these yet

Most signed-in flows are already covered via `e2e/helpers/auth.ts`'s
`signIn()`, which seals an iron-session cookie directly. That's good
enough for **everything except the OAuth callback path itself** —
the bytes that flow through Discord's redirect, the post-callback
session merge from a ghost cookie, and any handle/avatar resolution
that depends on the real Discord API.

Two specs cover that gap:
- `auth-discord-flow.auth.spec.ts` — full OAuth dance through the
  callback URL, asserts session is established + correct row inserted.
- `auth-ghost-merge.auth.spec.ts` — ghost user with active sessions
  signs in via Discord; asserts those sessions follow the user
  (claimed by the new userId) and the ghost row is migrated/dropped.

These are the only specs that should hit real Discord. Everything
else stays on the `signIn()` bypass.

## Prerequisites — what parker has to do

### 1. Create a dedicated test Discord application

Don't reuse the production app. Test runs need their own:

- App name: `swutrade-e2e-test` (or similar — never confuse with prod).
- Redirect URI: the Vercel preview's `/api/auth/callback` for the
  beta branch (e.g. `https://swu-trade-balancer-beta.vercel.app/api/
  auth/callback`).
- OAuth scopes: `identify` only (no email, no guilds — match prod's
  minimum).

Save the client ID + secret. They go into CI as `DISCORD_TEST_CLIENT_ID`
and `DISCORD_TEST_CLIENT_SECRET`.

### 2. Create two test Discord accounts

These are real Discord users that exist solely for our specs.
Recommended:

- `swu-test-a@<dummy-domain>` with display name `SWU Test A`
- `swu-test-b@<dummy-domain>` with display name `SWU Test B`

You'll need real email addresses (or aliases) Discord can verify.
A privacy-aware mail provider with subaddressing works well.

**Do not enable 2FA** on these accounts. The OAuth flow can't pass
through a 2FA prompt headlessly. (If Discord later starts forcing
2FA on new accounts, see the "if 2FA is forced" note below.)

### 3. Generate stored auth state for each test user

The OAuth dance is human-in-the-loop only the first time. Afterwards
we replay a Playwright **storage state** (cookies + localStorage)
that already represents a logged-in Discord session.

Plan:

```
scripts/refresh-test-auth-state.ts
```

This script:
1. Spawns Playwright with `headed: true` for first-time setup.
2. Navigates to discord.com/login.
3. Pauses for human credential entry (`page.pause()`).
4. Saves the post-login storage state to a local file.
5. Encrypts the state file with a passphrase (sodium / age / etc.).
6. Uploads the encrypted blob to a CI-accessible secret store
   (GitHub Actions encrypted artifact, or a dedicated secret).

Run this script once locally per test account. Output:
`auth-state-test-a.json.enc` and `auth-state-test-b.json.enc`.

Cadence: re-run **weekly** — Discord login tokens have soft TTLs
and OAuth refresh tokens get rotated. Set a calendar reminder. The
nightly job should fail loudly (not silently) if the storage state
is too stale.

### 4. Wire CI secrets

Add to GitHub Actions repo secrets:

- `DISCORD_TEST_CLIENT_ID`
- `DISCORD_TEST_CLIENT_SECRET`
- `DISCORD_TEST_AUTH_STATE_A_B64` — base64 of the encrypted
  storage-state blob for test-a.
- `DISCORD_TEST_AUTH_STATE_B_B64` — same for test-b.
- `DISCORD_TEST_AUTH_STATE_PASSPHRASE` — decryption passphrase.

Then add a Vercel preview-env override that points the OAuth flow
at the test client during nightly runs. Cleanest: a separate beta
deploy that uses the test client by default — never let test
credentials leak into the user-facing beta or prod.

### 5. Add the nightly workflow

`.github/workflows/nightly-e2e.yml`:

- Schedule: cron `0 6 * * *` (06:00 UTC = 23:00 PT).
- Steps mirror `ci.yml` for build/deploy, but the auth-e2e step:
  - Decrypts the storage states from the secrets.
  - Sets `PLAYWRIGHT_STORAGE_STATE_A` / `_B` env vars pointing at
    the decrypted JSON files.
  - Runs `npm run e2e:auth -- --grep '@nightly'`.
- On failure: post to a dedicated `#e2e-nightly` Discord channel
  (separate from the existing `#releases` channel — these flakes
  don't gate human merges).

Tag the OAuth specs:

```ts
test.describe('Discord OAuth callback', () => {
  test.describe.configure({ tag: '@nightly' });
  // ...
});
```

`@nightly` makes them invisible to the per-PR CI run via the
existing `--grep-invert '@nightly'` filter (add this to `e2e:auth`'s
default args). They run only when the nightly job explicitly
selects them.

## Spec sketches (write after prereqs exist)

### auth-discord-flow.auth.spec.ts

```ts
test('OAuth callback establishes a session for a previously-unknown user', async ({ browser }) => {
  // Start with NO swu_session cookie.
  const ctx = await browser.newContext({
    storageState: process.env.PLAYWRIGHT_STORAGE_STATE_A!,
  });
  const page = await ctx.newPage();
  // Initiate OAuth: full nav to /api/auth/discord (mirrors the
  // GhostSignInBanner button).
  await page.goto('/api/auth/discord');
  // Discord redirects through consent (already granted) →
  // /api/auth/callback?code=... → / .
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  // Auth chrome shows the test user's username.
  await expect(page.getByText(/SWU Test A/i)).toBeVisible();
  // Database row exists with discordId === <expected>.
  // (Direct Drizzle query; cleanup at end.)
});
```

### auth-ghost-merge.auth.spec.ts

```ts
test('ghost with active sessions signs in → sessions migrate to the new userId', async ({ browser }) => {
  // 1. Create a session as a ghost (no signedInAs).
  const ghost = await openSessionParticipant(browser);
  await ghost.page.getByRole('button', { name: /Invite someone/i }).click();
  const sessionUrl = ghost.page.url();
  // 2. The ghost cookie's userId is the soon-to-be-merged identity.
  //    Capture from /api/auth/me or the cookie payload.
  // 3. Initiate OAuth with the storage state for test-a layered on
  //    top of the ghost's swu_session cookie.
  //    (This is the "sign in mid-session" flow — handleAuthCallback
  //    detects an existing ghost cookie and re-keys the session.)
  // 4. Post-callback: the session at /s/<id> still loads, now
  //    attributed to test-a's userId. The ghost row should be
  //    deleted.
});
```

## Maintenance discipline

- **Treat the nightly as informational.** A failing nightly is a
  signal, not a gate. Don't let nightly flake block PRs.
- **Refresh storage state weekly** (calendar reminder). Stale state
  manifests as "Discord login page rendered, expected /api/auth/
  callback redirect" — easy to spot.
- **Rotate the test passphrase quarterly.** Update both the local
  encrypted blob and the GitHub Actions secret.
- **If a real Discord change breaks the flow**, mark the affected
  spec `test.fixme()` rather than disabling the whole nightly.
  Investigate next morning.

## If 2FA is forced

Discord may eventually require 2FA on all accounts. Two options:

1. **TOTP via Playwright** — use `otplib` to derive the current
   2FA code from the test account's seed and submit it during
   storage-state refresh. Doable but adds a moving part.
2. **Switch to a token-based test fixture** — use Discord's bot
   token API for the test app to mint pre-authenticated tokens.
   Bypasses the user-facing OAuth flow but loses some realism.

Pick option 1 if you want to keep testing the human-facing OAuth
chain. Pick option 2 if 2FA enforcement makes option 1 brittle.

## When NOT to expand this

If a regression happens that the existing `signIn()`-based specs
don't catch, prefer fixing it via:

- A unit test against `handleAuthCallback` in `tests/api/auth-*.test.ts`.
- An additional `signIn()`-flavored e2e spec that exercises the
  user-visible side of the bug.

Only fall back to real-OAuth specs when the bug requires the
end-to-end network round-trip through discord.com to surface.

---

Last updated: 2026-05-01 (initial draft, no code yet).
