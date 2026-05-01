# Discord integration audit — 2026-05-01

Scope: `api/bot.ts` (2618 LOC — prompt said 1811), `api/signals.ts`,
`lib/discord{Bot,Client,Errors}.ts`, `lib/tradeGuild.ts`,
`lib/guildSync.ts`. No `api/interactions.ts` — interactions + events
both land on `api/bot.ts` via `?action=` rewrite.

## High-impact findings

### 1. `api/bot.ts` is a 2.6kLOC dispatcher with five orthogonal concerns interleaved

- **What:** Signed-webhook dispatcher, proposal buttons + thread
  flow, signals lifecycle + cron, prefs registry, and install +
  outreach all in one file. Only `payload.member ?? payload.user`
  clicker-id is shared.
- **Where:** `api/bot.ts:142-244` (dispatcher), `509-931`
  (signals), `1085-1307` (accept/decline/counter), `1344-1768`
  (thread flow), `1790-2197` (prefs), `2250-2617` (install),
  `970-1069` (cron).
- **Why it matters:** Bundle is large enough the function
  preemptively defers (316-325 calls out ~700KB past 3s).
  Custom-id-prefix dispatch (271-289) has no central registry —
  adding a prefix means editing `handleInteraction` plus imports.
- **Proposed fix:** Extract by concern into `lib/bot/*` modules
  imported from `api/bot.ts` (kept as entry so function-count
  ceiling holds). Replace if-prefix chain with
  `[{ prefix, handler }]`.
- **Risk:** medium. **Effort:** L. **Confidence:** high.

### 2. `resolveSignalFamily` / `resolveVariantSpec` duplicated across `bot.ts` and `signals.ts`

- **What:** Identical signal-row → family/variant helpers in
  both files.
- **Where:** `api/signals.ts:577-629` vs `api/bot.ts:749-805`.
- **Why it matters:** Schema drift hits twice. The
  `signals.ts:572-576` "duplication beats circular import"
  comment is spurious — both files already statically import
  from `lib/signalMatching.js`.
- **Proposed fix:** Move both to `lib/signalMatching.ts`. Also
  kills the dynamic `await import('../lib/signalMatching.js')`
  at `signals.ts:594-598` and `624` (the module is statically
  imported at the top).
- **Risk:** low. **Effort:** S. **Confidence:** high.

### 3. `botMember.roles[0]` bot-role pick is fragile

- **What:** `lib/tradeGuild.ts:271` picks the bot's role with
  `roles[0]`. Discord doesn't promise array order on
  `/guilds/{id}/members/{user}`.
- **Where:** `lib/tradeGuild.ts:270-274`; used at 300, 336, 356,
  376, 396 to grant `BOT_FULL_PERMS` overwrites.
- **Why it matters:** If an admin assigns the bot a second manual
  role, `roles[0]` may not be the managed-integration role; the
  overwrite then pins `BOT_FULL_PERMS` on the wrong role and the
  bot's channel perms collapse to the manual role's bitset —
  silent permission failure.
- **Proposed fix:** Use the bot user id with `type: 1` (user
  overwrite). `DISCORD_CLIENT_ID` is already resolved at line
  266.
- **Risk:** low. **Effort:** S. **Confidence:** medium — latent,
  not active.

### 4. Dynamic Drizzle column access via `as unknown as Record<string, AnyPgColumn>`

- **What:** Five repeats of the same 4-line cast in the prefs
  handler.
- **Where:** `api/bot.ts:1867-1870, 1978-1981, 1996-1999,
  2000-2003, 2113-2116`.
- **Why it matters:** Typo in `def.column` returns `undefined`
  and crashes at `.where()` with a confusing error. Registry
  tests pin existence but the cast leaks into every site.
- **Proposed fix:** `getUserPrefColumn(key)` /
  `getPeerPrefColumn(key)` in `lib/prefsRegistry.ts` that throw
  on unknown keys.
- **Risk:** low. **Effort:** XS. **Confidence:** high.

### 5. Auto-approve thread-create leaks orphans on cascading failures

- **What:** When `addThreadMember` or in-thread
  `postChannelMessage` throws after thread creation,
  `bot.deleteChannel(createdThreadId)` runs fire-and-forget; if
  THAT fails too the thread stays orphaned.
- **Where:** `api/bot.ts:1450-1483` (auto-approve), `1592-1626`
  (manual approve).
- **Why it matters:** Discord 5xx happens in bursts; cleanup
  fails exactly when needed. Orphans accumulate in the parent's
  thread list.
- **Proposed fix:** Cron sweep that prunes empty bot-only threads
  >24h old, or a `pending_thread_cleanup` row the existing cron
  walks.
- **Risk:** medium (resource leak). **Effort:** S.
  **Confidence:** medium.

## Lower-priority debt

- `api/bot.ts:339-356` — `waitUntil + if(awaitFollowup) await`
  test affordance leaks into prod control flow.
- `api/bot.ts:730, 1045` + `api/signals.ts:491` —
  `cards.filter(c => c !== null) as Array<NonNullable<…>>` x5;
  one `nonNull` helper.
- `lib/discordBot.ts:33-39` — `isSyntheticDiscordId` early-return
  repeated 9× with bespoke synthetic-return shapes.
- `api/bot.ts:1738-1762` — schema tracks one DM per trade;
  eventually split into proposer/recipient `discord_dm_*`.
- `api/bot.ts:1836-1843` — `comm-pref:*` legacy custom_id past-due
  TODO; signal-TTL aging covers buttons >90 days.
- `lib/tradeGuild.ts:222` — `BOT_FULL_PERMS = '360777255952'`
  magic decimal while neighbours are computed.
- `api/bot.ts:1813-1824` — peer-pref custom_id arity (5 colons,
  UUID `peerUserId`) near Discord's 100-char limit.
- `lib/discordClient.ts:38-46` — single-method client; speculative
  "new endpoint = new method" overhead.

## Anti-recommendations

- **Don't collapse `payload.member?.user?.id ?? payload.user?.id`
  into a helper** — Discord's payload shape differs by context
  (DM vs guild); a helper obscures that handlers accept both.
- **Don't add exponential backoff to `discordBot.ts`'s retry** —
  single-retry/capped-sleep (218-233) is correct for Vercel's
  10s ceiling. 5xx blips clear in <1s.
- **Don't extract a generic "embed for signal status X" helper**
  — the three sites (`signals.ts:357`, `bot.ts:725` +
  `signals.ts:486`, `bot.ts:1040`) look duplicated but input
  differs by status (matchedUsers only on active, expiryHint
  blank otherwise); `buildSignalPost` already parameterises
  status.
- **Don't merge `discordClient.ts` and `discordBot.ts`** —
  different auth (`Bearer` user token vs `Bot` token); Discord
  treats them as distinct rate-limit buckets.
- **Don't add idempotency keys to `postChannelMessage`** — the
  188-196 comment explains why blind retries are gated to
  idempotent endpoints. Discord has no idempotency-key header.
- **Don't move signature verification into middleware** —
  co-located with the cron bypass (147-150) which must run
  *before* sig verify; splitting creates an ordering trap.
