# Architecture overview

Cross-cutting themes that span multiple area pages. Read this when you need the big picture — when "how does X talk to Y" crosses more than one subsystem. Each area page ([A–J](./README.md)) goes deep within its subsystem; this page stitches them together.

## One-paragraph summary

SWUTrade is a trading tool for Star Wars: Unlimited. Users maintain a **wishlist** (cards they want) and a **binder** (cards they have), then work out trades either solo (calculator), async (Discord-DM proposals), or live (shared-canvas sessions). Built as a Vite+React SPA deployed on Vercel, backed by Neon Postgres, with a Discord bot as the first-class social layer — Discord identity is the only login, DMs and threads are the notification channel, and guilds are the scope for community discovery.

## System topology

```
                ┌──────────────────────────────────────────────┐
                │        Browser — Vite+React SPA              │
                │                                              │
                │  App.tsx routing → HomeView / TradeBuilder / │
                │                    SessionView / ProfileView │
                │                    / CommunityView / etc.    │
                │                                              │
                │  Contexts: Auth / CardIndex / PriceData /    │
                │            Pricing / Drawer / Navigation     │
                │                                              │
                │  LocalStorage: wants, available, signedInHint│
                └──────────────┬───────────────────────────────┘
                               │ HTTPS
                ┌──────────────▼───────────────────────────────┐
                │ Vercel Functions (api/*.ts dispatchers)      │
                │                                              │
                │ • Dispatcher pattern: one file owns N        │
                │   actions via `?action=X`                    │
                │ • vercel.json rewrites pretty URLs onto      │
                │   dispatcher + query form                    │
                │ • Function count is plan-capped (j-infra.md) │
                └──────────┬───────────┬──────────────┬────────┘
                           │           │              │
                  Neon Postgres   Discord API    Static JSON
                  (drizzle ORM)   (bot + OAuth)  (cards, prices)
```

Frontend and backend live in one repo. The SPA is a pure Vite build deployed by Vercel; there is no Next.js. The `api/` directory's `.ts` files are Vercel serverless functions (Fluid Compute, Node runtime). Discord integration is HTTP-only — there is no gateway connection; incoming interactions are signed webhooks.

## Core domain primitives

The app has five primitives. Every feature is a projection of one or more of them.

**Card** (immutable, read-only)
→ `src/types/`, `src/variants.ts` — full model in [`h-cards-pricing.md`](./h-cards-pricing.md).
The atomic unit. A `CardVariant` has `productId` (per-printing), `name` (with variant in parens), `set`, `variant`, and TCGPlayer `marketPrice` / `lowPrice`. Variants share a **`familyId`** (cross-printing identity).

**User** (real or ghost)
→ `lib/schema.ts` users table — full model in [`g-auth.md`](./g-auth.md).
Real users have a `discordId`; ghost users have `isAnonymous=true` and `discord_id=null`. Ghost → real merge happens in the OAuth callback and rewrites every `trade_sessions` / `session_events` reference. A user's `handle` is the public identity.

**List entry** (wants / available)
→ `src/persistence/schemas.ts` — full model in [`d-lists.md`](./d-lists.md).
A **WantsItem** is keyed by `familyId` (cross-printing) + optional `VariantRestriction` + `isPriority` star. An **AvailableItem** is keyed by `productId` (specific printing). Stored in localStorage; synced to server when signed in.

**Proposal** (async Discord-DM trade)
→ `lib/schema.ts` trade_proposals — full model in [`b-proposals.md`](./b-proposals.md).
One-shot commit-first pattern: proposer composes cards + message, server delivers via Discord DM or private thread, recipient clicks Accept / Decline / Counter / Edit Together. Lifecycle is `pending → accepted | declined | cancelled | expired | countered`. An append-only `proposal_events` log records every transition.

**Session** (mutable shared canvas)
→ `lib/schema.ts` trade_sessions — full model in [`a-sessions.md`](./a-sessions.md).
Two-participant collaborative canvas at `/s/<code>`. Both sides edit their half live, poll every 2.5s, and both must Confirm to settle. An **open slot** session (`user_b_id IS NULL`) renders a QR for hand-off.

### How primitives relate

```
   Card  ─────reads────▶  Cards appear in wants / available / sessions / proposals
    │
    ▼ (productId / familyId)
 Wants + Available  ─powers─▶ picker source chips, matchmaking, shared-list URLs
    │
    ▼ (cards selected in builder)
 Trade Builder  ─send-as─▶  Proposal  ◀──promote──▶ Session
                             │                         │
                             │ Accept/Decline          │ Settle/Cancel
                             ▼                         ▼
                          Terminal                  Terminal
                          + community_events        + session_events
                          + Discord notification
```

Proposal ↔ session is bidirectional: a recipient can **promote** a pending proposal into a session ("Edit together"); the proposal goes to `countered`, a new session row carries both sides' cards. See [`b-proposals.md`](./b-proposals.md) for the transition + [`a-sessions.md`](./a-sessions.md) for the session side.

## State model — where does state live?

Five layers, from outermost to innermost:

| Layer | Examples | Lifetime | Docs |
|-------|----------|----------|------|
| **URL** | `?y=…&t=…` trade codec, `?propose=H`, `/s/CODE`, `?view=X` | one navigation | [`e-home-nav.md`](./e-home-nav.md), [`c-trade-builder.md`](./c-trade-builder.md) |
| **localStorage** | wants / available, `swu.signedInHint`, pricing prefs, filter prefs | across reloads | [`d-lists.md`](./d-lists.md), [`g-auth.md`](./g-auth.md) |
| **React context** | Auth, CardIndex, PriceData, Pricing, Drawer, Navigation | component tree | [`e-home-nav.md`](./e-home-nav.md) |
| **Hook module cache** | `useTradeDetail`, `useTradesList`, `useSession`, `useMyTrades` | tab lifetime | respective area pages |
| **Server (Postgres)** | users, trade_sessions, trade_proposals, guild_memberships, \*_events | durable | [`j-infra.md`](./j-infra.md) |

### URL is authoritative for navigation + intent

Every in-app navigation flows through `NavigationApi.toX()` ([`e-home-nav.md`](./e-home-nav.md)), which atomically writes URL + intent state + view mode. Direct `window.history.pushState` calls are forbidden by convention — they caused the intent-drift bug class that motivated the single-primitive refactor.

### localStorage is authoritative for pre-sync inventory

Wants + available live in localStorage first. On first sign-in with local items, `MigrationDialog` prompts the user to merge into their server account. After sign-in, `useServerSync` keeps localStorage and server in sync. See [`d-lists.md`](./d-lists.md) for the merge semantics.

### Contexts are read-through-only

No mutation goes through a context. Hooks wrap fetch + mutation logic and *expose* read values via context. `DrawerContext` is the exception — it owns a boolean + a tab hint because it has to coordinate writes from many views.

### Hook caches use SWR-style patterns

Every list hook (`useTradeDetail`, `useTradesList`, `useMyTrades`, `useSession`) uses a module-scoped cache keyed by id (`createKeyedCache`) or a singleton (`createSingletonCache`). Initial render reads from cache; background re-fetches on mount; mutations invalidate the affected key. The pattern kills loading flashes on return-navigation and is documented in [`b-proposals.md`](./b-proposals.md) (`useTradeDetail`) and [`a-sessions.md`](./a-sessions.md) (`useSession`).

## Data-flow patterns

Four patterns appear everywhere. If you're writing new code that mutates server state, you're probably writing one of these.

### Optimistic update + mutex + re-fetch

Used by `useSession.saveCards`, `useTradeDetail.mutate*`, and most hook mutations.

```
1. Flip mutationInFlightRef = true
2. Apply optimistic local state   ◀── user sees change immediately
3. POST to server
4. On success: overwrite local with server state
   On failure: fetchOnce() to re-hydrate canonical state
5. Flip mutationInFlightRef = false
```

The **mutex** matters because polling / background re-fetches would otherwise land between steps 2 and 3, visibly reverting the optimistic change. Every poll site checks the mutex before overwriting.

### Optimistic concurrency via `updated_at`

Every server-side state transition on `trade_proposals` / `trade_sessions` uses the same shape:

```sql
UPDATE trade_proposals
SET status = 'accepted', updated_at = now()
WHERE id = $1 AND status = 'pending' AND updated_at = $loaded_updated_at
```

If the WHERE loses, the caller handles it (return `already-resolved` or similar). See [`b-proposals.md`](./b-proposals.md) for the canonical pattern.

### Append-only event log

Both primitives keep a separate `*_events` table: `proposal_events`, `session_events`, `community_events`. Events are never deleted or mutated. Reused event types carry a `kind` discriminant in the JSON payload rather than adding enum values — this avoids schema migrations for UI-level distinctions (see `notified` / `created` reuse in [`a-sessions.md`](./a-sessions.md)).

### Dispatcher pattern for API routes

Every multi-action domain (sessions, trades, auth, me) has one `api/<domain>.ts` file that dispatches on `?action=X`. `vercel.json` rewrites translate pretty URLs (`/api/sessions/:id/invite-handle`) into the dispatcher form (`?action=invite-handle&id=:id`). This pattern exists because Vercel caps function count; consolidating under one file keeps us under the ceiling. Full rationale in [`j-infra.md`](./j-infra.md).

## Design system + visual invariants

### Color reservations (load-bearing)

These colors carry meaning and are not to be repurposed:

| Color | Meaning | Usage |
|-------|---------|-------|
| **emerald** | "your side" / offering | TradeSide offering panel, confirmation success |
| **blue** | "their side" / receiving | TradeSide receiving panel |
| **cyan** | "shared / live / in-flight" | Session badge, live trade CTA, unseen-edit banner |
| **gold** | "attention / pitched / priority" | Needs Response callout, pitched badge, primary CTAs, priority stars |
| **amber / crimson** | "balance imbalance" | TradeBalance color coding for imbalance direction |
| **red** | "destructive / terminal-negative" | Cancel buttons, declined badge |
| **purple** | "countered" | Countered state badge |

Documented in the `project_swutrade_invariants` memory. Violating these causes visual confusion — a green button in the trade builder reads as "your side," not "approve."

### State badges

The `BADGE_TONES` record in `src/components/HomeView.tsx` is the single source of truth for trade-row state visuals. Every TradeRow / MyTrades row resolves its badge through `stateBadgeSpec(state) → { label, tone }`. See [`e-home-nav.md`](./e-home-nav.md) for the full palette table.

### Layout rhythm

- **Two-panel pattern** — the whole trade model is "your side | their side." Balance strip below. Used in TradeBuilder, SessionView, TradeDetailView's peek.
- **Module dashboard** — HomeView is a grid of `<ModuleSection>` cards. Each module owns one subsurface (Trades, Wishlist, Binder, Communities). The section chrome is consistent (icon + uppercase tracking label + optional action link).
- **Drill-down with persistent Done** — SettingsView. Query-param routed. "Done" always returns to root regardless of depth.

### Mobile-vs-desktop

Both surfaces are first-class ([`feedback_mobile_desktop_parity`](./README.md) memory). Mobile gets priority attention because it's harder — touch targets, panel collapsing, kebab menus — not because desktop matters less.

## Deployment + release topology

Full details in [`j-infra.md`](./j-infra.md); the outline here.

### Branches

- **`beta`** — active dev branch. Feature work pushes directly; no PRs. CI runs on every push. Deploys to `beta.swutrade.com`.
- **`main`** — promoted from beta when stable. Deploys to production (`swutrade.com`).

### CI pipeline

Four jobs: `types/tests` → `anonymous e2e` → `deploy wait` → `auth e2e`. Auth specs run against the live Vercel preview (they need real Postgres + Discord APIs); anonymous specs run in the CI worker.

### Scheduled work

- **Price refresh** — GitHub Actions workflow (`refresh-prices.yml`) runs daily, fires a Vercel deploy hook to publish fresh TCGPlayer prices. Not a Vercel cron (the memory `project_swutrade_deploy` and `api/context.md` both claim it is — that's stale; flagged in [`j-infra.md`](./j-infra.md)).
- **Proposal expiry** — not scheduled yet. Proposals sit `pending` indefinitely; cron planned but not shipped. See NEXT.md queue.

### Rewrites are load-bearing

`vercel.json`'s rewrite list is how the SPA handles every URL shape. `/s/:id`, `/u/:handle`, `/api/sessions/:id/invite-handle` — none of these are real paths on disk; every one rewrites onto a dispatcher or `index.html`. Full table in [`j-infra.md`](./j-infra.md).

## Naming conventions

### File paths

- Backend: `api/` (functions) and `lib/` (shared server code). Never import `lib/` from browser.
- Frontend: `src/` with `components/`, `hooks/`, `contexts/`, `services/`, `utils/`, `persistence/`, `routing/`.
- Tests: `tests/api/*.test.ts` for API integration (Postgres-backed), `src/**/*.test.ts` for unit tests, `e2e/*.spec.ts` for anonymous + `e2e/*.auth.spec.ts` for authenticated Playwright.

### API dispatch

- Path: `/api/<domain>` (dispatcher) or `/api/<domain>/:action/:id` (rewritten)
- Query: `?action=<name>` (always) plus per-action params
- Method: GET for reads, POST for mutations, PUT for idempotent updates, DELETE for removal

### Event types

Session events: `created`, `edited`, `confirmed`, `cancelled`, `settled`, `expired`, `notified`. Proposal events: `created`, `delivered_ok`, `delivered_failed`, `edited`, `nudged`, `accepted`, `declined`, `cancelled`, `countered`, `expired`. Community events: `trade_accepted`, `member_joined`. Reused types carry a `kind` discriminant in payload.

### Preference registry scopes

`scope={self, peer, guild}` × `section={privacy, notifications, communication, membership}` × `type={boolean, enum}`. Resolver cascade: peer override → viewer self → registry default. See [`i-discord-bot.md`](./i-discord-bot.md).

## Key cross-cutting decisions

These are decisions that affected more than one subsystem. Listed newest-first; each has its own area-page entry with more context.

- **Unified `TradeRow` view layer** (Phase 5b) — Home's "My Trades" merges proposals + sessions into one stream via `useMyTrades`. State badge palette + row chrome identical regardless of underlying primitive. See [`b-proposals.md`](./b-proposals.md).
- **Ghost users as first-class** (Phase 5b) — `is_anonymous=true` rows with null `discord_id`, auto-generated `guest-XXXXX` handles. Enable anonymous QR flow without forking the session primitive. See [`g-auth.md`](./g-auth.md) + [`a-sessions.md`](./a-sessions.md).
- **Promote-to-session** (Phase 5b) — proposals and sessions are different storage shapes but one UX. Recipient can convert pending proposal → active session, inheriting both sides' cards. See [`b-proposals.md`](./b-proposals.md).
- **Lists promoted out of the drawer** (UX-A1, 2026-04-19) — `Your wishlist` + `Your binder` are now first-class Home modules, not drawer contents. Drawer stays for in-trade quick-edit. See [`d-lists.md`](./d-lists.md) + [`e-home-nav.md`](./e-home-nav.md).
- **Single NavigationApi** — every in-app navigation atomic through `nav.toX()`. Closed a class of URL/intent/view-mode drift bugs. See [`e-home-nav.md`](./e-home-nav.md).
- **Foundation contexts** (R1) — PriceData + CardIndex + Drawer contexts replaced per-view state + prop drilling. See [`e-home-nav.md`](./e-home-nav.md) + [`h-cards-pricing.md`](./h-cards-pricing.md).
- **Shared API client** (R3) — `src/services/apiClient.ts` with `ActionResult<T>` discriminated union. Every hook uses it. Status→reason mapping codified. See [`j-infra.md`](./j-infra.md).
- **Iron-session cookies** — not JWT. Server owns session state; cookie is an opaque session id. See [`g-auth.md`](./g-auth.md).
- **Function ceiling workaround** — dispatcher-per-domain + vercel.json rewrites. See [`j-infra.md`](./j-infra.md).
- **Public defaults + auto-enroll** (beta feedback, 2026-04-17) — new accounts default public; auto-enroll into bot-installed guilds. See [`f-community-profile.md`](./f-community-profile.md).
- **Private-thread-first proposal delivery** — when `TRADES_CHANNEL_ID` is set, proposals land in private threads not DMs. Consent-gated. See [`i-discord-bot.md`](./i-discord-bot.md) + [`b-proposals.md`](./b-proposals.md).

## Where to start by question

| I want to … | Read first |
|-------------|------------|
| …understand how a trade gets made end-to-end | [`c-trade-builder.md`](./c-trade-builder.md) → [`b-proposals.md`](./b-proposals.md) → [`a-sessions.md`](./a-sessions.md) |
| …add a new API endpoint | [`j-infra.md`](./j-infra.md) (dispatcher pattern) then area page |
| …work on the Discord bot | [`i-discord-bot.md`](./i-discord-bot.md) |
| …change a React context | [`e-home-nav.md`](./e-home-nav.md) |
| …debug a deploy or CI failure | [`j-infra.md`](./j-infra.md) |
| …understand card variants / pricing | [`h-cards-pricing.md`](./h-cards-pricing.md) |
| …change auth or user identity | [`g-auth.md`](./g-auth.md) |
| …touch wants / available / matching | [`d-lists.md`](./d-lists.md) |
| …change community / profile / settings | [`f-community-profile.md`](./f-community-profile.md) |

If you're not sure which area owns a file, `grep` the filename in `docs/wiki/` — the page that references it is the owner.
