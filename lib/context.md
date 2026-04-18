# `lib/` — orientation

Shared code used by `api/` handlers, cron jobs, and (via `.js` imports — see below) the frontend when it needs to be symmetric with the server.

## Module map

| File                     | Purpose                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `schema.ts`              | Drizzle schema + inferred types. Single source of truth for DB shape.                               |
| `db.ts`                  | Lazy-initialized `drizzle(...)` client. `getDb()` is the only import most handlers need.            |
| `auth.ts`                | Session cookie seal/unseal + `requireSession` + OAuth token cache helpers.                          |
| `discordClient.ts`       | **User-scoped** Discord REST client (uses OAuth token). For `/users/@me/guilds` etc.                |
| `discordBot.ts`          | **Bot-scoped** Discord REST client (uses bot token). For DMs, thread create, message edit.          |
| `discordSignature.ts`    | Ed25519 verification for Discord webhook signatures.                                                |
| `guildSync.ts`           | Reconciles `user_guild_memberships` from a Discord `/guilds` response.                              |
| `proposalMessages.ts`    | Builders for every DM/thread message shape a trade proposal emits (embed + action rows).            |
| `threadConsent.ts`       | 4-state `communicationPref` decision matrix (`deliveryForPair`, `handleThreadRequest`).             |
| `shared.ts`              | Isomorphic helpers used by both server + frontend (`restrictionKey`, price math, etc).              |

## Invariants

### `schema.ts` is the source of truth

- Every column lives in `schema.ts` first; types flow out via `users.$inferSelect` / `$inferInsert`.
- Adding a column = `drizzle-kit generate` → commit the generated `drizzle/NNNN_*.sql` alongside the schema change. The `_journal.json` version bump is the part that fails loudly if you forget.
- Enum columns use `text('col', { enum: [...] }).default(...)`. Drizzle narrows the TS type from the enum tuple — no separate `as const` needed.
- Defaults in schema **must** match defaults wherever the column is read (e.g., `communicationPref ?? 'allow'` in button handler). The mismatch is silent; the test suite's best proxy is a seeded-user integration test.

### Two Discord clients, not one

- `discordClient.ts` authenticates as the **user** via an OAuth access token. It can read `/users/@me/guilds` etc. Token lifetime is short; use `getDiscordAccessToken` from `auth.ts`.
- `discordBot.ts` authenticates as the **bot** via the bot token env var. It can DM users, create threads in guild channels the bot has been added to, and edit its own past messages. The bot client is **stateless** — no caching, no rate-limit tracking; Discord returns 429 on abuse, caller handles.

Mixing these is a common mistake. Bot endpoints that need user data must proxy through a stored reference (DB) — the bot can't read the user's guild list on its own.

### `.js` import extensions

Server code imports from sibling modules with explicit `.js` extensions (`from './schema.js'`) because the server is ESM. TypeScript's module resolution handles the `.ts` → `.js` mapping at build time. If you see a `TS2307: Cannot find module './foo'` after adding a file, check for the missing `.js` extension.

### `proposalMessages.ts` is the visual contract

Every message shape a trade proposal takes (initial DM, thread post, edit-on-accept, edit-on-counter, thread-requested variant, thread-moved variant, thread-declined variant, proposer notification) has a dedicated builder here. **Do not** inline-construct these bodies in handlers — the ergonomics of keeping color/copy/button consistency depends on them all coming through this module.

Button `custom_id` prefixes live here as exported constants (`BUTTON_CUSTOM_ID_PREFIX`, `COMM_PREF_CUSTOM_ID_PREFIX`) so the dispatcher in `api/bot.ts` stays in sync.

### `threadConsent.ts` is pure

No DB, no Discord. Just the decision matrix — takes two `CommunicationPref` values, returns the routing outcome. That purity is load-bearing for the 16-cell matrix test in `tests/api/trades-propose.test.ts`. Don't let this module grow side effects.

## Testing

- Everything here is exercised by integration tests under `tests/api/` (via the handlers that use them).
- Units that are especially load-bearing get their own test file too: `discordSignature.test.ts`, any future `threadConsent.test.ts`.
- The integration-test harness uses a real Postgres. Drop/recreate rows in test fixtures rather than mocking the DB — per project memory, mocks diverge from prod.
