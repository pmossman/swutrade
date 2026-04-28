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
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');

// ---------------------------------------------------------------------------
// 1) App icon — 1024×1024 from public/favicon.svg
// ---------------------------------------------------------------------------

const faviconSvg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');

// Wrap the favicon in a 100×100 navy fill so the rendered PNG has a
// deliberate dark background instead of transparency. Discord crops
// avatars to a circle, so the corner pixels get clipped — but the
// edges of the circle land in the same space-900 fill as the banner.
const avatarSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#0a0e1a"/>
  ${stripOuterSvg(faviconSvg)}
</svg>`;

renderPng({
  svg: avatarSvg,
  width: 1024,
  outFile: 'bot-avatar.png',
});

// ---------------------------------------------------------------------------
// 2) Banner — 680×240 (17:6) by scaling the existing public/banner.svg
//    (which is 720×160 / 9:2) to fit the width, then centering vertically
//    in the 240u canvas with the same dark-navy fill above and below.
//    This way the banner stays in lockstep with the in-app header strip
//    rather than diverging into a separately-laid-out brand surface.
// ---------------------------------------------------------------------------

const BANNER_W = 680;
const BANNER_H = 240;
const SOURCE_W = 720;
const SOURCE_H = 160;
const SCALE = BANNER_W / SOURCE_W;          // 0.9444
const SCALED_H = SOURCE_H * SCALE;          // 151.1
const Y_OFFSET = (BANNER_H - SCALED_H) / 2; // 44.45

const sourceBanner = readFileSync(join(PUBLIC, 'banner.svg'), 'utf8');

// Compose: outer 680×240 navy fill, banner.svg embedded scaled +
// translated. The inner banner.svg already paints its own #0a0e1a
// rectangle across its 720×160 viewBox, so the scaled strip blends
// seamlessly with the outer fill and the top/bottom bands read as
// the same continuous surface.
const bannerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_W}" height="${BANNER_H}" viewBox="0 0 ${BANNER_W} ${BANNER_H}">
  <rect width="${BANNER_W}" height="${BANNER_H}" fill="#0a0e1a"/>
  <g transform="translate(0 ${Y_OFFSET}) scale(${SCALE})">
    ${stripOuterSvg(sourceBanner)}
  </g>
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

/**
 * Strip the outer `<svg ...>...</svg>` wrapper from an SVG string so
 * the inner contents can be embedded inside a parent SVG. Used by the
 * avatar path so the favicon's defs + paths render against our own
 * navy background rect.
 */
function stripOuterSvg(svg: string): string {
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
}
