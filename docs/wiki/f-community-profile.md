# F. Community / profile / settings

> **Owner scope**
>
> - `src/components/CommunityView.tsx` — `/?community=1&guild=X&tab=Y` per-guild tabbed community pages.
> - `src/components/ProfileView.tsx` — `/u/<handle>` and `/?profile=<handle>` public profile pages.
> - `src/components/SettingsView.tsx` — `/?settings=1` drill-down hub (profile / preferences / servers → guild → members → per-user prefs).
> - `src/components/HandlePickerDialog.tsx` — "Trade with…" dialog that gates propose + shared-session entry points.
> - `src/hooks/useCommunityMembers.ts` — `/api/me/community-members` directory + peer-pref mutations.
> - `src/hooks/useCommunityActivity.ts` — `/api/me/community-activity` activity feed.
> - `src/hooks/useGuildMemberships.ts` — `/api/me/guilds` + enroll/patch + Discord refresh.
> - `src/hooks/useAccountSettings.ts` — `/api/me/prefs` registry-driven self prefs.
> - `src/hooks/useRecentPartners.ts` — `/api/me/recent-partners` chips in HandlePickerDialog.
> - `src/hooks/useTrending.ts` — `/api/trending` (orphaned; see Tech debt).
> - `api/me.ts` — single dispatcher for every `/api/me/*` action (prefs, guilds, community-members, community-activity, recent-partners).
> - `api/user/[handle].ts` — public profile fetch for `/u/<handle>`.
> - Schema rows in `lib/schema.ts`: `users` privacy columns (lines 30–88), `userPeerPrefs` (lines 103–126), `botInstalledGuilds` (lines 143–160), `userGuildMemberships` (lines 172–200), `communityEvents` (see migration 0016).
> - Integration tests: `tests/api/me-settings.test.ts`, `me-community-members.test.ts`, `me-community-activity.test.ts`, `me-guilds-refresh.test.ts`, `me-recent-partners.test.ts`, `user-handle.test.ts`, `tests/lib/prefsRegistry.test.ts`.
> - Browser specs: `e2e/community.auth.spec.ts`, `e2e/community-directory.auth.spec.ts`, `e2e/profile.auth.spec.ts`, `e2e/settings.auth.spec.ts`.

## Overview

This area owns every surface SWUTrade exposes for **"who else is here, and what are they willing to trade"**: the per-guild community pages, the public profile view, the Slack-style Settings drill-down, and the dialog that binds them to the proposal + session flows. All four surfaces share one substrate — the **three-axis consent model** (`enrolled` · `includeInRollups` · `appearInQueries`) stored per `user_guild_memberships` row — and the **pref registry** (`lib/prefsRegistry.ts`) that drives every form field in Settings. If you're reading "what is user X willing to show whom, and how do I render it," you are on the right page.

The area is a frontend layer over a few narrow `/api/me/*` endpoints. Business rules (who's eligible to appear in a rollup, whose events surface in a feed, how peer-pref overrides cascade) live in `api/me.ts` and `lib/communityEvents.ts`; this page documents those rules from the consumer's perspective and points at `i-discord-bot.md` for the authoritative registry shape and Discord-side DM behavior.

## Key concepts / glossary

- **Three-axis consent** — `user_guild_memberships.enrolled`, `includeInRollups`, `appearInQueries` (`lib/schema.ts:189-191`). Stored as three booleans per user/guild row. `enrolled=true` is the root consent ("I'm in this community"); the other two gate specific surfaces (rollup aggregation, directory/who-has lookups). When the user toggles `enrolled` off, the API zeroes the other two (`api/me.ts:439-442`) so inconsistent combinations can't linger.
- **Pref registry** — `lib/prefsRegistry.ts`. Typed definitions with `scope: self | peer | guild`, `type: boolean | enum`, `surfaces: web[] | discord[]`, plus `section` for grouping in `SettingsView`. Drives both form rendering (`SettingsView.tsx:503-526`) and the peer-override select (`SettingsView.tsx:859-906`). The SCHEMA of individual prefs is owned by [`i-discord-bot.md`](./i-discord-bot.md) — this page documents the WEB renderings only.
- **Peer prefs** — per-peer overrides stored in `user_peer_prefs` (`lib/schema.ts:103-126`). `override` column = null means "inherit"; any other value wins over the viewer's self pref. The client sees both `override` (raw, null-able) and `effective` (resolved through the cascade) so the UI can render `Use my default (Threads preferred)` without a second round trip (`useCommunityMembers.ts:11-16`).
- **Guild sync** — `lib/guildSync.ts`. Pulls the user's Discord guild list and reconciles `user_guild_memberships`, preserving consent flags on upsert. Auto-enrolls new memberships when the guild is in `bot_installed_guilds` (guildSync.ts:57-95), but never flips an existing row's consent state.
- **Community events** — append-only log at `community_events` (read via `lib/communityEvents.ts:listEvents`). Two event types today: `trade_accepted`, `member_joined`. Writes never fail the parent action — the insert is try/caught (`communityEvents.ts:37-54`).
- **Activity privacy toggle** — `users.shareActivityPublicly` (`lib/schema.ts:70`). Read-time filter in the listEvents SQL — set to false and the actor's events vanish from every feed, including the historical trail, but stay in the table for the day the user flips it back on.
- **Stranded-guild URL** — bookmark or share-link to `?community=1&guild=<X>` where the viewer is no longer enrolled. `CommunityView` treats this distinctly from "not enrolled in anything" (`CommunityView.tsx:173-177`): it renders a banner explaining the mismatch and offers a link back to the selector rather than collapsing silently into the empty state.
- **Known handle shortcut** — `HandlePickerDialog.isKnownHandle()` (`HandlePickerDialog.tsx:112-117`). Skips the `/api/user/:handle` validation when the typed handle exactly matches a community member or recent partner, on the assumption that both sources carry authoritative handles.

## File map

### Components

**`src/components/CommunityView.tsx`** — 950 lines. Top-level component for `/?community=1`. Handles popstate routing (`parseRoute` / `buildUrl`), the guild selector / single-guild auto-redirect / stranded-guild banner logic, the four-tab guild space (Overview / Members / Popular wants / Upcoming), and the client-side overlap math that re-sorts members by match intensity. All JSX is colocated (no sub-modules yet); tabs live as inline functions to avoid prop drilling.

**`src/components/ProfileView.tsx`** — 430 lines. Standalone page for `/u/<handle>` and `/?profile=<handle>`. Owns the hero (avatar + handle + trade CTA), the tabbed Wants / Available list, and the row renderer (`ProfileRow`). Signed-out viewers get `slim` chrome (`AppHeader slim={!auth.user}`) to avoid pushing sign-up affordances at cold link-clicks.

**`src/components/SettingsView.tsx`** — 1100 lines. The hub. URL-driven drill-down (`hub → section → guild → members → user`). Breadcrumb trail built from the route tuple (`SettingsView.tsx:127-185`), persistent **Done** button whenever `parent != null` (`SettingsView.tsx:191-206`), pref-registry-driven form sections (Profile, Preferences) and server-detail forms.

**`src/components/HandlePickerDialog.tsx`** — 420 lines. Modal summoned by `TradeSummary.tsx:358`. Three input paths converge on one handle: recent chips (up to 5, hidden while typing), free-text with validation, community suggestions filtered by substring. Two output actions: "Send proposal" (navigate to `/?propose=<handle>`) and "Start shared trade" (POST `/api/sessions/create` + `toSession`).

### Hooks (client state)

**`src/hooks/useCommunityMembers.ts`** — single-fetch-on-mount directory. Optimistic `setPeerPref` that rolls back by refetch on failure (can't reverse a per-field mutation locally without a stale snapshot). Clearing an override (`value === null`) refetches regardless of success so `effective` resolves against the authoritative cascade.

**`src/hooks/useCommunityActivity.ts`** — guild-scoped feed (re-fetches when `guildId` changes). Idle state when no guild is active so the selector view doesn't fire a pointless request.

**`src/hooks/useGuildMemberships.ts`** — the richest of the hooks. Module-scoped singleton cache (`sharedCache`) so return-navigation paints instantly; auto-refresh from Discord once per tab session (`AUTO_REFRESHED_KEY` in `sessionStorage`); manual refresh surface with a 409-specific `needs-reauth` status the UI banner keys off of (`SettingsView.tsx:1035-1045`); optimistic `updateGuild` with server-canonical reconciliation (the server applies bundle defaults on first-enroll, so the local patch has to resync).

**`src/hooks/useAccountSettings.ts`** — thin registry-driven `/api/me/prefs` reader + optimistic writer. Not the peer-prefs surface — those live inside `useCommunityMembers`.

**`src/hooks/useRecentPartners.ts`** — five-chip recent trade-partner list. Fires once per dialog open; no refresh path (the dialog is remounted fresh each invocation, so staleness is bounded).

**`src/hooks/useTrending.ts`** — residual hook calling `/api/trending`. See Tech debt; the trending strip was removed from `TradeSearchOverlay` on 2026-04-17 and no surface currently renders this hook's return value.

### Server

**`api/me.ts`** — single Vercel function holding every `/api/me/*` action. Dispatches on the `action` query param (set by rewrites in `vercel.json`). Consolidated to keep the project under the Hobby-tier 12-function ceiling (cross-link [`j-infra.md`](./j-infra.md)). Sub-handlers are exported so the integration tests can call them directly without an HTTP mock.

**`api/user/[handle].ts`** — public profile GET. The only `/api/me/*`-adjacent handler that lives outside `api/me.ts` because it's slug-routed (`[handle].ts` dynamic route). 60-second s-maxage, 300s stale-while-revalidate — profiles tolerate mild staleness and this drops load on the hot path.

### Shared libraries (read-only from this area)

**`lib/prefsRegistry.ts`** — registry owner. Documented in [`i-discord-bot.md`](./i-discord-bot.md); this page consumes its exports.

**`lib/communityEvents.ts`** — activity feed writer/reader. Documented below under Data model; `recordTradeAcceptedAcrossGuilds` is the only non-trivial writer and lives next to proposal-accept in `lib/proposalResolve.ts`.

**`lib/guildSync.ts`** — shared by the OAuth sign-in path (`api/auth.ts`) and the manual-refresh endpoint. Owned by [`g-auth.md`](./g-auth.md) and [`i-discord-bot.md`](./i-discord-bot.md) respectively; this page just documents the read shape.

## Data model

### `user_guild_memberships` (the three-axis consent row)

One row per (user, guild). Schema: `lib/schema.ts:172-200`. The four fields that matter for this area:

| column | default | gates |
|---|---|---|
| `enrolled` | `false` (but see below) | Root consent. Appears in `/api/me/guilds`'s `enrollable` list regardless — `enrolled` is the opt-in state, not the visibility of the row to the user. |
| `includeInRollups` | `false` | `/api/me/community` aggregated rollup (what cards members want/have, collapsed across users). Used by the "Community wants" chip in the trade builder's picker — cross-link [`c-trade-builder.md`](./c-trade-builder.md). |
| `appearInQueries` | `false` | `/api/me/community-members` per-user directory AND `/api/me/community-activity` guild feed. Both surfaces require **symmetric** consent: the viewer AND the target must have this set for the row to appear. |
| `canManage` | `false` | True when the Discord `MANAGE_GUILD` permission bit is set. Reserved for the v2 LGS admin page (not yet shipped); today it only surfaces a "You manage this server" chrome hint in `ServerDetail`. |

**Default override (2026-04-17):** `lib/guildSync.ts:70-82` — when a new `user_guild_memberships` row is inserted for a guild the bot is already installed in, all three flags flip to `true`. Existing rows are untouched; only the first-sync insert gets the auto-enroll bundle. This replaced the pure-opt-in default that was bouncing beta users off the wall before they'd tried anything. Tested in `tests/lib/guildSync.test.ts` as the "auto-enrolls new memberships in guilds where the bot is installed" pin.

**New-user defaults on the `users` row (same commit):** `api/auth.ts:265-274` explicitly sets `profileVisibility: 'public'`, `wantsPublic: true`, `availablePublic: true` on insert. The schema defaults are stricter (`profileVisibility: 'discord'`, `availablePublic: false` — see `lib/schema.ts:38-47`); the explicit insert wins for new accounts, existing accounts keep whatever they had. The mental model: "new users land with the dials cranked open; they can turn things off; existing users' explicit opt-outs are preserved."

**Post-enrollment zeroing** (`api/me.ts:439-442`): when `next.enrolled === false` is about to be written, the handler forcibly zeroes `includeInRollups` and `appearInQueries`. That preserves the invariant "only `enrolled=true` rows contribute to any community surface" without making every downstream query add the two-axis conjunction.

### `user_peer_prefs` (peer overrides)

`lib/schema.ts:103-126`. Composite PK `(user_id, peer_user_id)`. One row per viewer/peer pair; FK cascades on delete so deactivated users don't leave orphan overrides. Today the only peer-scoped column is `communicationPref` (mirrors the self-scoped column on `users`). Adding a second peer pref flows through the registry + the hook shape without a new migration step — the UI iterates `PREF_DEFINITIONS.filter(d => d.scope.kind === 'peer')`, and the API GET/PUT do the same.

**Rows are kept when overrides are cleared** — `api/me.ts:225-243` upserts with `persisted = null` rather than deleting. Cleaner than "delete when every column is null" for a table that will gain more columns, and the null row is harmless (the resolver treats null overrides identically to absent ones).

**Clearing refetches** — `useCommunityMembers.setPeerPref` (`useCommunityMembers.ts:102-107`) refetches on `value === null` success because the client doesn't have enough local state to predict what `effective` resolves to after the override is removed. The resolver's cascade is "peer override → viewer self → registry default," and only the self value is reliably on the client (not the registry default).

### `community_events` (the activity feed table)

Owned by `lib/communityEvents.ts`. Two event types today:

- `member_joined` — one row per first-time enrollment (not re-enroll). Fired inside `handleGuildPut` when `patch.enrolled === true && membership.enrolled === false` (`api/me.ts:457-463`). The condition is important: toggling enrollment off and back on does NOT re-fire the event. The first enroll is treated as the definitive "joined the community" moment.
- `trade_accepted` — one row per guild where BOTH parties are `enrolled=true + appearInQueries=true`. Fired by `recordTradeAcceptedAcrossGuilds` (`lib/communityEvents.ts:66-116`) inside `lib/proposalResolve.ts` (the shared accept-path). The accepter is the `actorUserId`; the payload carries `{ proposalId, counterpartUserId }` for deep-link chrome.

**Read-time privacy filter** — `listEvents` (`lib/communityEvents.ts:141-186`) joins to `users.shareActivityPublicly` and the WHERE clause is `(users.id IS NULL OR users.shareActivityPublicly = true)`. Turning the pref off hides the actor's past events from the feed but keeps them in the table. Flipping the pref back on restores the trail. System events (null actor) always pass through.

**Write failures never bubble** — `recordEvent` is wrapped in a try/catch that only console.errors (`communityEvents.ts:37-54`). The feed is audit-log-style, not a correctness-critical surface; losing a row because the DB hiccuped must not roll back a successful trade acceptance.

### `CommunityMember` payload shape

`api/me.ts:592-618`. Each directory row carries:

- Identity (`userId`, `handle`, `username`, `avatarUrl`) — always populated.
- `mutualGuildNames` + `mutualGuildIds` — parallel arrays; the Settings drill-down uses the ids to scope a member row to a specific guild without a second endpoint.
- `wantsPublic` / `availablePublic` — flags that gate the `wantFamilyIds` / `availableProductIds` arrays on the same row. Arrays empty when the flag is false.
- `wantsTotal` / `availableTotal` — total counts even when the lists are private. Not leakage of WHICH cards, and signals "worth approaching off-platform." Noted in the API docstring as a deliberate choice that can be gated later if it turns out wrong.
- `peerPrefs.override` + `peerPrefs.effective` — both shapes, see above. Resolved inline in the member handler (`api/me.ts:798-827`) to avoid N+1 DB reads through `resolvePref`.

### Public profile payload (`/api/user/[handle]`)

`api/user/[handle].ts`. Returns:

```
{
  user: { username, handle, avatarUrl },
  wants: ProfileWant[] | null,
  available: ProfileAvailable[] | null
}
```

`null` vs empty array is load-bearing: `null` means "list is private" (`wantsPublic === false`), empty array means "list is empty but public." `ProfileView` keys the "This user's wants list is private" panel off the null (`ProfileView.tsx:259-262`).

**Notably absent:** no `profile_visibility` enforcement here. The endpoint is reachable for any `users` row regardless of `profileVisibility` — the gate is instead at the directory and rollup surfaces. If profile-visibility=private needs to block the profile page itself, this handler is the gate to add; today a direct `/u/<handle>` hit of a private user still renders the hero (wants/available come back null). Not documented as a bug because it was deliberate in the 2026-04-17 public-defaults slice — public by default, opt-in to privacy, and the inconsistency was accepted.

## Public surface

### Endpoints (read by this area's hooks)

- `GET /api/me/guilds` — `{ enrollable, other }`. `enrollable` is guilds with bot installed; `other` is bot-less (informational chrome only). Carries `memberCount` per guild (SWUTrade-enrolled count, not Discord member count — a live bot query would be required for the latter). Private, no-store cache.
- `POST /api/me/guilds/refresh` — manual re-pull of Discord `/users/@me/guilds`, reconcile, return the same shape as GET. 409 `discord-token-unavailable` when the OAuth access token is missing/expired/revoked — the hook's `refreshStatus: 'needs-reauth'` keys off this and renders a sign-in-again banner (`SettingsView.tsx:1035-1045`).
- `PUT /api/me/guilds/:guildId` — patch body `{ enrolled?, includeInRollups?, appearInQueries? }`. Server applies the bundle-default on first-enroll (`api/me.ts:435-438`) and zeroes the other two on un-enroll; response carries the canonical post-write state so the optimistic UI can reconcile.
- `GET /api/me/prefs` — self-scoped prefs projection. Registry-driven; unknown keys 400 on PUT.
- `PUT /api/me/prefs` — self patch OR peer patch depending on body shape. `{ peerUserId, key, value }` hits the peer branch; `value: null` clears the override.
- `GET /api/me/community` — rollup. `{ wantFamilyIds, availableProductIds }` across all users in the viewer's enrolled+rollup guilds. Only consumed by the builder's picker today (not this area).
- `GET /api/me/community-members` — directory. Gating documented in `handleCommunityMembers`'s docstring (`api/me.ts:561-591`).
- `GET /api/me/community-activity?guildId=X&limit=N` — guild feed. 403 when the viewer isn't enrolled+queryable in that guild — distinct from 200-with-empty-events, so the client can render a wall-hit state rather than silently showing nothing.
- `GET /api/me/recent-partners` — up to five distinct counterparts from `trade_proposals`, newest-first, both-sides. Private profiles are included — the dialog just needs a handle to navigate to.
- `GET /api/user/:handle` — public profile. Cached `s-maxage=60, stale-while-revalidate=300`. 404 on unknown handle (consumed by HandlePickerDialog's validation path).

### Hooks

- `useCommunityMembers()` — `{ members, status, setPeerPref }`. Single fetch on mount. `setPeerPref` is optimistic with refetch-on-failure.
- `useCommunityActivity(guildId)` — re-fetches when guildId changes; idle when null.
- `useGuildMemberships()` — `{ enrollable, other, status, refreshStatus, refreshFromDiscord, updateGuild }`. Module-scoped cache across hook instances; one-shot auto-refresh per tab session.
- `useAccountSettings()` — `{ settings, status, update }`. Optimistic patch with refetch-on-failure rollback.
- `useRecentPartners()` — `{ partners, status }`. Fires once per mount.

### Components

- `<CommunityView wants={WantsApi} available={AvailableApi} />` — mounted by `App.tsx` when `viewMode === 'community'`. Needs the viewer's wants/available to compute the Members tab's overlap math client-side.
- `<ProfileView handle percentage priceMode onStartTrade />` — mounted when the router resolves `/u/<handle>` or `?profile=`. `percentage` + `priceMode` flow through from the global pricing context for consistent list totals.
- `<SettingsView onClose />` — mounted on `?settings=1`. `onClose` navigates back to the home page; called by the persistent Done button and by unknown-route fallthrough.
- `<HandlePickerDialog open onClose onPick />` — mounted inside `TradeSummary.tsx:358`. `onPick` navigates to `/?propose=<handle>`; the dialog internally handles the "Start shared trade" path (POST `/api/sessions/create`) without calling back to the parent.

## State + data flow

### CommunityView: selector → guild space → member row

1. Mount reads `window.location.search` into a `Route` tuple (`guildId?`, `tab?`). Popstate listener keeps state aligned on back/forward; all navigations go through `navigate(route, { replace? })` which pushes (or replaces) history and updates state.
2. `useGuildMemberships` and `useCommunityMembers` fire in parallel on mount. Both are single-fetch hooks; community is unscoped (the whole directory comes back in one call and the component filters client-side by `mutualGuildIds.includes(guildId)`).
3. First render waits for `guildsReady` (`guilds.status !== 'loading'`) before deciding the branch. Three branches:
   - **0 enrolled** → `NoGuildsEmptyState` with a deep link to Settings → Discord servers.
   - **1 enrolled + no route.guildId** → `useEffect` fires `navigate(..., { replace: true })` to jump straight to Overview. Replace not push, so the browser back button doesn't loop them back to a selector that would redirect forward again.
   - **>1 enrolled + no route.guildId** → `GuildSelector` list of rows.
4. Inside a guild, four tabs: **Overview** (activity feed + top-3 matches), **Members** (full list, sortable), **Popular wants** (client-side aggregation), **Upcoming** (LGS placeholder — Phase 4 v2, see `UpcomingPanel`). Overview's `useCommunityActivity(guildId)` is the only tab-level fetch; the others compute off the shared `members` array.
5. **Member row is shared between Overview and Members** — same `MemberRow` component, differing source arrays (top-3 vs full sorted). Gives the two tabs visual consistency without abstracting prematurely.
6. **Overlap math is viewer-local** — `viewerAvailableFamilies` and `viewerWantFamilies` are memoized familyId sets built from the viewer's own lists. `enrichMember` intersects each member's `wantFamilyIds` + `availableProductIds` against those sets to compute `iCanOfferThem` and `theyCanOfferMe`. Everything's a `Set<string>` so repeated re-sorts don't re-scan the source lists.

### Popular wants: why client-aggregated, not endpoint-driven

`PopularPanel` (`CommunityView.tsx:655-719`) counts familyId occurrences across `guildMembers[].wantFamilyIds`. The `/api/me/community` rollup endpoint exists and could have grown a count field, but the directory endpoint already carries per-member wantFamilyIds (gated on the member's `wantsPublic`), and replicating the consent gates in two places was the higher-risk path. Decision memo is inline at `CommunityView.tsx:60-66`.

### ProfileView: fetch → render → CTA branching

1. Mount fires `fetch(/api/user/<handle>)`. 404 flips to an error state with a "Back to SWUTrade" link; other non-200s fold into "Failed to load profile."
2. `wantsRows` maps profile.wants through `bestMatchForWant` against `byFamilyAll` to land on the canonical variant — same primitive the trade builder uses for inventory rows, so variant restrictions render identically across surfaces. Cross-link [`d-lists.md`](./d-lists.md) for the list-rendering internals.
3. CTA branches three ways depending on viewer state (`ProfileView.tsx:129-161`):
   - **Signed-in viewing other** → `<a href="/?propose=<handle>">` landing in the propose composer. Label is "Trade with @<handle>" — the single-CTA post-fix state from the UX batch on 2026-04-17. Previously two buttons (Propose + Just balance) both auto-filled the editor and differed only in whether Send rendered; two buttons for visually-indistinguishable outcomes was a confusion vector.
   - **Signed-in viewing own profile** → `<button onClick={onStartTrade(handle, true)}>Open trade editor</button>`. No Propose link because there's no counterpart. Labels split to avoid conflating with the other-viewer CTA.
   - **Signed-out viewing other** → same button-style CTA as own-profile, labeled "Start a trade." Local balance flow (auto-balance true), no Discord send.
4. **Wants + Available are tabbed, not stacked** — `ProfileLists` (`ProfileView.tsx:240-321`). Previously vertical stack: users looking for "what do they have available" had to scroll past the entire wants list. Tabs made both one click away AND the existence of both lists legible at the tab strip (with counts / "private" badge / "public-but-empty" distinguishable at a glance). Default active tab is the first one with items; falls back to Wants when both are empty or private.
5. **Back button is browser-native** — `ProfileView.tsx` doesn't render a back button. The breadcrumb's "Home" segment handles the main affordance; the chrome-level back works via browser history. Users arrive from multiple paths (Community, TradeDetail, direct link), and no referrer was reliable enough to pick the right "back" destination. Same reason the breadcrumb trail stays minimal — `[Home, @handle]`.

### SettingsView: drill-down routing

1. Route tuple is four fields: `{ tab, guildId, members, userId }`. `parseRoute` and `buildUrl` are the chokepoints; both live at the top of the file (`SettingsView.tsx:237-263`).
2. Content branches on the tuple (`SettingsView.tsx:76-113`) — six terminal views plus a hub. Unknown tuples fall through to the hub (not a 404), so a stale link can't trap the user.
3. Breadcrumbs are built from the same tuple (`SettingsView.tsx:127-185`). As the trail lengthens, prior segments flip from current-page to links (e.g., "Discord servers" becomes clickable once you're inside a guild). The label of the current-page (last) segment is always `href`-less — `AppHeader` renders that distinction.
4. **Done button** — `SettingsView.tsx:191-206`. Surfaces whenever `parent != null` (i.e., the user has drilled in at all). Lives in its own strip below the breadcrumb row, not in `AppHeader`'s actions slot, so a long trail doesn't crowd against it on narrow viewports. The "Back 5 times is bad UX" beta feedback forced this — browser-back works but was unreliable on mobile Safari after popstate events, and no Done control was a dead-end complaint even on desktop.
5. **Peer-prefs under `servers/<guild>/members/<user>`** — navigation affordance, not a storage model (`SettingsView.tsx:39-43`). Peer overrides are still globally scoped in the DB; the UI just surfaces them in a community context so users find them from wherever they ran into the peer. The 2026-04-18 move from CommunityView to Settings collected all per-trader config in one place (the drill-down also drives the Prefs button on each Community member row, which deep-links straight in — see `CommunityView.tsx:770-772`).

### HandlePickerDialog: three input paths, two output actions

Input paths (`HandlePickerDialog.tsx:35-95`):

- **Recent chips** — fire only when the input is empty (`showRecent = query.length === 0 && recentStatus === 'ready'`). Surfacing them while the user types cluttered the panel and competed with the community suggestions that already filter in real time. Each chip is a one-tap bypass of validation.
- **Typed handle** — validated on submit via `/api/user/:handle`. Unknown handles flip the dialog into error state (`No SWUTrade user with the handle @X`) instead of bouncing the user into a broken composer. A "known handle" shortcut skips the fetch when the typed text exactly matches a member or recent partner (`isKnownHandle()`).
- **Community suggestions** — filtered by substring against `handle` OR `username`. Capped at `MAX_SUGGESTIONS = 8` so the panel doesn't blow up on large guilds; the free-form input handles the long tail.

Output actions (`HandlePickerDialog.tsx:322-348`):

- **Send proposal** → `onPick(handle)` → caller navigates to `/?propose=<handle>`. Gold button, visual primary.
- **Start shared trade** → POST `/api/sessions/create` with `counterpartHandle` and empty `initialCards`; on success, `nav.toSession(id)`. Cyan outline, visual secondary. If an active session already exists between the pair, the server returns that id and the handler jumps into the existing trade (the pair-uniqueness redirect, cross-link [`a-sessions.md`](./a-sessions.md)).

Validation state is shared between both paths — starting the session re-runs `/api/user/:handle` the same way Propose does, so the UX is symmetric.

**Empty-community state** (`EmptyCommunityState`, `HandlePickerDialog.tsx:374-392`) — renders when `members.length === 0 && status === 'ready'`. Two variants: "your recent partners are above" vs "you're not in any shared Discord communities yet." Both include the same deep link to `Settings → Discord servers`. Intentionally not a wall — the typed-handle input still works; the empty state is informational.

### Peer-pref write: UI → hook → API → cascade

1. User picks a value in `PeerPrefField`'s `<select>` (`SettingsView.tsx:859-906`). Empty string means "inherit"; maps to `null`.
2. `setPeerPref(member.userId, def.key, value)` fires through `useCommunityMembers`. Hook optimistically updates the local `members[]` array (`useCommunityMembers.ts:77-89`): flips the override, flips effective to `value ?? prev.effective[key] ?? null` (the prior effective value is a bounded-staleness approximation when value is null — the refetch-after-clear path corrects it).
3. `apiPut('/api/me/prefs', { peerUserId, key, value })` hits `handlePrefsPeerPut` (`api/me.ts:198-246`). Null → clear; non-null → registry-validated, then upserted on `(userId, peerUserId)`.
4. On success: if value was null, refetch the whole directory to pick up the authoritative effective. If value was concrete, keep the optimistic state.
5. On failure: refetch the directory. No per-field rollback — the directory isn't huge and a full resync is cleaner than a speculative-reversal scheme for a surface with multiple interleaved writes.

## UI/UX patterns

### Palette

Cyan / blue accents dominate the social surfaces — the "Start shared trade" button in HandlePickerDialog is cyan-outline, the profile's **Wants** tab is blue (matching the receiving side's invariant color on the trade builder, from the *profile owner's* perspective: wants = what they receive). The profile's **Available** tab is emerald (offering side). Gold stays reserved for primary CTAs ("Trade with @X", "Send proposal", Done) and for the "Prefs" affordance on community rows — the scarce-resource palette rule. Cross-link the project_swutrade_palette memory for the CSS-header table.

### Tab identity language

Both CommunityView's guild tabs and ProfileView's Wants/Available tabs use the same affordance stack: active = thicker underline + accent badge pill + bolder label. The triple-affordance is deliberate — the 2-px underline alone wasn't legible enough on mobile ("which tab am I on" required pixel-peeping), so the 2026-04-17 UX batch (`NEXT.md:355`) bumped underline to 3px and added the accent-tinted count badge.

### Empty states

Everywhere in this area follows the same shape: a `title` ("No members to show yet.") + a `description` with an actionable deep link where possible. Four representative examples:

- `NoGuildsEmptyState` (CommunityView.tsx:241-250) — deep link to Settings → Discord servers.
- `MembersPanel` empty (CommunityView.tsx:600-609) — same deep link, different copy (about who-has).
- `EmptyCommunityState` (HandlePickerDialog.tsx:374-392) — two copy variants gated on whether there are recent partners.
- `ProfileLists` empty (ProfileView.tsx:295-302) — distinguishes "private" from "public but empty" by checking `profile.wants === null`.

### Loading + error states

All four components route through `src/components/ui/states.tsx`'s `LoadingState` / `ErrorState` primitives. Loading labels are specific ("Loading your communities…", "Loading members…", "Loading activity…") — a shared "Loading…" ghost banner was rejected because the user should know which surface is blocking on what (e.g., activity loading while members are already visible happens regularly on Overview).

### Stranded-guild banner

`StrandedGuildBanner` (`CommunityView.tsx:252-269`) — amber-bordered panel explaining that the shared deep link points at a guild the viewer isn't enrolled in, with a button back to the selector. Only triggers when `!activeGuild && route.guildId` — the selector's enumeration of enrolled guilds catches the "0 enrolled" case first, so this only fires for bookmark-decay or unenrolled-since-link-shared paths.

### Mobile

All three pages use the same chrome mount (`AppHeader` + breadcrumbs) with a `max-w-3xl mx-auto w-full` main column (Profile bumps to `max-w-5xl` for its wider tab panels). Tab strips use `overflow-x-auto` with negative margin tricks for edge-bleed so they stay scrollable on narrow viewports. Community member rows use `flex-wrap` on the overlap chips so "You can offer 3 of 12" + "They have 2 of 8 for you" survive vertically-stacked on phone.

## Tech debt + known gaps

### Communities module competes with trading loop

`NEXT.md:138-142` (UX-A4). The Home view used to carry a Communities side module that duplicated the `/?community=1` destination. Fix is to remove the module (it has its own top-level destination via NavMenu, and trade-relevant community signals already surface in context inside the builder). Status when this page was written: unstarted; the module still renders on HomeView. Cross-link [`e-home-nav.md`](./e-home-nav.md) for the Home layout owning that module.

### Profile entry-point audit

`NEXT.md:150-154` (UX-A6). Multiple entry points to `/u/<handle>`: CommunityView member rows, TradeDetailView counterpart, @mentions in activity feed. Not audited that they all route consistently or preserve origin context for a "Back to your trades" vs "Back to @community" nuance. Status: unstarted; every entry point currently lands at the same base ProfileView which does NOT know its referrer.

### HandlePickerDialog ambiguity

The "Send proposal" button is visually primary (gold), "Start shared trade" is secondary (cyan outline), but the copy "Pick someone, then choose to send a formal proposal or start a shared trade you can edit together" is ambiguous about which is the default for "I just want to trade with this person." Flagged in the `feedback_workflow` memory as an open thread (stacked hints). No fix committed.

### Shared abstraction for Settings servers/members drill-down dropped

`SettingsView.tsx` inlines the breadcrumb + Done-button logic across five sub-views. An R2 routing slice considered extracting a shared `<DrillDownShell>` that owned breadcrumbs + Done. Dropped because the content variability was high enough that parameterizing it made the shell noisier than the duplication saved. If a sixth drill-down destination ships, revisit.

### `useTrending` is orphaned

`src/hooks/useTrending.ts` calls `/api/trending` and is referenced only from `NEXT.md`. The trending strip was removed from `TradeSearchOverlay` on 2026-04-17 (NEXT.md:342) because the empty-state layout was too busy and the feature wasn't load-bearing at current scale. The endpoint was kept because "community view is a likely future home." Options: (a) surface in the Community Overview tab, (b) delete both the hook and the endpoint. Neither has been done.

### `as any` in ProfileView

`ProfileView.tsx:85` — `bestMatchForWant(synth as any, candidates, priceMode)`. The synthetic `WantsItem` is missing the registry-level fields `bestMatchForWant` doesn't actually read (id, addedAt are stubbed). Tolerable; documented here rather than fixed so a future TS tighten-up pass picks it up.

### `memberCount` shape drift

`CommunityView.tsx:902-907` — `formatMemberCount` defensively checks `typeof maybe === 'number'` on a field that IS declared in `GuildMembershipSummary` (`useGuildMemberships.ts:17`). The defensive check is a residual from the P3 slice when `memberCount` was still being rolled out; the check can be removed once there's no chance of stale compiled clients seeing a payload without it. Low priority.

### Profile visibility not enforced at `/api/user/:handle`

Called out in Data model above. The endpoint returns a user row regardless of `profileVisibility`; the gate is at the directory + rollup surfaces only. Deliberate during the 2026-04-17 public-defaults slice but worth documenting because the mental model "private profiles are invisible" is NOT enforced end-to-end. A direct `/u/<handle>` to a `profileVisibility: 'private'` user still renders the hero (wants/available come back null because of the per-list gates, so it's a dead page but a navigable dead page, not a 404).

### `/api/me/settings` alias not yet removed

`api/me.ts:39-42`. `/api/me/settings` is a transitional alias pointing at `handlePrefs`. Kept until deployed clients have rolled over to `/api/me/prefs`. Track for deletion when the next-next release clears the browser-cache longest-tail.

### Activity feed has no unread / badge system

Events are read newest-first but there's no per-user "last seen" watermark, so the user can't tell if they've already viewed this set of events. The feed is also not surfaced anywhere except the Overview tab — no top-nav badge, no Home-page summary. Both are intentional for the current slice (Phase 4 v1); Phase 4 v2 may add them when the feed has volume worth badging.

## Decisions worth remembering

- **Three-axis consent, not two** — we could have collapsed `includeInRollups` + `appearInQueries` into one visibility flag. Kept separate because the two surfaces have genuinely different exposure profiles: a rollup leaks "someone in your communities wants X" (privacy-safe aggregate), whereas a who-has query leaks "user @Y wants X" (privacy-specific). Users plausibly want one without the other (e.g., "help me find cards" without "enable unsolicited DMs from strangers"). Cost is UI weight — three toggles on server enroll — worth it to match the real consent geometry.
- **Public by default, 2026-04-17** — flipped new-user defaults to `profileVisibility: 'public'`, `wantsPublic: true`, `availablePublic: true`, plus auto-enroll on bot-installed guilds. Prior private-by-default defaults had every feature feel walled to newcomers. Deliberately additive: existing users' explicit opt-outs are preserved, only new account inserts and first-sync guild memberships get the bundle.
- **Peer prefs overlaid on the community context, not a top-level Settings page** — the Settings → Servers → Guild → Members → User drill-down is the canonical surface, but the same member sheet is reachable via the Prefs button on each CommunityView member row (deep link to `?settings=1&tab=servers&guild=<first-mutual>&members=1&user=<id>`). Moving peer prefs out of CommunityView on 2026-04-18 consolidated editing in one place without killing the contextual entry; the deep link is the compromise.
- **Activity feed privacy is a read-time filter, not a delete** — `shareActivityPublicly=false` hides events but preserves them. Users who toggle the pref off don't want to nuke history permanently (the past story is still their past story); they want it invisible to others until they choose otherwise. The implementation cost is zero (the join clause was going to exist anyway for actor denormalization) and the reversibility is a meaningful UX improvement over destructive-delete.
- **Popular wants aggregated client-side, not endpoint-wise** — the directory already carries the raw familyIds under the same consent gates the popular rollup would need. Adding a counted endpoint was strictly extra code to re-implement the gating. Upgrade to an endpoint if the directory becomes too large to ship in one payload (the docstring estimate is "100KB for a 50-member guild with 100 wants each").
- **Single `/api/me` function** — Vercel Hobby-tier caps at 12 serverless functions. Consolidating `/api/me/*` under one file's dispatcher (with rewrites preserving the pretty URLs) keeps the area under budget. Each sub-handler is still exported for integration tests. Same pattern as `/api/sessions/*`; cross-link [`j-infra.md`](./j-infra.md).
- **`/api/me/community-activity` returns 403, not 200-empty, for non-enrolled viewers** — a 200 with `{ events: [] }` was ambiguous between "enrolled but quiet" and "not enrolled at all." The 403 lets the client render a distinct wall-hit state. Documented in the handler docstring (`api/me.ts:842-845`).
- **HandlePickerDialog collapses to a single dialog for both proposal + session** — earlier designs had separate entry points on HomeView. One dialog with two buttons makes the choice legible (side-by-side rather than sequenced) and halves the state-management complexity. The ambiguity cost (see Tech debt) is accepted in exchange.
- **Breadcrumb-based navigation, not back buttons** — Settings and Community both rely on the `AppHeader` breadcrumb trail for "go back up one level." A content-level back button was evaluated and rejected: breadcrumbs give mobile users the chrome-level escape AND expose the hierarchy, which back-only affordances don't. Done is a sibling affordance, not a substitute.

## Cross-references

- [`a-sessions.md`](./a-sessions.md) — `POST /api/sessions/create` is called by HandlePickerDialog's "Start shared trade" path. The pair-uniqueness redirect behavior matters to that button's UX.
- [`b-proposals.md`](./b-proposals.md) — `POST /api/trades/propose` is downstream of `onPick(handle)` → `/?propose=<handle>`. ProfileView's "Trade with @X" CTA lands in the same composer.
- [`c-trade-builder.md`](./c-trade-builder.md) — the Community-wants chip in the trade builder's picker reads from `/api/me/community`. That chip's behavior is documented there, not here.
- [`d-lists.md`](./d-lists.md) — ProfileView's tabbed wants/available use the same list rendering primitives as the main app. Row chrome, variant restriction display, and priority stars are inherited.
- [`e-home-nav.md`](./e-home-nav.md) — the view router maps `?community=1`, `?settings=1`, and `/u/<handle>` onto this area's components. The Home Communities module (UX-A4) and the AppHeader breadcrumbs primitive live there.
- [`g-auth.md`](./g-auth.md) — Ghost users never see community surfaces because the ghost flow restricts them; the OAuth callback also triggers `syncGuildMemberships`, which is how this area's guild data ends up in the DB.
- [`h-cards-pricing.md`](./h-cards-pricing.md) — ProfileView consumes `byFamilyAll` + `byProductId` to render rows, and goes through `adjustPrice` / `getCardPrice` for totals.
- [`i-discord-bot.md`](./i-discord-bot.md) — owns the pref registry SCHEMA (what prefs exist, what types), the bot-install + auto-enroll wire, and the `user_guild_memberships` + guild-sync write path. This page consumes those from the web side.
- [`j-infra.md`](./j-infra.md) — for the 12-function Vercel Hobby ceiling rationale behind the `/api/me/*` dispatcher pattern and the rewrite rules that make the sub-action URLs pretty.
