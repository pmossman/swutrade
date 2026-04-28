/**
 * Renders Discord-ready PNG assets for the SWUTrade bot's app page.
 *
 * - `public/bot-avatar.png` (1024×1024, 1:1) — drag into the
 *   Developer Portal as the App Icon. Discord crops bot avatars to a
 *   circle; design fits within the safe-circle area.
 * - `public/bot-banner.png` (680×240, 17:6) — drag into the
 *   Developer Portal as the App Banner.
 *
 * Both render at full-bleed `#0a0e1a` (the app's `space-900`) so the
 * Discord install dialog and app page read as part of the same
 * brand surface as swutrade.com.
 *
 * The avatar reuses `public/favicon.svg` directly (its 100×100 viewBox
 * scales cleanly to 1024). The banner is purpose-built inline here
 * because `public/banner.svg` is 9:2 (designed for an in-app header
 * strip) — Discord wants 17:6, so we re-lay-out the same logo + word-
 * mark with breathing room.
 *
 * Run: `npm run render:bot-assets`
 *
 * Spec source — Discord 2024 portal, recorded for posterity:
 *   App Icon  — 1024×1024 (1:1), PNG/GIF/JPG/WEBP, ≤10MB
 *   App Banner — 680×240 (17:6), PNG/GIF/JPG/WEBP, ≤10MB
 */

import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');

// ---------------------------------------------------------------------------
// 1) App icon — 1024×1024 stacked "SWU / TRADE" wordmark.
//
// Why a wordmark not the favicon's card-pair:
//   - Discord crops avatars to a circle and renders them as small as
//     ~24px in chat. The card-pair art is intricate at that size; the
//     wordmark is identifiable.
//   - Discord's app page lays the avatar OVER the banner; if both
//     surfaces showed the card-pair the banner would just be a
//     bigger version of the avatar. The banner now leans pure
//     wordmark, the avatar becomes the brand monogram, and the two
//     are visually distinct.
//
// SWU above (gray) / TRADE below (gold) — same colour split as the
// inline wordmark on swutrade.com. Sized so both lines fit inside
// Discord's safe-circle radius (≈ 440u within 1024u canvas).
// ---------------------------------------------------------------------------

const ICON_SIZE = 1024;
const ICON_BG = '#0a0e1a';

const avatarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFD700" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#F5A623" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Solid navy fill. Discord crops to a circle so corner pixels
       fall outside the visible disc; doesn't matter that they're
       square. -->
  <rect width="${ICON_SIZE}" height="${ICON_SIZE}" fill="${ICON_BG}"/>

  <!-- Faint gold aura behind the wordmark — same brand cue the
       favicon uses (balance-point glow), kept subtle so the text
       reads first. -->
  <circle cx="${ICON_SIZE / 2}" cy="${ICON_SIZE / 2}" r="380" fill="url(#glow)"/>

  <!-- SWU on top, TRADE below. Both centered horizontally via
       text-anchor=middle. Baselines tuned by eye so the line of
       symmetry between them sits at the canvas vertical centre.
       Font sizes chosen so the wider word ("TRADE") fills the
       safe-circle chord without tracking compression. -->
  <g font-family="'Helvetica Neue', Arial, sans-serif" font-weight="900" text-anchor="middle">
    <text x="${ICON_SIZE / 2}" y="490" font-size="280" letter-spacing="14" fill="#e5e7eb">SWU</text>
    <text x="${ICON_SIZE / 2}" y="780" font-size="240" letter-spacing="8" fill="#F5A623">TRADE</text>
  </g>
</svg>`;

renderPng({
  svg: avatarSvg,
  width: ICON_SIZE,
  outFile: 'bot-avatar.png',
});

// ---------------------------------------------------------------------------
// 2) Banner — 680×240 (17:6), wordless brand surface.
//
// The icon already carries the SWU/TRADE wordmark, and Discord
// overlays the cropped icon onto the banner's lower-left on the app
// page — so any text on the banner would (a) duplicate the icon and
// (b) risk being clipped by the avatar overlay. Instead we paint a
// purely graphical surface that reads as "SWUTrade aesthetic"
// without saying anything:
//
//   - Deep-navy field (matches space-900 / favicon background).
//   - A scattered starfield — subtle, just enough to evoke the
//     Star Wars setting without literally using SW iconography.
//   - A warm gold "balance point" glow centered slightly right of
//     middle. The balance metaphor is the app's core: two sides
//     converging on a single equilibrium. The glow lives where the
//     avatar overlay won't touch it, so the icon-on-banner
//     composition keeps both pieces legible.
//   - Two faint side-glows (cool-left, warm-right) hinting at the
//     two sides of a trade meeting at the balance point. These are
//     dim enough to read as "atmosphere" rather than "two
//     competing focal points."
// ---------------------------------------------------------------------------

const BANNER_W = 680;
const BANNER_H = 240;

// The bright balance-point sits a touch right of center so it
// (a) draws the eye away from the avatar overlay zone in the
// lower-left, and (b) creates a slightly off-axis composition
// that feels less rigid than dead-center symmetry.
const FOCAL_X = BANNER_W / 2 + 40;
const FOCAL_Y = BANNER_H / 2;

// A small, deterministic starfield. Hand-laid (not random per
// build) so re-renders produce identical PNGs — keeps the asset
// stable in source control.
const STARS: Array<{ x: number; y: number; r: number; o: number }> = [
  { x: 60,  y: 40,  r: 1.2, o: 0.55 },
  { x: 130, y: 90,  r: 0.8, o: 0.35 },
  { x: 210, y: 30,  r: 1.0, o: 0.50 },
  { x: 90,  y: 170, r: 0.7, o: 0.30 },
  { x: 280, y: 115, r: 0.9, o: 0.40 },
  { x: 350, y: 55,  r: 1.4, o: 0.65 },
  { x: 470, y: 35,  r: 0.8, o: 0.35 },
  { x: 540, y: 90,  r: 1.1, o: 0.55 },
  { x: 590, y: 175, r: 0.7, o: 0.30 },
  { x: 620, y: 50,  r: 0.9, o: 0.45 },
  { x: 410, y: 195, r: 0.6, o: 0.25 },
  { x: 250, y: 200, r: 0.8, o: 0.35 },
  { x: 180, y: 145, r: 0.5, o: 0.20 },
  { x: 510, y: 145, r: 0.6, o: 0.25 },
  { x: 30,  y: 110, r: 0.9, o: 0.40 },
];

const bannerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_W}" height="${BANNER_H}" viewBox="0 0 ${BANNER_W} ${BANNER_H}">
  <defs>
    <!-- Subtle vertical gradient: top space-900, bottom slightly
         lifted to space-800. Keeps the dark surface from feeling
         flat. -->
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0e1a"/>
      <stop offset="1" stop-color="#111627"/>
    </linearGradient>

    <!-- The balance-point glow — warm gold that fades to fully
         transparent. Higher inner opacity than the icon's glow
         since it's the only focal element on this canvas. -->
    <radialGradient id="focal" cx="50%" cy="50%" r="50%">
      <stop offset="0%"  stop-color="#FFD700" stop-opacity="0.42"/>
      <stop offset="35%" stop-color="#F5A623" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#F5A623" stop-opacity="0"/>
    </radialGradient>

    <!-- Cool side-glow (left): emerald-tinted. Reserved palette
         for "one side of a trade" per design invariants. Kept
         very dim so it reads as atmospheric, not as a competing
         focal. -->
    <radialGradient id="leftGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="0"/>
    </radialGradient>

    <!-- Warm side-glow (right): mirrored gold. Also dim. -->
    <radialGradient id="rightGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#F5A623" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#F5A623" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Base navy field. -->
  <rect width="${BANNER_W}" height="${BANNER_H}" fill="url(#bgGrad)"/>

  <!-- Side glows: cool left, warm right. Painted before the
       starfield so stars sit on top of the haze. -->
  <ellipse cx="120"          cy="${BANNER_H / 2}" rx="200" ry="140" fill="url(#leftGlow)"/>
  <ellipse cx="${BANNER_W - 100}" cy="${BANNER_H / 2}" rx="220" ry="150" fill="url(#rightGlow)"/>

  <!-- Starfield. Sized small (≤1.5px) and dimmed via opacity so
       they read as ambient texture rather than discrete shapes. -->
  ${STARS.map(s => `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="#e5e7eb" opacity="${s.o}"/>`).join('\n  ')}

  <!-- The balance-point glow. Larger ellipse so the falloff covers
       most of the canvas's middle band, but with the bright core
       small enough to feel like a point of light, not a wash. -->
  <ellipse cx="${FOCAL_X}" cy="${FOCAL_Y}" rx="260" ry="120" fill="url(#focal)"/>

  <!-- Tiny bright core at the focal point — single pixel of
       gold-bright (#FFD700) at full opacity. This is the
       "balance point" itself; everything else is the glow
       around it. -->
  <circle cx="${FOCAL_X}" cy="${FOCAL_Y}" r="2.5" fill="#FFD700" opacity="0.95"/>
</svg>`;

renderPng({
  svg: bannerSvg,
  width: BANNER_W,
  outFile: 'bot-banner.png',
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function renderPng(opts: { svg: string; width: number; outFile: string }): void {
  const resvg = new Resvg(opts.svg, {
    fitTo: { mode: 'width', value: opts.width },
  });
  const png = resvg.render().asPng();
  const out = join(PUBLIC, opts.outFile);
  writeFileSync(out, png);
  const kb = (png.length / 1024).toFixed(1);
  console.log(`✓ ${opts.outFile} → public/${opts.outFile} (${kb} KB)`);
}

