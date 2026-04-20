# Review of `docs/v2/design.md` — round 1

Reviewer: user (with independent oversight from another agent). Strong document overall — vision is coherent, v1 audit findings are addressed by design, risk register shows self-awareness. Six items to revise before I approve implementation. Listed in priority order.

## Required revisions

### R1. Solo → Live promotion race condition

§5.2 says "Server session created lazily on first Invite / Pitch." But §3 J3 also says a recipient can open a solo-draft URL and claim slot B. These two statements create a race: if the recipient scans the QR / opens the link before the solo user has triggered any invite action, the session doesn't exist server-side, and they hit 404.

**Fix**: pick one of these and write it into §5.2 + §3 J3 explicitly:
- (a) Eager: server session row is created the moment the solo user adds their first card. URL is valid from that point.
- (b) Lazy: solo drafts are client-only; the "Share" CTA is the promote-to-server moment and only then does the URL resolve for anyone else.

Either is fine; the current design blurs both. State the decision, document the recipient-arrived-early state if applicable.

### R2. Pricing UX is absent

Pricing is load-bearing (variant selection swings price 10×, percentage slider is negotiation-native, missing-price alerts prevent $0 lines). §4.3 mentions "balance strip" but doesn't describe how the user interacts with price mode, percentage, variant-specific prices, or missing-price warnings.

**Fix**: add §4.3.1 "Pricing on the canvas" covering:
- Where market-vs-low toggle lives (Settings? Per-canvas menu? Not exposed?)
- Where the percentage slider lives (same)
- How variant prices surface per-card row (inline? tap to reveal?)
- What happens when a card has no price data (v1 renders a red-border row; what does v2 do?)
- How wide-spread warnings (market ≫ low) are conveyed, if at all

Apple-minimal doesn't mean "hide it"; it means "one pattern, everywhere." Pick the pattern.

### R3. State-management contradiction

§5.3: "No React Context carrying mutable state … UI-only shared state lives in single-purpose hooks with internal Zustand or similar."
§7.5: "No Zustand, no Redux, no jotai."

**Fix**: resolve. Either Zustand is allowed for UI-only singleton state (current tab, dismissed banners), or it isn't and you'll use refs + custom event emitters or React Query subscriptions. Document the actual choice.

### R4. Cutover / migration plan is one sentence

§10 Phase 4 is "v1 archived. Only happens with user approval and feature parity confirmed." That's not a plan.

**Fix**: add §10.5 "Cutover plan" addressing:
- **URL compatibility** — existing `/s/<code>` URLs from v1 must still resolve. DNS swap, 301 redirect, or share the domain?
- **In-flight state** — users with pending proposals at cutover moment. Do they complete on v1 or v2?
- **Shared-list URLs (`?w=&a=`)** — these are in Discord messages in the wild. What happens to them? (See R5 — this connects.)
- **Beta testers** — do we roll 5 power users to v2 first, or cut everyone?
- **Fallback** — if v2 breaks post-cutover, what's the rollback path?

Doesn't need to be a novel — a bullet list per item. Just demonstrate you've thought about each.

### R5. Three kills I want defended or walked back

Each of these was in v1 for a specific reason. Your §9 deferred/killed list doesn't engage with the reasons. I want an explicit paragraph per bullet:

- **Edit-in-place for pending proposals (EditBar)** — "users counter or cancel-and-repitch instead." Counter changes semantics (and creates a counter-chain); cancel-and-repitch forces the recipient to re-read the whole thing for a typo fix. This regresses a real user flow.
- **Shared-list URLs (`?w=&a=`)** — anonymous-publish path for sharing wants/available in Discord without signing up. `/u/:handle` requires a server-side user row. Killing `?w=&a=` removes a legitimate low-friction use case (player posts "hey I'm looking for these, DM me" in a Discord channel without making an account). Consider keeping them as an alternate path to a read-only profile view.
- **Bulk multi-select resolve** — added in v1 after a real incident: a beta user rapid-declined 10 pitches at a meetup and hit Discord's DM rate limit (error 40003). The bulk endpoint coalesces proposer-notification DMs into one summary per proposer. Killing it re-opens that bug surface.

**Fix**: for each, either keep it in scope (with a note on which phase) OR write a paragraph explaining why the replacement is acceptable and acknowledging what's lost.

### R6. Minor gaps to close

Add these in-place, don't need new sections:

- **Accessibility** — one paragraph in §6 or §7. Reduced-motion handling for Framer spring physics. Focus trap + aria-modal for sheets (Radix gives you this but confirm). Semantic roles on custom gestures. Desktop keyboard nav for the bottom tab bar.
- **V1 test suite disposition** — §7.8 says "new tests co-located" but doesn't address the 547 existing vitest tests. Port selectively? Rewrite? Run both in CI during transition? State the plan.
- **State-badge tone mapping** — §6.1 defines `accent / attention / success / danger` as tones. §4.1 sketch shows "Pitched you" (gold) and "Live" (cyan) chips. But the palette has no cyan. Either expand the palette to include a "shared/live" tone or commit to using `accent` for everything and explain how Live vs Pitched are visually distinguished.
- **Ghost user on Cards tab** — §4.5 and §4.6 assume a signed-in user. Ghost users have no server-side wants/available. What does the tab render for them? (Empty + sign-in prompt? Session-derived draft cards? A bridge to sign-in-to-keep-this?)
- **Priority star visibility** — §4.6 mentions long-press to star. Confirm that a starred row shows a visible gold-star indicator after long-press (not just sorts to top). Without the visual affordance, users won't know it's a feature.

## Answers to your open questions (appendix in design.md)

1. **Side-identity colors (emerald/blue vs position-only)** — keep v1's dichotomy, but as a muted tint behind the label, not full-panel chrome. Symmetric position-only forces users to re-read the label every glance. Color is faster.

2. **Single gold accent vs multi-tone state palette** — compromise. Accent/attention/success/danger is fine for *actions*. But *trade-state badges* should keep more tones (at minimum: cyan=shared/live, gold=attention/awaiting, emerald=settled, red=declined/cancelled, neutral=expired). These carry information, not decoration. Add the tones to the palette.

3. **PWA / push in Phase 3** — accept Phase 3 for PWA shell + offline. **But ship Web Push in implementation Phase 2.** Async pitch without push is a broken product (the whole point is notification). If push absolutely can't make Phase 2, shorten Phase 2 and pull it forward.

4. **Two Vercel projects** — confirmed.

5. **react-router v7 vs custom** — react-router. 8 routes today → 12+ tomorrow → custom router becomes debt. Standard dep, zero invention budget spent here.

6. **Community activity feed — kill or defer?** — kill. The v1 wiki audit flagged it as retention theater. If demand surfaces post-launch, revisit.

## Scope

Your proposed implementation Phase 1 (the 7-subphase MVP: scaffolding → auth → shell → Cards → canvas → live → async → Home) is large but **I'd rather you keep it in one arc than break it into many.** Context freshness matters more than human-developer sprint realism — a single long implementation arc with full context beats a fragmented multi-phase plan where you re-load and re-orient each time.

**Keep the seven sub-phases as the work plan.** Just don't gate them behind user review — treat the whole MVP as one implementation pass, post progress updates in `progress.md`, and I'll check in asynchronously. The "STOP between phases" rule from the brief applies to implementation Phase 1 vs Phase 2 / 3 / 4 (polish / notifications / cutover), not to sub-phases within MVP.

## Next step

Revise `docs/v2/design.md` addressing R1–R6. Append a **"Revisions — round 1"** section at the bottom listing what changed and where. Then post a one-paragraph summary in `docs/v2/progress.md` and stop. I'll approve (or request round 2) from there.

No implementation code yet.
