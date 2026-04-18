# Discord multi-user conversation options for trade proposals

**Context:** SWUTrade's bot currently DMs the recipient when a proposal is sent. Beta users asked whether both traders could chat directly after a proposal lands, without one of them having to cold-DM the other first. This document captures the research output that informs how we'll tackle that feature.

Research conducted 2026-04-17 against current (2025–2026) Discord API documentation + community reports.

---

## 1. Group DMs (both users + optionally the bot)

**Feasibility: 🔴 RED.** Technically still exposed in the API, but unusable in production.

- Bot tokens **cannot create group DMs** on their own. The documented path is `POST /users/@me/channels` + `PUT /channels/{id}/recipients/{user.id}`, which requires a **user OAuth2 access token with the `gdm.join` scope** for each recipient. You'd have to complete an OAuth2 authorization code flow with BOTH traders, store their access tokens, refresh them, and then use those tokens to force them into a GDM.
- Even when the bot-orchestrated path "works," Discord has a long-standing invisible-GDM bug ([api-docs #426](https://github.com/discord/discord-api-docs/issues/426)): channel is created server-side but does not render in the users' clients. Community reports in 2024–2025 continue to confirm GDMs are not a supported bot surface.
- Bots cannot have friends and are not conventionally group-DM members; behavior of a bot staying in the GDM to moderate is undefined.
- **Scopes/intents:** `gdm.join` per user (requires Discord approval at scale), `bot` for the app.
- **UX if it worked:** Ideal — a normal Discord group DM with push-style notifications. In practice, unreliable.
- **Blocker:** GDMs are a user-account feature; the bot API is a dead end here.

---

## 2. Private channel in a guild (two users + bot)

**Feasibility: 🟡 YELLOW.** Works, but requires a shared guild and manual role hygiene.

- Flow: `POST /guilds/{id}/channels` with `type: 0 (GUILD_TEXT)` and `permission_overwrites` denying `VIEW_CHANNEL` to `@everyone` + allowing it for both user IDs + the bot's role.
- **Bot permissions:** `MANAGE_CHANNELS`, `MANAGE_ROLES`, `VIEW_CHANNEL`, `SEND_MESSAGES`. Guild install with `bot` + `applications.commands` scopes.
- **Hard prereq:** both traders must already be members of the same guild the bot is installed in. For in-person/local traders who don't share a server, this means running an official "SWU Trade" guild and onboarding users to it.
- **Rate limits:** channel create is ~50 per 10 min per guild; permission-overwrite timing race ([api-docs #6573](https://github.com/discord/discord-api-docs/issues/6573)) — add a 500 ms–2 s delay or retry.
- **Notifications:** channel-style (per-guild mute settings apply; no DM-style push by default). Worse than DM for "did my trader reply?" unless you `@mention`.
- **UX:** Users see a new private text channel appear in the shared guild sidebar with both names + the bot inside.
- **Blocker:** requires both users to be in a common guild; channel sprawl unless we auto-archive/delete on trade completion.

---

## 3. Threads in a designated `#trades` channel

**Feasibility: 🟢 GREEN.** Cleanest fit.

- **Private threads are free for all servers since Nov 2022** — the Level 2 boost requirement is gone.
- Flow: `POST /channels/{trades_channel_id}/threads` with `type: 12 (PRIVATE_THREAD)`, then `PUT /channels/{thread_id}/thread-members/{user.id}` for each trader.
- **Bot permissions on `#trades`:** `CREATE_PRIVATE_THREADS` (or `CREATE_PUBLIC_THREADS`), `SEND_MESSAGES_IN_THREADS`, `MANAGE_THREADS` (for lock/archive), `VIEW_CHANNEL`. Scopes: `bot` + `applications.commands`.
- **Visibility:** private thread is invisible to non-invited members even if they can see the parent channel. Public thread is visible to all parent-channel viewers (wrong for private trades).
- **Notifications:** being added fires a "X added Y to the thread" system message and pushes a notification to each added user — this is the killer feature, no "have you started a DM with X?" friction.
- **Same guild requirement** as option 2 (both users must be in the guild hosting `#trades`). Known UX nit: the "added to thread" system message is not suppressible ([api-docs #5038](https://github.com/discord/discord-api-docs/discussions/5038)).
- **UX:** Each trader gets a notification that they were added to a thread like `trade-parker-vs-alex`. Click in, chat directly. Auto-archive closes it after N days of inactivity.
- **Blocker:** still needs a common guild; can't suppress the system-add message.

---

## Recommendation — build option 3 first

Threads are the only option that is fully API-supported, doesn't require per-user OAuth tokens, and gives DM-like push on invite. Group DMs are effectively dead for bots; private channels work but add channel-list clutter that threads avoid (auto-archive is built in).

**Concrete next steps:**
1. Stand up an official SWU Trade Discord guild; make joining it part of the Discord-link onboarding already present in Phase 2/3.
2. Create a `#trades` parent channel, grant the bot `CREATE_PRIVATE_THREADS`, `SEND_MESSAGES_IN_THREADS`, `MANAGE_THREADS`, `VIEW_CHANNEL` there.
3. On proposal landing, replace the current per-user DM with: create a private thread named by trade ID, add both users via `PUT thread-members`, post the proposal card inside, set auto-archive to 24h.
4. **Fallback:** if either trader isn't in the guild yet, keep the current DM flow and deep-link them to a guild-invite that auto-routes them back to the pending trade.
5. Monitor the "added to thread" system message — if it confuses users, consider posting the proposal card first and `MANAGE_MESSAGES`-deleting the system message afterward (requires the extra perm).

---

## Sources

- [OAuth2 — Discord docs](https://docs.discord.com/developers/topics/oauth2)
- [api-docs #426: bot group DM conflicting statements](https://github.com/discord/discord-api-docs/issues/426)
- [api-docs #3770: private threads for bots](https://github.com/discord/discord-api-docs/discussions/3770)
- [api-docs #5038: silent thread add request](https://github.com/discord/discord-api-docs/discussions/5038)
- [api-docs #6573: permission-overwrite timing on channel create](https://github.com/discord/discord-api-docs/issues/6573)
- [advaith on X: private threads free for all servers (Nov 2022)](https://x.com/advaithj1/status/1594093437266976768)
- [Discord Threads FAQ](https://support.discord.com/hc/en-us/articles/4403205878423-Threads-FAQ)
- [Threads docs (discord.com)](https://discord.com/developers/docs/topics/threads)
