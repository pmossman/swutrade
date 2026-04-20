# SWUTrade v2 — Design Document

> **Status**: Phase 1 deliverable. Awaiting user review. No implementation until approved.
>
> **Audience**: the human reviewing this before approving code work, plus the agent writing that code. Self-contained.

---

## 1. Vision

SWUTrade v2 is a **pocket-sized trade deck** — the app you pull out across a table at a game store to swap cards with another human in under two minutes. It is not a web dashboard. It is a mobile-first tool shaped like the native apps people already trust on their phones: Apple Wallet's focused-card feel, Messages' thumb-reachable reply bar, Notes' almost-invisible chrome.

One noun (a **Trade**), one verb per screen, one reason to tap. Live, async, and solo — the three modes the current app expresses as separate products — are the *same* Trade in different states. Inventory (wants + binder) is always one tab away. Discord stays where it belongs: as the identity and notification layer, not as a vocabulary the user has to learn.

The app feels quiet. You open it, you see what matters right now, you finish the trade, you put the phone down.

---

## 2. Design principles

These are testable constraints, not platitudes. Each has a concrete failure mode I can point at.

1. **One primary action per screen.** If a reviewer can't name "the next tap" within two seconds of seeing the screen, the screen has failed. Primary actions live in the bottom third of the viewport in a single, visually dominant control. Secondary actions are muted or behind a disclosure.

2. **Progressive disclosure over dense layouts.** Surface the 80% case; tuck rarer affordances behind a long-press, a bottom sheet, or a detail view. A row with five inline buttons is worse than a row with one tap-target that opens a sheet with the same five actions.

3. **Gesture-native where gestures are natural.** Swipe-to-remove list rows, drag-to-reorder priorities, pull-to-refresh, bottom-sheet snap-to-dismiss. Never replace a button with a gesture the user can't discover; always *add* gestures as faster paths for the button action.

4. **Unify the three trade modes into one primitive.** The user never sees the words "proposal" or "session." They see "Trade" with a state badge (`Pitched`, `Shared`, `Settled`, `Declined`). Internal code can keep the two DB shapes; the UI treats them as one.

5. **Inventory is first-class, not a drawer.** Wants and binder are bottom-tab surfaces, as visible as Trades themselves. The user must never wonder "where did my list go?"

6. **Discord is auth + push, not UI.** The fact that notifications arrive via Discord is invisible in-app. We don't say "DM", we say "Message sent." We don't surface `communicationPref` enum choices; the default routes quietly and the user only sees Discord copy in Settings if they go looking.

7. **Thumb-reachable by default.** On a 375px × 667px viewport (iPhone SE baseline), every primary action must be reachable with the thumb of the hand holding the phone. That means no top-of-screen CTAs, no header actions, no left-edge destructive controls.

8. **Subtract, don't add.** For every new element the designer wants on a screen, we first ask: "Can we delete something already there instead?" If the answer is yes, we do that first and revisit the addition later — or never.

---

## 3. Core user journeys

Five journeys, ordered by frequency. Every design decision is validated against whether it makes these journeys faster.

### J1. Live in-person trade (the headline loop)

**Goal**: Alice and Bob are at the LGS. They want to swap cards using their phones. Neither wants to type a username.

1. Alice opens the app → lands on **Trades** tab (Home).
2. Taps the single FAB — **Start trade**.
3. **Start-trade sheet** slides up: QR code (primary) + "Invite by handle" (secondary, collapsed).
4. Bob points his phone camera at the QR → his phone opens `/s/<code>` → **Trade canvas** loads with an "Accept invite from @alice" banner.
5. Bob taps Accept → claims slot B → canvas is live for both.
6. Both tap **Add cards** on their side → card picker slides up → add cards → sheet dismisses.
7. Balance strip updates live at the bottom; "you owe $3.50" or "they owe $1.00."
8. Both tap **Confirm** (bottom action bar, gold).
9. Haptic thump on settle. Banner: "Trade settled. See you at the next store night."

**Tap count to shared canvas**: 3 (Alice) + 1 (Bob).
**Screens involved**: Trades, Start-trade sheet, Trade canvas, Card picker.

### J2. Async pitch via Discord

**Goal**: It's Tuesday night. Alice sees a card Bob has from his profile and wants to trade for it.

1. Alice opens app → **Community** tab → picks her LGS's server → sees Bob's row with "3 overlap" badge.
2. Taps Bob's row → **Profile (other)** page.
3. Hits **Trade with Bob** (bottom CTA).
4. Trade canvas opens pre-filled with a suggested balanced trade based on overlap.
5. Alice tweaks cards in the picker, adds an optional note via the **Message** affordance at the top of the action bar.
6. Taps **Send** → confirmation sheet shows the two sides + note → Alice confirms.
7. Bob gets a push (via Discord); taps it → lands on the same Trade canvas with a "@alice pitched this trade" banner and **Accept / Decline / Edit together** at the bottom.

**Tap count to send**: ~5 (assuming one card edit).
**Screens involved**: Community, Profile (other), Trade canvas, Card picker, Confirm sheet.

### J3. Solo calculator + share

**Goal**: Anonymous user wants to build and share a balanced trade before meeting someone at a store.

1. Lands on `/` while signed out → **Trades** tab shows a subdued "Start a solo trade" empty state + FAB.
2. Taps FAB → Trade canvas opens (no counterpart — solo mode). **A ghost user is minted and an open-slot session is created server-side at this moment.** The URL `/s/<code>` is live and shareable from the very first render; no deferred promotion step.
3. Adds cards on both sides via picker; balance + suggestion auto-update. Edits stream to the server via the same `editSessionSide` endpoint the live flow uses.
4. Taps **Share** (bottom-right of the action bar in solo mode) → system share sheet with the `/s/<code>` URL.
5. Pastes into Discord or iMessage.

The recipient can open the link at any point — even before step 4 — and claim slot B. The solo canvas *is* the open-slot session from second one; "share" is discoverability, not promotion. This resolves the race the review flagged (R1): there is no window in which the URL exists client-side but 404s server-side.

### J4. Curate inventory

**Goal**: User got home from a Prerelease, wants to record what they pulled.

1. **Cards** tab → segmented control on top: **Binder** (active) / Wishlist.
2. Taps the FAB (Add card).
3. **Card picker** — search "Boba" → taps Boba Fett tile → picker auto-dismisses with a subtle toast "Added Boba Fett (SOR)." Qty is 1 by default; long-press the tile for "+3" quick stepper.
4. Swipe-left on any row to remove. Long-press a wishlist row to star it as priority.

### J5. Respond to an inbound trade

**Goal**: Push notification while you're at lunch.

1. Push tap → app opens straight to the Trade detail (inbound).
2. See counterpart avatar, two-side card preview (scrollable), balance, optional note.
3. Bottom action bar: one primary (**Accept**) + two secondary (Edit together · Decline).
4. One tap, settled, done.

---

## 4. Screen inventory

Twelve screens. Every one has a reason to exist: it serves at least one of the five journeys above, and there isn't a smaller screen set that could.

All mobile sketches below assume a 375px-wide viewport. Primary action lives in the bottom action bar unless noted.

### 4.1. Trades (Home)

**Purpose**: landing surface for signed-in users. The list of every in-flight trade, sorted by "needs your attention" first.
**Primary**: **Start trade** (FAB, bottom-right of content, cyan).
**Secondary**: Tap a row to open that trade.
**Tertiary**: Swipe-left to archive/cancel, long-press for multi-select cancel (gated behind a confirm).
**States**: empty (illustration + "You haven't traded yet — tap Start"), loading (skeleton rows), error (retry CTA), content (rows).

```
┌─────────────────────────────┐
│  Trades                     │ ← large title (iOS)
│                             │
│ ◉ @bob · Pitched you        │ ← attention-grabbing chip (gold)
│   Luke+2 ⇆ Thrawn           │
│                             │
│ ◉ @alice · Live             │ ← cyan chip
│   "Waiting on @alice to add"│
│                             │
│   @carlos · Settled 2h ago  │ ← quiet terminal
│   Vader ⇆ Leia+1            │
│                             │
│                             │
│        (content)            │
│                             │
│                    ┌────┐   │
│                    │ +  │   │ ← FAB
│                    └────┘   │
├─────────────────────────────┤
│ ⬢ Trades ▫ Cards ▫ Community ▫ Me │ ← bottom tab bar
└─────────────────────────────┘
```

### 4.2. Start trade (bottom sheet)

**Purpose**: the split point between live (QR) and async (handle search). One sheet, one obvious action per path.
**Primary**: the QR itself is the primary affordance (show to partner).
**Secondary**: "Invite by handle" collapsible row below the QR (expand → inline search).
**States**: fresh (QR + search); searching; handle picked (shows partner card + "Pitch trade" CTA).

```
Sheet (snap: half-height)
┌─────────────────────────────┐
│ ─                           │ ← drag handle
│                             │
│     ┌─────────────┐         │
│     │   ░ QR ░    │         │
│     │             │         │
│     └─────────────┘         │
│                             │
│  Point their camera here    │
│                             │
│  ─────────────────────      │
│  or                          │
│  🔍 Invite by handle  ⌄     │ ← tap to expand
└─────────────────────────────┘
```

Recent partners appear as chips under the handle search when expanded.

### 4.3. Trade canvas (`/s/:id`)

**Purpose**: the universal trade surface. Replaces proposal view, session view, and solo calculator. Its *state* drives its chrome.
**Primary (varies by state)**:

| Trade state | Primary action |
|---|---|
| Solo (no counterpart) | **Share / Invite someone** |
| Open slot (has QR) | QR + **Copy link** |
| Pitched (you sent) | **Cancel** (destructive, muted) |
| Awaiting (you received) | **Accept** (one tap, green) |
| Shared (both editing) | **Confirm** (gold) |
| Confirmed-by-you | "Waiting on @partner" (disabled) |
| Settled | "Settled" read-only banner |
| Cancelled/Declined/Expired | read-only banner with relevant copy |

**Secondary**: Add cards (per side), Message note (collapsible), Decline/Counter/Edit together (only in Awaiting state, sheet-gated).
**Gestures**: swipe-left on a card row to remove, long-press qty pill for quick stepper.

```
┌─────────────────────────────┐
│ ‹ Trade     @alice        ⋯ │ ← nav, counterpart, overflow
├─────────────────────────────┤
│                             │
│ You offer                   │ ← side label, muted
│ ┌─────────────────────────┐ │
│ │ [img] Luke Sky... × 2   │ │
│ │ [img] Thrawn     × 1    │ │
│ └─────────────────────────┘ │
│ + Add card                  │
│                             │
│ ─  $34.50 ⇆ $36.00  ▲$1.50 │ ← balance strip
│                             │
│ They offer                  │
│ ┌─────────────────────────┐ │
│ │ [img] Vader      × 1    │ │
│ └─────────────────────────┘ │
│                             │
│ (waiting for @alice to add) │
│                             │
├─────────────────────────────┤
│  [  Confirm trade  ]        │ ← bottom action bar (gold)
└─────────────────────────────┘
```

Desktop (≥ md): the two sides render side-by-side; nothing else changes.

#### 4.3.1. Pricing on the canvas

Pricing is load-bearing — variant selection can swing a card's value 10×, the negotiation percentage is a native part of how these trades get framed, and a silently-zero missing price corrupts the balance. One consistent pattern, not five:

**The balance strip is the pricing surface.** Collapsed by default: `$34.50 ⇆ $36.00 · ▲$1.50`. Tap to expand into a bottom sheet (`PriceSheet`) showing three controls and the per-card price breakdown:

```
Sheet (tap balance to open)
┌─────────────────────────────┐
│ ─                           │
│ Pricing                     │
│                             │
│ Mode:  [ Market ][ Low  ]   │ ← segmented
│                             │
│ Take at: [50][60][70][•80][90][100]  │ ← pill grid, active=accent
│                             │
│ ── You offer — $34.50 ──    │
│  Luke Sky (HS)   2 × $16.00 │
│  Thrawn          1 × $2.50  │
│                             │
│ ── They offer — $36.00 ──   │
│  Vader (HS)      1 × $36.00 │
│                             │
│ [ Apply ]                   │
└─────────────────────────────┘
```

- **Market vs Low toggle** lives in the sheet's first row. Not exposed on the canvas itself — it's a pricing knob, not a first-order trade action.
- **Percentage presets** (50/60/70/80/90/100) follow. Active pill uses `accent`. Free-typing is not offered (v1 proved the round-number discipline is worth more than flexibility).
- **Per-card unit price** renders inline on each row in the sheet as `qty × adjusted_unit_price`. The *canvas* row itself shows only card name + qty to stay scannable — full numbers live one tap away in the sheet. This is the "pattern, everywhere" rule the review called out.

**Missing prices.** If a card has no market/low data (`null` in the snapshot), its canvas row gets a `danger`-tinted left bar and an inline `No price` chip. The balance strip surfaces `N cards missing price` as a caption below the totals; tapping it opens the sheet scrolled to the offending rows, with a `[ Exclude from total ]` per-row action. Missing prices never silently contribute $0.

**Spread warnings.** When a card's market price exceeds its low by ≥25% *and* ≥ $0.50 (same double-threshold v1 settled on), an amber `Δ%` pill renders next to the qty in the sheet. Not on the canvas — it's diagnostic, not first-order. Tapping the pill shows both prices side by side.

**Persistence.** Mode + percentage persist via localStorage + (signed-in) server side on the user's profile. When a trade URL includes `?pct=` / `?pm=` (share from another user), those values win on load and are applied via the raw setters that don't overwrite the local preference — identical semantics to v1.

**Purpose**: find a card, add it. Nothing else.
**Primary**: tap tile = add with qty 1. Long-press = quick stepper.
**Secondary**: scope chips at top (All / Theirs / Overlap / Binder — contextual).
**States**: empty (search prompt), loading, results grid, no matches.
**Gestures**: swipe-down to dismiss.

```
┌─────────────────────────────┐
│ ×  Add to your side         │
│                             │
│ 🔍 Search cards             │
│                             │
│ [All] [Overlap 3] [Theirs]  │ ← scope chips (contextual)
│                             │
│ ┌───┬───┬───┐               │
│ │   │   │   │ ← card tiles  │
│ └───┴───┴───┘               │
│ ┌───┬───┬───┐               │
│ │   │   │   │               │
│ └───┴───┴───┘               │
└─────────────────────────────┘
```

### 4.5. Cards — Binder

**Purpose**: manage what you have.
**Primary**: Add card (FAB).
**Secondary**: tap row for detail/qty edit; swipe-left to remove.
**Tertiary**: segmented control (top) to flip to Wishlist.
**States**: empty (illustrated card-back + "Add the cards you have to trade"), loading, content, **ghost** (see below).

**Ghost user state.** Ghosts have no server-side wants/available rows (those tables key on real user ids, and the ghost merge path only rewrites *session* refs, not list data). The Cards tab for a ghost renders an `EmptyState` with a gold-tinted "Sign in to keep a list of your cards" CTA → Sign-in flow. Tapping the FAB is disabled; the tab is read-only + sign-in-prompt. This matches the brief's UX-A5 spirit — state transitions are visible, not silent — and avoids promising the user a local-only list that can't survive a browser clear.

```
┌─────────────────────────────┐
│ Cards                       │
│ [ Binder ][ Wishlist ]      │ ← segmented
│                             │
│ 🔍 Filter                   │
│                             │
│ ┃ [img] Luke Hyperspace × 2 │
│ ┃ [img] Thrawn        × 1   │
│ ┃ [img] Vader         × 3   │
│                             │
│                    ┌────┐   │
│                    │ +  │   │ ← FAB
│                    └────┘   │
└─────────────────────────────┘
```

### 4.6. Cards — Wishlist

**Purpose**: manage what you want.
**Primary**: Add card (FAB).
**Secondary**: tap row for variant restrictions (bottom sheet).
**Tertiary**: long-press to star as priority; segmented control to flip to Binder.
**Visual**: priority rows sort to top with a **visible gold star** rendered in the leading gutter of the row (not just position-based). The sort order provides grouping; the star provides the affordance readback — a user who long-pressed the row and didn't get obvious feedback wouldn't know the toggle fired. Starred rows also pulse their star once (300ms) on set, so the write is confirmed visually even when the sort position doesn't change (e.g., the row was already at the top).
**Ghost state**: same as Binder (§4.5) — read-only sign-in prompt.

### 4.7. Community

**Purpose**: see who in your LGS Discord servers has cards you want.
**Primary**: tap a member row → Profile (other).
**Secondary**: guild selector (top chips, only if user is in >1 guild).
**States**: no guilds (prompts to install bot); one guild (auto-selected); multiple guilds (top chip picker).

```
┌─────────────────────────────┐
│ Community                   │
│ ( Guild A )( Guild B )      │ ← only if >1
│                             │
│ 🔍 Find a member            │
│                             │
│ ● @bob         ✦ 3 overlap  │
│ ● @carlos      ✦ 1 overlap  │
│ ● @dani        — no match   │
│ ...                         │
└─────────────────────────────┘
```

### 4.8. Profile (mine) / Me tab

**Purpose**: identity + settings entry + sign-in state.
**Primary** (signed-in): **Edit handle** (prominent, header).
**Primary** (ghost): **Sign in with Discord** (full-width gold button).
**Secondary**: Settings link, Install bot on my server link, Sign out.
**Visual**: avatar, handle, joined-at, trade count.

### 4.9. Profile (other) (`/u/:handle`)

**Purpose**: see another player's public lists + start a trade.
**Primary**: **Trade with @handle** (bottom action bar, gold).
**Secondary**: segmented control — Wants / Binder.
**Tertiary**: their overlap with your stuff displayed as a small header pill.

### 4.10. Trade detail (inbound — legacy entry)

**Purpose**: when a user taps a push notification or an external link to a Trade they received, they land here — same primitive as the canvas but with a clear "you've been pitched a trade" framing and response actions.

**Note**: this is not a separate screen from the canvas. It's the **Trade canvas** in the "Awaiting" state with a distinctive top banner. Listed here explicitly because the journey arrives from outside the app and the affordances are response-focused rather than edit-focused.

**Primary**: **Accept** (gold, one tap).
**Secondary**: Edit together · Decline (in the overflow sheet, not the main bar).

### 4.11. Settings

**Purpose**: the less-visited stuff. Notifications, privacy, per-guild preferences, bot install link.
**Primary**: no primary — settings are a list of drill-down rows, each leading to its own detail screen.
**Pattern**: iOS-style `List > Detail` with back-swipe gesture. Each detail screen has its own Done.
**Sections**: Profile · Notifications · Servers · Trade preferences · About.

### 4.12. Sign-in (for ghost users)

**Purpose**: Ghost users who want to carry their trades over.
**Primary**: **Continue with Discord** (full-width gold).
**Secondary**: "Keep browsing as guest" (link, small).
**Visual**: one line explaining what signing in *does* ("Your current trade will move to your account") — the UX-A5 reassurance built in from day one rather than retrofitted.

---

## 5. Information architecture

### 5.1. Nav model

**Bottom tab bar** — always visible on mobile, always at the bottom:

1. **Trades** (default)
2. **Cards** (Binder + Wishlist segmented)
3. **Community**
4. **Me**

Four tabs. No more — every additional tab steals thumb real estate for tap-switching. Signed-out users see Trades and Cards only (Me collapses to a single "Sign in" button).

On desktop (≥ md), the tab bar flips to a left rail with the same four entries. Content centered, max-width 640px on list views, 960px on two-panel trade canvas.

### 5.2. URL shape

| Path | Screen | Notes |
|---|---|---|
| `/` | Trades | signed-in home |
| `/cards` | Cards tab (Binder default) | `?list=wishlist` flips the segment |
| `/community` | Community tab | `?guild=<id>` selects a guild |
| `/me` | Me tab | |
| `/settings` | Settings root | `/settings/:section` drills in |
| `/s/:code` | Trade canvas | universal — solo drafts, live sessions, async pitches all render here |
| `/u/:handle` | Profile (other) | |
| `/auth/callback` | OAuth return | |

**Eager server session creation** (resolves R1 from review-01): the instant the user taps the FAB to start a trade, we `POST /api/sessions/create-open` — mints a ghost (if anonymous), inserts the session row with slot B null, and returns the `/s/<code>` URL. The canvas mounts against that URL. There is no client-only draft state; the canvas is always server-backed. Consequences:

- The URL is shareable / QR-scannable from the first frame — the recipient never hits a 404.
- Offline-start is not supported in v1 — tapping the FAB requires a network call. Acceptable because the QR handoff is the primary live-trade path and QR scanning requires the scanner to be online anyway. Offline drafting queues behind the Phase 3 offline shell.
- Stale open-slot sessions accumulate when a user taps "Start trade" and abandons. We inherit v1's 14-day rolling TTL, which sweeps these — and solo drafts can be explicitly cancelled from the canvas.

### 5.3. State

Four layers, ordered by lifetime:

1. **URL** — current screen, trade canvas cards (for solo drafts), guild filter. Never more than needed for sharing.
2. **localStorage** — signed-in hint, draft card lists (for ghosts), UI preferences (price mode, percentage, set filters).
3. **React Query cache** — server data (trades, cards, profiles). Stale-while-revalidate with 30s default.
4. **Server (Postgres, shared with v1)** — durable state.

No React Context carrying mutable server state. Data-fetching via React Query only. Small UI-only singletons (current tab scroll position, dismissed banners, in-flight toasts) live in **Zustand** stores — see §7.5 for the rationale. Round 1 of the review caught a contradiction between this section and §7.5's earlier "no Zustand" claim; Zustand is allowed for UI-only shared state and is the explicit choice.

---

## 6. Design system primitives

### 6.1. Palette

Two groups: **action tones** (used by buttons, chrome, status chips when an action is required) and **state tones** (used by trade-state badges, which carry information orthogonal to any action). Round 1 review pushed back on a single-accent palette for trade state — badges carry info, and collapsing them loses that. Both groups below.

#### Action tones (7)

| Token | Role | Light | Dark |
|---|---|---|---|
| `bg` | canvas | `#FAFAF7` | `#0A0B0F` |
| `surface` | cards, sheets | `#FFFFFF` | `#15171C` |
| `border` | hairlines | `#E5E5E0` | `#26282F` |
| `fg` | primary text | `#0A0B0F` | `#F2F2ED` |
| `fg-muted` | secondary text | `#60636B` | `#8A8D95` |
| `accent` | primary CTA, active state, selection | `#D4A85A` (warm gold) | same |
| `danger` | cancel, decline, destructive | `#C04A3A` | `#D86255` |

#### State tones (5) — for trade-state badges

| Token | States it paints | Light | Dark |
|---|---|---|---|
| `state-shared` | `open-slot`, `shared` (a live/collab trade) | `#4A8FA8` (cool cyan) | `#6AB5CF` |
| `state-attention` | `pitched` (you sent, awaiting), `awaiting` (you received, needs response) | `#E29F35` (warm amber) | `#F5B447` |
| `state-settled` | `settled` | `#4A8C5A` (muted emerald) | `#6AAD7B` |
| `state-declined` | `declined`, `cancelled` | `#C04A3A` (muted red) | `#D86255` |
| `state-countered` | `countered` (proposal replaced by a counter or promoted to session) | `#8A5CB4` (muted purple) | `#A87ED0` |
| `state-neutral` | `expired`, archived | `#8A8D95` (muted gray) | `#60636B` |

State tones are restricted to badges + the single "attention" left-bar on home-list rows that need response. They never paint full surfaces — that's `surface`'s job — and they never drive primary actions (those use `accent`). This keeps state color informational, not decorative.

#### Side identity (your vs. their)

Resolving open question #1 from round 1 review: keep v1's emerald-vs-blue side dichotomy, but **as a muted tint behind the side label**, not full-panel chrome.

| Token | Role | Light | Dark |
|---|---|---|---|
| `side-yours` | "You offer" label background | `#E6F2EA` (pale emerald tint) | `#193326` |
| `side-theirs` | "They offer" label background | `#E0ECF4` (pale blue tint) | `#17283A` |

Panels themselves stay on `surface`; only the side-label chip receives the tint. A user scanning the canvas sees warm-green ↔ cool-blue at a glance without the panel chrome fighting the balance strip. Full-panel emerald/blue would compete with `accent` and `state-shared` — the muted tint buys glance-recognition at one-twentieth the visual weight.

**Dark mode is first-class, not a patch.** The system respects `prefers-color-scheme`. Manual toggle in Settings.

### 6.2. Typography

System font stack: `-apple-system, BlinkMacSystemFont, "SF Pro", "Inter", system-ui, sans-serif`. Matches the device's native feel on iOS and Android; Inter as the web fallback.

| Token | Size / weight | Usage |
|---|---|---|
| `display` | 28px / 700 | Trade canvas totals, hero moments |
| `title` | 22px / 600 | Screen titles, section heads |
| `body` | 16px / 400 | Primary text, list rows |
| `body-strong` | 16px / 600 | Row titles, CTA labels |
| `meta` | 13px / 400 | Timestamps, sub-rows |
| `caption` | 11px / 600 | Tab labels, small badges |

Line-height: 1.4 for body, 1.2 for headings. No custom tracking except on caption (small amount of positive tracking for legibility on tab labels).

### 6.3. Spacing

4px grid. Tailwind-style: `1`=4, `2`=8, `3`=12, `4`=16, `5`=20, `6`=24, `8`=32, `10`=40, `12`=48, `16`=64.

**Defaults**:
- Padding inside cards: `4` (16px)
- Gap between list rows: `0` (rows own their own padding; hairline border between)
- Screen margins: `4` (16px)
- Bottom action bar height: 56px (iOS tab bar baseline) + safe-area inset
- FAB: 56px diameter, positioned 16px from right edge, 16px above bottom tab bar

### 6.4. Component primitives (12)

Intentionally fewer than the 15 cap. Each has a single job. Compositions of these make every screen.

1. **`<Screen>`** — safe-area-aware wrapper, exposes a scroll container + reserved slot for a floating action bar.
2. **`<NavBar>`** — large-title on iOS, compact on scroll. Leading back, trailing overflow.
3. **`<TabBar>`** — bottom 4-tab. Fixed icons + labels. Active state uses accent.
4. **`<ActionBar>`** — bottom-pinned action strip with one primary + optional two secondaries. Handles keyboard offset.
5. **`<FAB>`** — floating action button.
6. **`<Card>`** — rounded surface (12px radius) with shadow in light mode, border in dark.
7. **`<Row>`** — list row. Leading avatar/thumb, title+subtitle, trailing action/chevron. Swipe actions configurable.
8. **`<Sheet>`** — bottom-sheet modal. Snap points (half, full). Drag-to-dismiss.
9. **`<Chip>`** — pill-shaped label/toggle. Three tones: neutral, accent, subdued.
10. **`<Segmented>`** — iOS segmented control (2–3 items).
11. **`<Stepper>`** — inline qty +/- control (compact).
12. **`<EmptyState>`** — centered layout: optional illustration, headline, one-line body, one CTA.

**Explicitly NOT primitives in v1**: toasts (use native), modals (use Sheet at full snap), popovers (long-press opens a Sheet instead — popovers are a web-dashboard pattern).

### 6.5. Motion

- **State transitions**: 150ms cubic-bezier(0.4, 0, 0.2, 1).
- **Sheet in/out**: 280ms with natural easing; drag rubber-bands on overscroll.
- **View transitions**: 220ms slide + crossfade (use native View Transitions API where available; Framer Motion shim elsewhere).
- **Haptics** (where available via `navigator.vibrate` or iOS safari): soft (10ms) on toggle/select; medium (20ms) on confirm; success (double-pulse) on settle; error (long) on rate-limit/failure.
- **No**: parallax, scroll-jacking, custom scroll momentum, confetti.

**Reduced motion.** Every transition above is gated on `prefers-reduced-motion: no-preference`. When the user has the OS flag set, Framer Motion springs collapse to 0ms (Framer's `useReducedMotion` hook), haptics suppress, and view transitions fall back to instant swaps. This is not "the app stops working on the OS's accessibility setting" — this is "the motion stops, the app keeps working." Tested explicitly in the Phase 1 Playwright suite with `page.emulateMedia({ reducedMotion: 'reduce' })`.

---

## 7. Tech choices

### 7.1. Frontend framework

**React 19 + TypeScript + Vite.** Non-negotiable per brief; also the right call — keeps build pipeline + language tooling identical to v1, and nothing about the v2 vision needs a framework swap.

### 7.2. Routing

**react-router v7** (formerly Remix). The v1 approach (query-param dispatch in a giant switch) works but fights the mobile tab-bar mental model, where the URL is the identity of the tab. A real router lets us treat each tab as a nested route with preserved scroll position per tab — an iOS default the user expects. React-router is ubiquitous and documented; rolling our own would be the wrong kind of cleverness.

### 7.3. Component library

**Radix primitives + Tailwind v4 + a small in-house component layer (the 12 primitives above).** Not shadcn/ui — its default aesthetic is explicitly web-dashboard (big padding, flat shadows, admin-console feel), and we'd end up overriding every component. Radix gives us accessibility and focus management for dialogs/sheets/menus; Tailwind gives utility-class velocity; our own 12 primitives give us the iOS feel without dragging in a visual tone we'd have to counter-style.

### 7.4. Styling

**Tailwind v4 + `tailwind-variants` for component variant props + CSS custom properties for the palette tokens.** The palette tokens are HSL-triples in `:root`, overridden in `.dark`. Tailwind consumes them as `bg-[--bg]`. This gives us ergonomic colors and zero-JS theme swap.

### 7.5. State management

**TanStack Query (React Query v5) for server state** + local `useState` / `useReducer` for per-component state + **Zustand for the handful of UI-only singletons** (dismissed banners, in-flight toast queue, tab-level scroll memory, onboarding-hint "seen" flags). No Redux, no jotai, no per-feature context providers. Server state is read via one query per screen; mutations invalidate keys explicitly. Optimistic updates happen per-mutation (React Query's `onMutate`). We get stale-while-revalidate, request deduplication, and offline-queue behavior for free.

**Why Zustand for the singletons** (and not React Query subscribers, refs-as-events, or custom emitters): the UI-only slots are small, persisted to localStorage in a couple of cases, and need to be read from component trees that don't share an ancestor. Zustand is 1.2KB, has a trivial API, and the alternatives either overload React Query's purpose (subscribers) or re-implement Zustand's primitives by hand (refs + emitters). The dependency is earning its place against a concrete list of call sites.

This replaces v1's home-rolled `createKeyedCache` / `createSingletonCache` patterns — the hand-rolled caches were fine but v2's scale of server-state touching components warrants the dedicated dependency.

### 7.6. Forms

**react-hook-form + zod.** v1 uses zod for persistence schemas; keeping it for forms too consolidates validation patterns.

### 7.7. Animation & gestures

**Framer Motion 11** + **@use-gesture/react**. Framer Motion for sheet transitions, shared-element morphs (card thumbnail → card detail), and spring-based drag physics. @use-gesture for the primitive swipe-to-dismiss rows (simpler than Framer's drag for that specific case).

This is ~80KB added to the bundle. That's the iOS-feel tax. The alternative is CSS-only which gets us 60% of the feel for 0KB but loses the spring physics on sheet dismiss and the shared-element transition on card-tile → card-detail. Worth the cost for the app's core impression.

### 7.8. Testing

- **Vitest** (unit + integration) — identical to v1. `tests/api` pattern preserved; new tests co-located with features in `app-v2/src/**/*.test.ts`.
- **Playwright** (e2e) — mobile-first viewport (Pixel 7, 393×851) as the CI default; desktop (1280×800) as a secondary smoke. Auth flow seeded via direct cookie injection (pattern carries over from v1's `e2e/helpers/auth.ts`).
- **Storybook** — *not* adopted in Phase 1. Revisit if component library grows.

**V1 test suite disposition.** The existing ~550 vitest + playwright tests stay where they are and keep running in v1's CI (`.github/workflows/ci.yml` unchanged). v2 adds its own tests under `app-v2/**` and `e2e/v2/**`, and extends the CI matrix with a v2-scoped job. **Nothing is ported by default.** When we touch a lib/ function from v2, we reuse the v1 integration test for that function — the lib is shared, the tests are shared. When we touch a component (all new under `app-v2/src/components`), we write a fresh v2 test. This avoids a porting tax that would dominate early implementation time for no user value; by Phase 4 cutover, the v1 Playwright specs that are feature-parallel with v2 get archived alongside v1's frontend.

### 7.9. PWA / offline / push

**Web Push lands in Phase 2**, not Phase 3 (resolves review-01 open question #3). Async pitches without push are a broken product — the whole point of an async trade is that the recipient gets pinged. We piggyback on `api/push.ts` + the new `push_subscriptions` table. Discord DM remains the fallback channel; Web Push is an additive second delivery path that fires in parallel.

**PWA shell + offline reads lands in Phase 3**, as originally planned. Installable to home screen, offline loads last-viewed screens from a service-worker cache. Write paths stay online-only; "you're offline" banners over stale reads. The pricing JSON files live in the offline cache too so the solo calculator works on a plane. Eager session creation (§5.2) means the *canvas* won't mount offline, but offline-first read of already-loaded trades is straightforward.

### 7.10. Accessibility

Accessibility is a first-class constraint, not a Phase 3 cleanup pass.

- **Reduced motion**: see §6.5. Every Framer spring / crossfade respects `prefers-reduced-motion`. Playwright emulation test covers the reduce path.
- **Focus management**: Radix primitives give us focus-trap + aria-modal on Sheet and Dialog by default. We verify at each sheet's integration test (focus returns to the trigger on dismiss).
- **Keyboard navigation**: the bottom tab bar is fully keyboard-operable on desktop (arrow keys move between tabs, Enter activates — WAI-ARIA `role="tablist"`). Trade canvas card rows are focusable (arrow keys between rows, Enter to open detail, Delete/Backspace invokes the swipe-remove action). Gestures are accelerators; keyboard users get every action via visible buttons.
- **Screen reader labels**: every icon-only button (FAB, overflow, segmented control) carries an `aria-label`. Sheets open with `aria-live="polite"` announcing their purpose. Balance strip updates announce the new total on every edit.
- **Color contrast**: palette tokens audited against WCAG AA (4.5:1 for body, 3:1 for large text) in both light and dark. State tones are AA-compliant against `surface`. Audit pinned in a Phase 1 unit test that parses the CSS custom properties and asserts contrast per pair.
- **Tap targets**: minimum 44×44 CSS pixels for every interactive element (Apple HIG baseline). FAB is 56×56, row tap zones include their full padding, segmented controls are 40px tall (under baseline, flagged — considering bumping to 44).

---

## 8. Data model additions

**v2 shares the Neon Postgres with v1.** Every addition is strictly additive. No column drops, no type narrowing, no enum removals.

### 8.1. Schema additions

| Addition | Table | Purpose | Migration risk |
|---|---|---|---|
| `users.merge_banner_dismissed_at timestamptz nullable` | users | UX-A5: one-shot "your ghost trade moved over" banner. Read by v2; untouched by v1. | None — additive, nullable. |
| `push_subscriptions` new table | new | Web Push endpoint storage (endpoint, p256dh, auth, user_id FK, created_at). v2-only. | None — new table. |
| Index `trades_user_updated_idx` | (review existing) | Ensure the "my trades" merge query is efficient without new indexes; spec audit during Phase 2. | None. |

**That's it.** Every other v2 feature runs on the existing schema by construction.

### 8.2. API additions

v2 gets its own Vercel project with a fresh 12-function budget. Planned layout:

| Function | Consolidates | Notes |
|---|---|---|
| `api/auth.ts` | OAuth + /me + logout | Same dispatcher pattern as v1. |
| `api/trades.ts` | Proposal + session read/write (unified surface) | The v2 client sees one URL shape `/api/trades/:id/*`; the handler branches on kind internally. |
| `api/me.ts` | Prefs + guilds + community + notifications | |
| `api/sync.ts` | Wants + available | |
| `api/sessions.ts` | Session-specific actions (claim, invite) | Kept separate because session lifecycle diverges enough from proposal lifecycle that folding into `trades.ts` would be a large switch statement with little shared code. |
| `api/bot.ts` | Discord interactions + events | Unchanged from v1 logic; reused. |
| `api/og.ts` | OG image renderer | |
| `api/push.ts` | Web Push send + subscribe | Phase 3. |

Total: 8 functions. Headroom to 12 preserved.

### 8.3. Unified Trade surface — client-side

Internally, the client treats proposals and sessions as one `Trade` type with a `kind: 'proposal' | 'session'` discriminant and a `state: TradeState` that spans both:

```ts
type TradeState =
  | 'draft'          // solo, client-only
  | 'open-slot'      // session, waiting for slot B (QR)
  | 'pitched'        // proposal pending, you're proposer
  | 'awaiting'       // proposal pending, you're recipient
  | 'shared'         // session active, both editing
  | 'settled'        // terminal ✅
  | 'declined'       // terminal (proposal)
  | 'cancelled'      // terminal
  | 'countered'      // terminal (with followup reference)
  | 'expired'        // terminal
```

The `useTrade(id)` hook fetches via `/api/trades/:id` and normalizes to `Trade`. The hook knows how to branch reads and writes based on `kind` but callers (components) never see `kind` — they see `state` and `primaryAction`.

This is the brief's "collapse proposals + sessions into one concept" rule, operationalized.

### 8.4. Discord/bot

No changes. `api/bot.ts`, `lib/discordBot.ts`, signature verification all move as-is. Message copy gets a refresh to match v2 vocabulary (Trade, not Proposal) but the wire format stays.

Peer prefs (the `communicationPref` override per counterpart) are deferred — v1's per-peer UI surface is complex and low-value for v2's core loop. Default thread-vs-DM stays; we remove the elaborate request/approval handshake and surface a single "Route to private threads" toggle in Settings instead.

---

## 9. What we're NOT building in v1

A conscious deferred/killed list. Every feature in the current app, with a verdict.

### Shipped in v2 Phase 1 (MVP)
- Discord OAuth + ghost users
- Trade canvas (unified — solo, live, async)
- QR handoff for live trades
- Card picker with scope chips (simplified — All / Theirs / Overlap)
- Binder + Wishlist tabs
- Trades home list
- Basic profile view (other)
- Shared trade lifecycle: create → edit → confirm → settle / cancel
- Proposal pitch flow (send via Discord) with Accept / Decline
- Confirm sheet before send (preview)
- Balance strip with pricing % + market/low
- Me tab minimal (handle, sign-out)

### Shipped in v2 Phase 2
- Community tab (guild directory only, no activity feed)
- Settings drill-down (notifications, server toggles, theme)
- My-profile editing
- Ghost → real merge reassurance banner (UX-A5)
- Overlap-based "Suggest a balanced trade" on profile (other)
- Counter-offer action on inbound trade
- **Web Push notifications** (pulled forward from Phase 3 per review-01)
- **Edit-in-place for pending pitches** (walked back from Killed per review-01 — see defense below)
- **Shared-list URLs** `?w=&a=` (walked back from Killed per review-01 — see defense below)
- **Bulk multi-select decline** on home list (walked back from Deferred per review-01 — see defense below)

### Shipped in v2 Phase 3
- PWA shell + offline reads
- Nudge action on outbound pitches (24h cooldown, same rules as v1)
- OG image parity

### Three kills walked back (review-01 R5)

Defending the reviewer's pushback:

**Edit-in-place for pending proposals.** My Phase 1 draft killed `EditBar` and told users to counter or cancel-and-repitch. The reviewer is right: a counter changes semantics (it forks a chain, the original goes to `countered` status), and cancel-and-repitch forces the recipient to re-read the entire pitch for a typo fix. Both are worse than a same-pitch edit in place. v2 Phase 2 ships edit-in-place via a pencil icon on the proposer's canvas view of a `pitched` trade, opening the same picker + balance + message-note shell the fresh compose uses. The Discord DM edits in place with the updated embed (v1 already does this via `editChannelMessage`).

**Shared-list URLs (`?w=&a=`).** I had these "replaced with `/u/:handle`", but `/u/:handle` requires a real user row. The reviewer flagged the legitimate no-account-yet use case: a player posts a list in Discord without signing up ("hey I'm looking for these — DM me"). v2 Phase 2 ships these as `/list?w=…&a=…` — a read-only landing that renders the decoded list with a "Start a trade" CTA that pushes the viewer into the normal flow. Anonymous publisher, anonymous-or-signed-in reader. Reuses v1's `urlCodec.ts` wholesale.

**Bulk multi-select decline.** The reviewer surfaced a real incident: a user rapid-declined 10 pitches at a meetup and hit Discord error 40003 (DM-open rate limit). v1's bulk-resolve coalesces proposer-notification DMs into one summary per proposer. Killing the feature re-opens that bug surface. v2 Phase 2 ships bulk-decline via long-press on a home-list row → multi-select mode → bottom bar shows `Decline N` with a single confirm. Routes through v1's existing `handleBulkResolve` — no new server code.

### Deferred past v1 (landed in v1; reconsider later)
- Thread consent matrix (`prefer`/`auto-accept`/`allow`/`dm-only`) — simplified to one global "Route to private threads" toggle in Settings
- Peer preference overrides per counterpart
- Counter-chain timeline visualization
- Popular-wants badges ("N others want this")
- Trending wants feed
- LGS admin / storefronts (was Phase 4 v2 in v1 roadmap; out of scope for this rewrite)
- Meetup-aware matching
- Variant restriction editor (the full editor; we ship a simpler "Any variant / this variant only" toggle in Phase 1, the full editor in Phase 2 if beta feedback demands it)

### Killed
- The four-bar mutex (EditBar / CounterBar / ProposeBar / AutoBalanceBanner) — replaced by a single contextual action bar driven by trade state. **Note**: edit-in-place functionality stays (see walked-back above); what's killed is the *four separate bar components*.
- Lists drawer as primary entry point — Cards tab replaces it
- Breadcrumbs on mobile — back gesture only
- Home's five-module dashboard — one list + one FAB
- Separate NavMenu + AccountMenu — collapsed into the Me tab + overflow per screen
- Solo/live toggle in trade builder — state is derived from the trade's nature, not user-chosen
- `?view=` query-param routing — real paths instead
- **Community activity feed** (`trade_accepted`, `member_joined` events rendered in Community tab) — killed per review-01 open question #6. v1 wiki audit already flagged it as retention theater; revisit only if post-launch demand surfaces.

---

## 10. Implementation phases

**Target**: Phase 1 is a single developer working as one continuous arc (per review-01 scope direction — context freshness beats artificial sub-phase gating). Post-MVP phases (2/3/4) keep the STOP-between-phases review gate from the brief.

### Phase 1 — MVP (the core loop) · one arc

Ships: `app-v2/` directory scaffolding, Vercel project wiring, auth, trade canvas, card picker, binder, wishlist, Trades home, QR live handoff, async pitch flow, bottom tab bar. No community, no settings drill-down, no push.

**Sub-phases (work plan, not review gates)** — these are still the seven ordered slices below, each with exit criteria, but the implementation agent treats them as one arc rather than pausing between sub-phases. Progress is posted to `docs/v2/progress.md` asynchronously:

| # | Scope | Exit criteria |
|---|---|---|
| 1a | Scaffolding + auth | `app-v2/` builds, deploys to new Vercel project, Discord OAuth works on preview, ghost users mint on open trade |
| 1b | Layout shell | Four tabs render + swipe between them; Screen/NavBar/TabBar/FAB primitives done; dark mode works; reduced-motion respected |
| 1c | Cards tabs | Binder + Wishlist show real data from /api/sync; Card picker opens as sheet and adds cards; ghost users see read-only + sign-in prompt |
| 1d | Trade canvas (solo) | `/s/:code` renders against a server-backed open session from tap-one; add/remove cards; balance strip; tap-to-expand price sheet; share → copy link works |
| 1e | Live trade | Open slot → QR render → counterpart scans + claims → both edit → both confirm → settle |
| 1f | Async pitch | Profile (other) → Trade with → composer → send → recipient sees inbound with Accept/Decline |
| 1g | Home list + polish | Trades tab aggregates everything; swipe-to-cancel; empty states; loading states; state-badge palette applied |

STOP before Phase 2 — wait for user approval to continue.

**End of Phase 1 user test**: a new user (never seen the app) can complete one live trade and one async trade without help.

### Phase 2 — Polish + parity · ~2 weeks

Ships: Community tab (directory, no activity feed), Settings drill-down, Profile editing, UX-A5 ghost-merge banner, counter-offer, suggest-a-trade, **Web Push**, **edit-in-place for pitched trades**, **shared-list URLs** (`/list?w=&a=`), **bulk multi-select decline**.

STOP before Phase 3.

### Phase 3 — Offline shell + polish · ~1 week

Ships: PWA shell, offline reads for recent trades + price catalog, nudge action, OG image parity.

STOP before Phase 4.

### Phase 4 — Cutover

See §10.5 below.

### 10.5. Cutover plan

Resolves review-01 R4. Each item below names the operational call; none are novel, but each needs an explicit decision before Phase 4 begins.

**URL compatibility.**
- `/s/<code>` paths from v1 must keep resolving. v2's `/s/<code>` is the same path serving the same data out of the same `trade_sessions` table, so the path is valid by construction on the v2 deploy. The cutover is a DNS change on `beta.swutrade.com`'s A/CNAME from v1's Vercel project to v2's — existing links bookmarked by users keep working without 301s or redirects.
- `/u/<handle>` same story — same path, same data.
- `?w=&a=` shared-list URLs are handled in Phase 2 via the new `/list` route, which we add to v2's rewrite table. Any Discord message in the wild with `?w=&a=` at the root lands on v2's Home, which detects the query params and redirects to `/list?w=&a=` (one-line rewrite rule). Old URLs continue to resolve.
- `/?view=*` legacy query params from v1 are silently ignored by v2's router (unmatched query params don't match any route; the app falls through to Home). Edge-case bookmarks to `/?settings=1` land on v2's Home, one tap from the correct destination. Acceptable fallback.

**In-flight state at cutover.**
- Pending proposals + active sessions outlive the cutover because they're server rows, not cached client state. A user who initiated a trade on v1 and opens the app post-cutover sees it on v2's home list (same `useMyTrades` merge query, different frontend rendering).
- The four-bar compose states in v1 (an in-progress `EditBar` the user didn't commit) don't survive — these live in client-side URL state only. Acceptable: these are unsaved drafts by definition.
- Bulk-resolve selections in v1 don't survive. Same reason. Also acceptable.

**Beta tester rollout.**
- Phase 1 MVP deploys to `next.swutrade.com` with SSO-protected preview (Vercel Protection on) during the implementation arc. I get first access; user dogfoods second.
- Phase 2 flips SSO off on `next.swutrade.com` for invited testers (Discord role-gated access list — reuse the bot's "beta" role if present, or a new one). 5–10 power users for 1–2 weeks.
- Phase 3 opens `next.swutrade.com` to any authenticated Discord user who has used v1 before (allowlist of `users.id` with activity).
- Phase 4 cutover happens after Phase 3 runs clean for one full trading week (Fri–Thu) with zero P0 bug reports.

**Fallback if v2 breaks post-cutover.**
- DNS rollback on `beta.swutrade.com` back to v1's Vercel project — ETA ~5 min (DNS TTL on the record is set to 300s in the week before cutover).
- v1 Vercel project is NOT deleted on cutover — stays warm for 90 days. Can accept traffic immediately if DNS rolls back.
- v2 data stays in the same Neon DB, so rollback preserves all trades made on v2. v1's UI reads the same rows; any v2-only columns are ignored by v1's typed reads.
- No schema breakage means rollback has no data story. The worst case is "the new UI is broken, we're back to the old UI, trades keep working."
- Phase 4 ships with a rollback-runbook in `docs/v2/runbook-cutover.md` that names the exact DNS record and the exact Vercel project link.

---

## 11. Risk register

Risks I'd want the reviewer to challenge or sign off on before I write a line of code.

### R1. Unified Trade abstraction hides real primitives → debugging pain

**Risk**: The client treats proposals and sessions as one `Trade`. When a bug crosses the boundary, the stack trace mentions `useTrade` but the bug is in the proposal-specific branch. A new dev has to mentally un-unify to debug.
**Mitigation**: The `kind` discriminant is present in every `Trade` object, logged in error payloads, and named in every switch statement comment. Internal test fixtures seed both kinds. A "show me the raw kind" toggle in dev-mode overlay.
**Accept level**: low-to-medium. The unified UI is load-bearing for the product vision; hiding it would surrender a key differentiator.

### R2. Apple-feel idioms don't translate to web

**Risk**: Bottom sheets, haptics, spring physics, segmented controls — they're lovely on iOS Safari, janky on Chrome on Android, absent on desktop. We could ship something that feels great for 40% of users and bad for the rest.
**Mitigation**: Test early on three devices (iOS Safari, Android Chrome, desktop Chrome). For each idiom: confirm it degrades gracefully (sheet → dialog, haptics → no-op, spring → linear ease). Set a quality bar "functional on desktop, delightful on mobile."
**Accept level**: medium. We ship mobile-first; desktop is a usable but not differentiating surface.

### R3. 2–3 week MVP is ambitious

**Risk**: Phase 1's scope is the full trade loop for one developer. Any rat-hole (Framer Motion edge case, Vercel project wiring, Neon shared-schema quirk) could push it to 4–5 weeks.
**Mitigation**: Ruthless Phase 1 cutting. If a sub-phase runs >3 days, we trim. Explicit "can ship without this" backlog is maintained in `progress.md`. Worst case Phase 1 delivers everything except async pitch (which slides to 2a), which still demonstrates the core experience.
**Accept level**: medium. The 2–3 week target is a constraint, not a commitment; shipping the right thing at 4 weeks beats shipping the wrong thing at 2.

### R4. Shared Neon schema + parallel beta.swutrade.com = data conflict

**Risk**: v1 is live on `beta.swutrade.com`. v2 writes to the same Postgres from `next.swutrade.com`. A v2 trade write that v1 doesn't expect (e.g., the `merge_banner_dismissed_at` column) is fine (v1 ignores it), but a race between a v1 and v2 session update on the same row could produce confusing intermediate states for users who straddle both apps.
**Mitigation**: Writes flow through existing domain functions (`lib/sessions.ts`, `lib/proposalResolve.ts`) unchanged. Optimistic concurrency via `updated_at` already guards cross-client races. v2-only columns are never read by v1. No renaming.
**Accept level**: low. The existing concurrency story already handles cross-tab race; cross-app is the same pattern.

### R5. Gesture discoverability

**Risk**: Swipe-to-remove, long-press-to-prioritize, pull-to-refresh — these are invisible to a first-time user.
**Mitigation**: First-run empty states include a tiny animated hint ("← swipe to remove"). Every gesture has a visible equivalent (a kebab menu, a button inside a detail view). A "Tips" link in Me tab lists all gestures.
**Accept level**: medium. Gestures are accelerators, not the only path.

### R6. Framer Motion bundle size

**Risk**: Framer Motion 11 adds ~80KB gzipped. On mobile first-paint this matters.
**Mitigation**: Code-split — the trade canvas and the sheet primitives lazy-load Framer. Landing on Home doesn't load it. Audit at end of Phase 1; if first contentful paint on 4G is >2s, revisit (swap to CSS + View Transitions).
**Accept level**: medium. Measurable; easy to revert if needed.

### R7. Deferring Community is risky — it's a retention surface

**Risk**: Community tab is thin in Phase 1 (placeholder) and lands in Phase 2. Users expecting their existing community features might bounce.
**Mitigation**: v1 stays on `beta.swutrade.com` throughout Phase 1 and 2 — users who want community features just stay on v1. The cutover in Phase 4 only happens after parity.
**Accept level**: low.

### R8. Resolved (round 1): side identity uses muted color tint behind labels

Originally risked a single-accent palette confusing side identity. Review-01 resolved this: v2 keeps v1's emerald-vs-blue dichotomy but as a muted tint behind the side label only (not full-panel chrome). See §6.1 "Side identity" table. Risk downgraded to **low** — we get glance-recognition without the chrome fighting `accent` or state badges.

### R9. The brief prohibits reading `src/components/*.tsx` for design input

**Risk**: I haven't read the component tree. Some invariant not captured in the wiki might bite — e.g., an edge case in the URL codec that my v2 URL shape breaks.
**Mitigation**: I've read `lib/schema.ts` (the source of truth for data shape). The wiki is deliberately thorough on invariants and tech debt. The implementation phases will surface specific gotchas as I hit them; if one is schema-invalidating, it escalates to a design-doc revision before proceeding.
**Accept level**: low. The wiki's discipline makes this unlikely to sting.

---

## Appendix — Open questions (resolved in round 1)

All six questions from the original draft resolved by review-01:

1. **Side-identity colors** → keep v1 dichotomy as muted tint behind labels (§6.1).
2. **Single accent vs multi-tone state palette** → two groups: action tones + state tones. State badges keep cyan/amber/emerald/red/purple/neutral (§6.1).
3. **PWA / push** → Web Push pulled forward to Phase 2; PWA shell + offline stays Phase 3 (§7.9).
4. **Two Vercel projects** → confirmed.
5. **react-router v7** → confirmed.
6. **Community activity feed** → killed (§9).

---

## Revisions — round 1

Tracking every change made in response to `docs/v2/review-01.md`. Each item names the revision id from review-01 and the section(s) touched.

### R1 — Solo → Live race resolved

Picked **eager server-session creation** (one of the two options the reviewer offered). Updated **§3 J3** to state that tapping the FAB creates the open-slot session immediately; the URL is shareable from frame one. Updated **§5.2** with the full consequences (no offline-start, rolling TTL sweeps abandonment, no client-only draft state).

### R2 — Pricing UX on canvas

Added **§4.3.1 Pricing on the canvas**. Balance strip is tap-to-expand into a `PriceSheet` containing market/low toggle, percentage presets (50–100 in 10s), and per-card unit-price breakdown. Canvas rows show only name + qty; full prices live one tap away in the sheet. Missing-price rows get a `danger` left bar + inline `No price` chip; the balance strip surfaces the missing count as a caption with a per-row `Exclude` action. Spread warnings render as amber Δ% pills in the sheet, not on the canvas. Persistence semantics mirror v1 (localStorage + URL-override via raw setters).

### R3 — State management contradiction resolved

**§5.3** and **§7.5** now agree: Zustand is allowed for UI-only singletons (dismissed banners, toast queue, tab scroll memory, onboarding-seen flags). Rationale added in §7.5 for why not React Query subscribers / custom emitters — the alternatives either overload React Query's purpose or re-implement Zustand by hand.

### R4 — Cutover plan

New **§10.5 Cutover plan** with five sub-sections: URL compatibility (DNS swap, old shared-list URLs redirected via rewrite), in-flight state (server rows survive; client-only drafts don't), beta-tester rollout (SSO → allowlist → open → cutover), fallback (DNS rollback in ~5 min, v1 Vercel project stays warm 90 days, no schema breakage means zero data story on rollback), runbook.

### R5 — Three kills walked back

Moved into **Phase 2 shipped** with explicit defending paragraphs in **§9**:

- **Edit-in-place for pending pitches** — reviewer's case accepted: counter changes semantics and cancel-and-repitch forces the recipient to re-read everything for a typo fix. Ships in Phase 2 as a pencil affordance on the proposer's canvas view.
- **Shared-list URLs (`?w=&a=`)** — reviewer's case accepted: `/u/:handle` requires a real user row, shared-list is the legitimate anonymous-publish path. Ships in Phase 2 as `/list?w=…&a=…`, a read-only landing using v1's `urlCodec.ts`.
- **Bulk multi-select decline** — reviewer's case accepted: killing it re-opens the Discord 40003 rate-limit bug it was built to prevent. Ships in Phase 2 via long-press → multi-select mode → single-confirm bottom bar. Reuses v1's `handleBulkResolve`.

### R6 — Minor gaps closed

- **Accessibility**: new **§7.10** covering reduced-motion (already gated in §6.5), Radix focus-traps, keyboard nav for the bottom tab bar + canvas rows, `aria-label` on icon-only buttons, WCAG AA contrast audit as a Phase 1 unit test, 44×44 tap-target minimum.
- **V1 test suite disposition**: added to **§7.8**. Nothing ported by default — v1 tests keep running in v1's CI; v2 adds its own under `app-v2/**` and `e2e/v2/**`. Shared `lib/*` functions reuse v1's integration tests. Archive v1 frontend specs alongside v1 frontend at Phase 4.
- **State-badge tone palette**: **§6.1** split into action tones (7) + state tones (5: `state-shared`, `state-attention`, `state-settled`, `state-declined`, `state-countered`, `state-neutral`). Named map for which state uses which tone.
- **Ghost user on Cards tab**: added to **§4.5** and **§4.6**. Ghosts see `EmptyState` with a gold "Sign in to keep a list" CTA; FAB disabled; tab is read-only + sign-in-prompt.
- **Priority star visibility**: **§4.6** now explicit — a starred row renders a visible gold star in the leading gutter (not just sort-to-top), plus a 300ms pulse on set so the write is confirmed even when the row didn't move position.

### Open-question resolutions (folded into body)

Removed the "awaiting" appendix. Six questions became concrete design calls:
- **§6.1** now carries the emerald-vs-blue side tint + the multi-tone state palette.
- **§7.9** moves Web Push to Phase 2.
- **§9** kills the community activity feed (was deferred).
- **§10** rewrote phase headers to match the confirmed Vercel-two-project + react-router v7 assumptions.

### Scope clarification

Review-01 told me to treat Phase 1's seven sub-phases as **one implementation arc** with no user-review gate between sub-phases. Applied in **§10**: sub-phase table is now labeled "work plan, not review gates"; the STOP rule applies only between Phase 1/2/3/4. Progress posted to `docs/v2/progress.md` async.

---

Awaiting review-02. Ready to answer follow-ups or revise again.
