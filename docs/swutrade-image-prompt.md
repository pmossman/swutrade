# SWUTrade — Product Overview Image Prompt

*Copy/paste everything between the `===` lines into the ChatGPT image model.
The image model has no context about SWUTrade — every visual, label, and
colour needed to produce an accurate overview is in the prompt itself.*

---

===

Generate a single high-resolution product overview illustration for a web
app called **SWUTrade**. It's a trading-card trading platform for the
collectible card game **Star Wars Unlimited** (SWU). The image should
function as a polished product infographic / marketing hero that someone
could use on a landing page or a launch announcement — pleasing to look at,
information-rich, but not cluttered.

## Overall canvas

- Aspect ratio: **16:9 landscape**, ultra-wide acceptable (e.g. 2400 × 1350 or wider).
- Dark UI aesthetic: a deep near-black navy background (approx **#0a0e1a**) fading to a slightly lighter desaturated deep-purple-navy (approx **#111627**) vertically. Subtle star-field dust / nebula texture, sparse, never overwhelming.
- Overall feel: sci-fi trading terminal crossed with a modern fintech dashboard. NOT Star-Wars-trademarked iconography (no lightsabers, no Death Star, no characters) — SWU is inspired by Star Wars but the image should use a GENERIC space / sci-fi visual language so the illustration is safe and brand-neutral.

## Colour palette (use consistently)

- **Space navy** (#0a0e1a → #111627) — background gradient
- **Space-700 / 800** (#1a1f2e, #262d3f) — card panel fills
- **Gold** (#F5A623) — primary brand accent, logo highlights, bookmark icon, "priority" stars
- **Gold-bright** (#FFD700) — used sparingly for a single hero word, never as chrome
- **Emerald-500** (#10b981) — "Offering" side of every trade, "Binder", positive / have-cards signal
- **Blue-500 / cyan-400** (#3b82f6 / #22d3ee) — "Receiving" side, "Wishlist", live-session signal
- **Red-400** (#f87171) — danger / cancel only (minimal use)
- **Gray scale** (#e5e7eb primary text, #9ca3af secondary, #6b7280 tertiary) — typography

## Typography feel

- Clean geometric sans (Inter, Söhne, or similar).
- Section labels in **ALL-CAPS with wide letter-spacing**.
- Section headlines in bold weight.
- Keep body text minimal — this is a visual overview, not a manual.

## Overall layout

Divide the canvas into a **central hero stripe + six feature cards** arranged around it, like a product-tour poster. Approximate zoning:

- **Top-centre (hero band, ~25% height):** App identity + tagline
- **Three feature cards in a row below (main content, ~50% height):** the three surfaces a user touches most
- **Three smaller feature cards bottom row (~25% height):** secondary surfaces
- Optional: thin gold saber-bar accent stripes separating rows

Each feature card has:
1. A small UI mockup illustration (stylised, not pixel-perfect) representing that surface.
2. A bold section title.
3. 2–4 short bullet points as the feature list (tiny text is OK, even if slightly blurred — the visual is primary).

## Hero stripe (top)

**Left third:** A wordmark logo. Render the text "SWU" in light gray and "TRADE" in gold, both in the same tight geometric sans-serif, letter-spacing widened, maybe 64–80pt. A small "BETA" badge sits below-right of the wordmark in a gold-outline rounded-rect pill.

**Middle third:** One-line tagline in medium-weight white text: **"Balance every trade. In person or across the galaxy."**

**Right third:** A small sub-heading in uppercase tracked gray text reading **"LOCAL + DISCORD TRADING FOR STAR WARS UNLIMITED"**.

## Top row: three primary feature cards

Render three equally-sized cards left-to-right. Each card is a rounded-rectangle panel with a 1px gold/20-opacity border and a subtle inner gradient.

### Card 1 of 3: THE TRADE BUILDER

**Visual** — A stylised two-panel calculator UI:
- Split vertically into two coloured panels side by side.
- LEFT panel labelled "OFFERING" with an emerald accent stripe and emerald tint chip behind the label. Contains 3–4 small vertical card-art rectangles (stylised trading cards, portrait orientation, 5:7 ratio) stacked vertically with tiny price tags ("$12.40", "$3.20", "$47.99") on the right edge.
- RIGHT panel labelled "RECEIVING" with a blue accent stripe and blue tint chip. Same card stack, different prices.
- BETWEEN the panels: a horizontal "balance bar" showing a subtle arrow pointing emerald-ward with text "$8.37 TOWARD OFFERING". A gold slider labelled "85%" sits below it.
- TOP of the card: a small strip showing a share-icon, a split/tabbed toggle, and a "Lists" pill button.

**Title:** TRADE BUILDER

**Bullets:**
- Two-panel calculator — Offering (emerald) vs Receiving (blue)
- Live TCGPlayer pricing with percentage slider and market/low mode
- Variant-aware picker (Standard / Hyperspace / Showcase / Foil / …)
- Shareable URL — your trade survives reloads + paste anywhere

### Card 2 of 3: HOME DASHBOARD

**Visual** — A 2×2 grid of smaller sub-panels inside the card plus a third row, representing the signed-in Home view:
- Row 1: "MY TRADES" (a stack of two trade rows with gold "AWAITING" and emerald "SETTLED" pill badges) | "MY COMMUNITIES" (three horizontal rows with tiny Discord-server icons and trader counts)
- Row 2: "YOUR WISHLIST" (a vertical list of 3 card rows with a gold star on the first) | "YOUR TRADE BINDER" (a vertical list of 3 card rows with a small book icon in the label)
- Row 3: "YOUR TRADING PARTNERS" (a horizontal strip of 4 circular avatars with handles like "@alex", "@casey", "@pat", "@sam" and a small gold "Trade" pill next to each)
- Very top of the card: a gold-bordered alert strip reading "⏰ Needs your response · 2" — a pinned callout for pending proposals.

**Title:** HOME DASHBOARD

**Bullets:**
- Four parallel "my stuff" modules: Trades · Communities · Wishlist · Trade Binder
- Trading Partners row — bookmarked traders independent of Discord servers
- Pending-response callout pins urgent proposals at the top

### Card 3 of 3: SHARED LIVE TRADE

**Visual** — A stylised live-session canvas:
- At the top a cyan-accented identity strip showing two avatar circles connected by a short dotted line, with copy "Shared · both editing" in a cyan pill badge.
- Middle-left: a QR code rectangle (black and white checker pattern, no real data needed) with caption "SCAN TO JOIN" in tracked uppercase gold.
- Middle-right: the two-panel trade view (same emerald/blue split as the Trade Builder but smaller).
- Bottom: a prominent gold-bordered strip with a small lock icon and text **"🔒 YOU'VE CONFIRMED · WAITING ON @ALEX"**. Next to it, a gold outline button labelled "Unconfirm to edit" and a smaller red-outline "Cancel trade" button.

**Title:** SHARED LIVE TRADES

**Bullets:**
- QR-code invites — anyone scans, claims the open slot, both sides edit live
- Works with or without Discord — guests claim trades anonymously
- Mutual confirm-to-settle with explicit Unconfirm to re-edit
- Copyable URL fallback when a Discord DM can't reach the other side

## Bottom row: three secondary feature cards

Smaller than the top row. Same rounded panel treatment.

### Card 4 of 6: PROPOSALS

**Visual** — A stylised Discord-like DM thread: a rounded rectangle channel showing a trade-card embed with offering cards on one row and receiving cards below, followed by four button-bar buttons arranged in two groups:
- LEFT group (cyan tint, labelled "Move forward"): "Accept as-is" and "Edit together"
- RIGHT group (gray tint, labelled "Push back"): "Counter offer" and "Decline"

**Title:** FORMAL PROPOSALS

**Bullets:**
- Sent to recipients via Discord DM or a private trades-thread
- Accept · Counter · Decline · Edit together — grouped by intent
- Full activity timeline + nudge reminder if 24h idle
- Counter-offers flip sides automatically

### Card 5 of 6: COMMUNITIES + PROFILES

**Visual** — A two-column stack:
- LEFT: a "community directory" list showing 4 rows of avatar + handle + overlap chip like "You can offer 3 of 12"
- RIGHT: a profile card showing a large circular avatar, username "@alex", a "Trade with @alex" gold button, and a bookmark-outline icon toggle next to it ("Add to trading partners"). Below, two compact lists labelled "WISHLIST" and "BINDER" with 2 tiny card rows each.

**Title:** COMMUNITIES + PROFILES

**Bullets:**
- Per-guild member directories with overlap signals
- Public `/u/handle` profiles with shareable wishlist + binder
- One-tap "Trade with @X" · "Copy invite link" for Discord friends
- Favorites / trading partners independent of server enrollment

### Card 6 of 6: TWO-STATE USERS

**Visual** — Two side-by-side rectangular "states" with a double-headed gold arrow between them labelled "Sign in with Discord":
- LEFT rectangle, muted gray: an outline silhouette avatar inside a dashed-border frame, with the label **"GUEST"** and a short bullet list: "Build trades" / "Save lists locally" / "Claim shared-trade QR codes"
- RIGHT rectangle, gold-outlined: a filled colored avatar inside a solid-border frame, with the label **"DISCORD ACCOUNT"** and bullets: "Propose across communities" / "Matchmaking signals" / "Persist across devices"
- At the bottom, a tiny caption: "Ghost sessions seamlessly carry over when a guest signs in."

**Title:** TWO-STATE USER MODEL

**Bullets:**
- Either you're a guest or you're a Discord-signed-in user — no third state
- Guest trades follow you automatically when you sign in

## Composition notes

- Use real SWU-flavored card-art silhouettes that are GENERIC (no actual movie likeness, no trademarked characters). Think: stylised geometric spaceship cards, generic-faced human silhouettes, planet orbs — enough to convey "these are collectible trading cards" without infringing.
- Variant pills on card rows should be rendered with small text: "STANDARD", "HYPERSPACE", "SHOWCASE", "FOIL", "HS FOIL". Use distinct colour chips per variant (Hyperspace = light cyan, Showcase = amber, Foil = indigo, Standard = neutral gray).
- Keep the whole composition **readable at a glance** — if a feature is too small to read, prefer an iconic glyph over fake-looking text.
- Add a thin gold "SWUTRADE" watermark at the bottom-right corner along with a version tag "v-beta 2026.04".
- No photography. No real people. No actual Discord or Star Wars logos. No real card art.

Target output: one cohesive image that, at first glance, tells you "this is a two-sided trade calculator for a card game with live-trade sessions, Discord integration, and a dashboard of my trading life."

===
