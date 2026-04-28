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
// 2) Banner — 680×240 (17:6), wordmark only.
//
// Discord overlays the bot avatar onto the lower-left of the banner
// on the app page, so anything we paint there gets covered. We
// also DON'T repeat the icon's mark in the banner — the icon IS
// the SWU/TRADE wordmark now; doubling it would just be the same
// thing twice. So the banner becomes a single horizontal SWUTRADE
// wordmark with a tagline below — bigger, cleaner, more "this is
// a brand surface" than the in-app banner.svg which is sized for
// the cramped header strip.
// ---------------------------------------------------------------------------

const BANNER_W = 680;
const BANNER_H = 240;
// Discord overlays the cropped bot avatar onto the banner at the
// lower-left (~120px diameter, padded a few px from the edges). We
// keep the wordmark vertically centered on the canvas so the
// avatar's bottom-left footprint clips at most the descent zone of
// the "BUILD · SHARE · …" tagline, never the wordmark itself.
const WORDMARK_CX = BANNER_W / 2;

const bannerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_W}" height="${BANNER_H}" viewBox="0 0 ${BANNER_W} ${BANNER_H}">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0e1a"/>
      <stop offset="1" stop-color="#111627"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFD700" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#F5A623" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${BANNER_W}" height="${BANNER_H}" fill="url(#bgGrad)"/>
  <ellipse cx="${WORDMARK_CX}" cy="${BANNER_H / 2}" rx="280" ry="100" fill="url(#glow)"/>

  <!-- SWU TRADE wordmark, horizontally centered. Two contiguous text
       elements rather than one — keeps the gray/gold split that
       defines the brand. Sized so the full string fits well within
       the 680px width with breathing room either side. -->
  <g font-family="'Helvetica Neue', Arial, sans-serif" font-weight="900" font-size="68" letter-spacing="4">
    <text x="${WORDMARK_CX - 6}" y="125" text-anchor="end" fill="#e5e7eb">SWU</text>
    <text x="${WORDMARK_CX + 6}" y="125" text-anchor="start" fill="#F5A623">TRADE</text>
  </g>

  <!-- Tagline. Smaller, muted gray, sits below the wordmark. Not
       essential — purely a brand-finish that signals "this is a
       coordinated thing" vs "this is a placeholder banner." -->
  <text x="${WORDMARK_CX}" y="170" text-anchor="middle"
        font-family="'Helvetica Neue', Arial, sans-serif" font-weight="600" font-size="15"
        letter-spacing="3" fill="#9ca3af">
    BUILD · SHARE · SETTLE STAR WARS UNLIMITED TRADES
  </text>
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

