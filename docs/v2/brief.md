# SWUTrade v2 — Agent brief

You are the agent assigned to design and implement a streamlined rewrite of SWUTrade from the ground up. Read this file before doing anything else. It is self-contained — you do not need prior context from other conversations.

---

## Mission

Design and implement a streamlined, opinionated rewrite of SWUTrade. The current app works but sprawls — too many modules, too many bars, too many concepts competing for attention on one screen. Produce a new version that delivers the same **core value** with a **minimal, mobile-first, Apple-inspired** UI that never overwhelms the user. One primary action per screen. Progressive disclosure. Gesture-native. The design feel should be closer to iOS's native apps (Notes, Wallet, Messages) than to a web dashboard.

This is a **design-first rewrite** — you will produce a detailed design document BEFORE writing implementation code. The user reviews the design document before you proceed to code. **STOP after the design doc. Do not start implementation until the user approves.**

---

## What SWUTrade does (one paragraph)

SWUTrade is a trading tool for the Star Wars: Unlimited TCG. Users maintain a **wishlist** (cards they want) and a **binder** (cards they have), then work out trades with other users three ways: **solo** (a two-panel calculator with pricing), **async** (Discord-DM proposals with accept/decline/counter), and **live** (a shared canvas at `/s/<code>` where two people at a game store both edit the same trade on their phones). Discord is the identity layer and notification channel. The audience is hobbyists, many on mobile, often trading in person.

**For deeper context, read `docs/wiki/` in the repo** — start with `architecture.md` and `README.md`, then dive into area pages as relevant. The wiki is your canonical source for *what the app does* and *what constraints exist* (data model, Discord integration, ghost users, etc.).

---

## What's changing

You are NOT porting the UI. You are RE-IMAGINING it from the user's perspective:

- **One primary action per screen.** If a screen has five equally-weighted buttons, you've failed.
- **Progressive disclosure.** Show the 80% case; tuck the rest behind a clear affordance (long-press, sheet, detail view).
- **Mobile-first, touch-native, thumb-reachable.** Bottom-aligned primary actions. Gestures over buttons where natural (swipe to dismiss, pull to refresh, drag to reorder).
- **Apple-inspired.** Generous whitespace. One primary color. System typography feel. Meaningful motion. No competing visual hierarchies.
- **Fewer concepts exposed.** The current app shows you "proposals" and "sessions" as separate things. Your version might collapse them into one concept ("trades") and branch internally.
- **No feature bloat.** If a feature is present in the wiki but not load-bearing for the core loop, leave it out of v1 and note it in a "deferred" list.

The current app's UI is a **counter-reference**. Read its wiki to understand *what* it does, but DO NOT read its component source files for *how* — `src/components/*.tsx`, the current CSS, color palette, component organization, layout patterns are all explicitly out of bounds as design input. Your design should be derivable from first principles + the functional requirements, not from the existing implementation.

---

## Non-negotiables (hard boundaries)

1. **Discord as identity layer.** Discord OAuth stays. Ghost users (anonymous) remain first-class for the live-QR flow.
2. **Discord as notification channel.** DMs for proposals, threads where configured. The bot integration (`api/bot.ts`, `lib/discordBot.ts`) stays as-is unless clearly wrong.
3. **Three trade modes survive.** Solo calculator / async proposals / live sessions. How you surface them is open; the value they deliver is not.
4. **Hosting.** Vercel + Neon Postgres + Drizzle + iron-session cookies. These are cheap, known-good, and not the problem.
5. **Core data has to be migratable.** If you propose schema changes (and you may), any existing user's wants / available / proposals / sessions must survive the migration. Non-destructive additions are preferred; breaking changes require a migration plan in the design doc.

Everything else is on the table:

- **Frontend:** fully open. React + TypeScript + Vite stay. Component library, styling, state, routing — your call.
- **Backend API shape:** open. The current dispatcher-per-domain pattern exists because of Vercel's 12-function cap on the Hobby plan (see "Deployment target" below). If you want cleaner REST, factor the function-cap constraint into your design.
- **Schema:** open to additive changes. Propose them with migration notes. Breaking changes need the user's explicit approval in the design doc.
- **New endpoints, new tables, new indexes:** fine. Each one needs justification by a specific UX need, but you're not stuck with what exists.

---

## Deployment target

v2 deploys to its own Vercel project at a distinct subdomain (likely `next.swutrade.com` — user will provision this when you reach Phase 2).

Implications:
- **You get a fresh 12-function budget.** You are NOT sharing functions with v1. Design your API freely.
- **You share the Neon database** with v1. Your schema changes apply to the shared DB — coordinate carefully. Additive is safe; renames + drops are not.
- **You share Discord OAuth credentials** with v1 (same app; the user will register a second callback on the Discord app). User handles this when provisioning.
- **During Phase 0 / Phase 1:** develop locally only. No deploy target needed until Phase 2 implementation starts.
- **For the switchover:** v2 replaces v1 at `beta.swutrade.com` only when feature-complete + user-approved. Until then, v1 is untouched.

If you decide your v2 vision genuinely needs to share functions with v1 (e.g., you want to extend existing dispatchers rather than replace them), flag it in the design doc so the user can decide whether to stay on one project or go to two. Default assumption: two projects.

---

## What's in / out of scope

**In scope:**
- Full frontend rewrite — lives in `app-v2/` at the repo root (the existing app continues to serve at repo root until v2 replaces it)
- Backend API shape — new endpoints, consolidated or split per your design
- Schema additions + migrations (with justification)
- New routing model
- New component library choice

**Out of scope:**
- Discord bot interaction logic (`api/bot.ts`, `lib/discordBot.ts`, signature verification, slash commands) — keep as-is
- Pricing pipeline (`scripts/fetch-prices.ts`, card data enrichment) — stays
- CI/deploy plumbing at the Vercel-project level — user handles new project setup
- The v1 app itself — do not modify; it continues to serve beta users until you replace it

---

## Anti-patterns from the current app to AVOID

These are specific failures in v1, called out in its own audit docs (`NEXT.md` "UX audit 2026-04-19"). Do not recreate them:

- **Four "bar" components stacked as a mutex** above the trade builder (EditBar / CounterBar / ProposeBar / AutoBalanceBanner). One screen, one context.
- **A hidden drawer as the primary surface** for wants/available inventory. If inventory is load-bearing, surface it.
- **Mixed vocabulary response buttons** (Accept / Counter / Decline / Edit Together) that imply different primitives. Use one vocabulary.
- **Communities module competing with the trading loop** on Home. Features earn their placement by being on the core path.
- **Silent state transitions** (e.g., ghost → real user merge). If ownership of something changes, the user should feel it change.
- **Four-module dashboard Home.** If your Home has more than two primary surfaces, justify each.
- **Breadcrumbs on mobile.** Mobile users don't use them; they use back gestures.

---

## Your deliverables

### Phase 0: Immersion (do first, silently)

- Read `docs/wiki/README.md`, `docs/wiki/architecture.md`, and all ten area pages (A–J).
- Skim `NEXT.md` for the queued UX audit findings — they point at known failures in the current design.
- Read `lib/schema.ts` to ground yourself in the data model. You may read `lib/*.ts` (backend domain) for behavior; do not read `src/components/*.tsx` or `src/index.css` for design.
- Form an opinion. Take notes privately. When you surface your thinking in Phase 1, it should be from the user's perspective, not from the code's.

**At the end of Phase 0:** post one paragraph (≤200 words) — "here's what the current app does, here's what I think is broken about how it does it." Then proceed to Phase 1.

### Phase 1: Design Document (deliver to user for review — STOP here)

Produce `docs/v2/design.md` containing:

1. **Vision statement** (≤150 words) — the one-liner + the feel. What this app is, what it isn't.
2. **Design principles** (5–8 bullets) — concrete, testable. "Prefer one great action over three mediocre ones." Not platitudes.
3. **Core user journeys** (3–5) — the flows the app must serve effortlessly. For each: user's goal, steps, screens involved.
4. **Screen inventory** — every screen in the app, with: name + primary purpose, primary action (singular), secondary actions (capped), state variants (empty/loading/error/content), mobile-first sketch (ASCII or plain-text). Target 8–14 screens.
5. **Information architecture** — nav model, URL shape, persistent vs ephemeral state.
6. **Design system primitives** — color palette (5–8 colors), typography scale (4–6 sizes), spacing scale, component primitives (≤15), motion principles.
7. **Tech choices** — one paragraph each, justified: component library, styling, state management, routing, forms, animation, test strategy.
8. **Data model additions** — schema changes, new endpoints, new caches. Each justified by a UX need.
9. **What we're NOT building in v1** — explicit deferred-features list. Every v1-app feature + your verdict: shipped / deferred / killed.
10. **Implementation phases** — 3–6 phases, each independently shippable. Phase 1 is the MVP: smallest coherent app. Specify rough ordering + per-phase exit criteria. **Phase 1 must be shippable in 2–3 weeks by a single developer without shortcuts.**
11. **Risk register** — where this could go wrong: tech, design, scope risks. Name them so the user can veto early.

**STOP after Phase 1.** Do not write implementation code until the user has reviewed `docs/v2/design.md` and approved (or requested changes to) the plan.

### Phase 2+: Implementation (after approval only)

When the user says "proceed," work through the implementation phases from the design doc. For each phase:

1. Work on the `v2` branch (already forked from `beta`; the user will confirm it exists).
2. Put new code in `app-v2/` at the repo root — the existing app continues to serve at repo root. You are not replacing in place; you are building alongside.
3. Ship one screen at a time with its own tests (unit + one Playwright spec per user journey touched).
4. After each implementation phase, pause for user review. Do NOT barrel through to the next phase without explicit approval.
5. Keep a running `docs/v2/changelog.md` — one entry per phase shipped, listing what landed + known gaps.
6. Keep a short `docs/v2/progress.md` — running log + any open questions for the human.

---

## How to think while designing

- **Start with "what does the user feel?"** A user opens the app at a game store. What do they see? What's their next action? How many taps to the thing they came for?
- **Default to subtraction.** For every element you add to a screen, ask: "can I remove this and the screen still works?" If yes, remove it.
- **Test the one-hand thumb reach.** Primary actions live in the bottom third of the screen. Top is for glanceable info, not interaction.
- **Favor recognition over recall.** Users shouldn't have to remember which tab a thing lives on. If they know the word for what they want, it's one search / one gesture away.
- **Native feel > web feel.** No fake scrollbars, no hover-only affordances, no tooltips. If it doesn't work on a phone, it doesn't work.
- **Opinionated is better than flexible.** The current app offers split-vs-tabbed layout toggle. Pick one — let the user trust your choice.

---

## Success criteria

The design document is successful if:
- The user can read it in under 20 minutes and form a clear mental picture of the whole app.
- Every screen has a reason to exist.
- Every tech choice is defended, not assumed.
- The MVP phase is something a single developer could ship in 2–3 weeks without shortcuts.

The implementation is successful if:
- A new user lands on the app and completes their first trade without help or prompting.
- Every screen passes one-hand thumb-reach test on a 375px-wide viewport.
- Feature parity with v1's core value (solo calc + proposals + sessions) is reached by Phase 3 at latest.
- Zero console errors on anonymous + signed-in e2e smoke.

---

## Reporting back

- **End of Phase 0:** ≤200-word diagnosis paragraph. Then proceed to Phase 1.
- **End of Phase 1:** produce `docs/v2/design.md` and STOP. Do not ship code.
- **During Phase 2+:** after each sub-phase, commit + push, post a short update in `docs/v2/progress.md`, then wait for approval before continuing.

If you hit ambiguity that the wiki doesn't resolve, ask one focused question in `docs/v2/progress.md` and stop. Don't guess silently.

Begin.
