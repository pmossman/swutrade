# `api/` — orientation

Serverless HTTP handlers. Each `.ts` file becomes one Vercel function at deploy time.

## Invariants

### Function ceiling is real and silent

The Hobby plan caps deployments at **12 serverless functions**. When we exceed it, Vercel fails the build at "Deploying outputs…" with no useful error in the UI — just a generic deploy failure. That's why several surfaces are **consolidated** behind one file:

- `api/me.ts` handles `/api/me/settings`, `/api/me/guilds`, `/api/me/guilds-refresh`, `/api/me/guild`, `/api/me/community`, `/api/me/community-members` via a `?action=` query dispatched in the default export. `vercel.json` rewrites preserve the pretty URLs externally.
- `api/bot.ts` handles both Discord interaction webhooks and Discord event webhooks (`?action=interactions` vs `?action=events`).
- `api/auth.ts` bundles OAuth start/callback + sign-in/out + session refresh.
- `api/trades.ts` handles propose/respond/cancel/counter.

When adding a new endpoint, **first look for an existing dispatcher** that fits. Creating a new `api/*.ts` file is a last resort — not because of code aesthetics, because of the plan ceiling.

### Body parsing

`@vercel/node` pre-parses JSON bodies and does NOT honor Next.js's `config.api.bodyParser = false` convention. If you need the raw request bytes (e.g., signature verification), **re-serialize `req.body` via `JSON.stringify`**. This works because V8 preserves JSON key insertion order across `parse → stringify`, so the round-trip produces byte-identical output for the compact JSON Discord and Stripe-style webhooks emit.

See `canonicalRequestBody` in `api/bot.ts` for the canonical pattern.

### Auth surfaces

- `requireSession(req, res)` — returns `{ userId }` or sends the response and returns null. Use the null-return pattern: `const session = await requireSession(req, res); if (!session) return;`
- `getDiscordAccessToken(req, res)` — returns the cached OAuth token or null. Returns null on a fresh session that has never been authorized for `guilds` scope, or an expired one. Callers should respond `409 discord-token-unavailable` so the client can prompt re-auth without nuking the session.

### Logging convention

`console.error('<handlerName>: <what failed>', err)` — the prefix tags the log line with its origin when we grep Vercel logs. No structured logger yet.

## Dispatch patterns

Two recurring shapes:

### Query-dispatch (e.g. `api/me.ts`, `api/bot.ts`)

```ts
switch (req.query.action) {
  case 'settings': return handleSettings(req, res);
  case 'guilds':   return handleGuildsList(req, res);
  ...
  default:         return res.status(404)...;
}
```

Sub-handlers are **exported** so tests can call them directly without HTTP.

### Top-of-file method check (single-purpose endpoints)

```ts
if (req.method !== 'POST') {
  res.setHeader('Allow', 'POST');
  return res.status(405)...;
}
```

## Testing

Integration tests under `tests/api/` hit handlers with `mockRequest / mockResponse` helpers — no HTTP, no dev server, but a real Postgres (`describeWithDb`). Tests that need Discord interactions use `dispatchBotPayload` (bypasses signature verification). Tests that need to assert the signature layer use the default `handler` export with a fresh keypair; see `tests/api/bot.test.ts`'s `describe('signature-verified handler')`.

## Cron jobs

`vercel.json` declares crons; each points at an `api/cron/*.ts` file. Those **do** count toward the function ceiling. The refresh-prices cron is the only active one today.
