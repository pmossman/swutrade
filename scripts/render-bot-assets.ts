/**
 * Renders Discord-ready PNG assets for the SWUTrade bot's app page.
 *
 * Two variants per asset, distinguished by accent palette so users
 * looking at install dialogs / chat avatars can tell which app
 * they're dealing with at a glance:
 *
 *   prod  — gold accent. Goes on app `1494200525778976871` (last
 *           three digits 871). The "real" SWUTrade.
 *   beta  — cyan accent + "BETA" badge on the icon. Goes on app
 *           `1494556915198590996` (last three digits 996). The
 *           dev/staging app pointed at beta.swutrade.com.
 *
 * Outputs:
 *   public/bot-avatar.png       (1024×1024) — prod icon
 *   public/bot-banner.png       (680×240)   — prod banner
 *   public/bot-avatar-beta.png  (1024×1024) — beta icon
 *   public/bot-banner-beta.png  (680×240)   — beta banner
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
// Variant palettes.
//
// `prod` is the canonical SWUTrade look. `beta` shifts the warm
// gold accents to cool cyan so the two surfaces are unambiguous in
// any side-by-side context — Discord install picker, server member
// list, chat avatars at 24px. The "BETA" badge on the icon adds a
// second redundant signal at sizes large enough to read it.
//
// Star Wars Unlimited's official palette stays gold; we deliberately
// step outside it for the beta variant because that's exactly the
// vibe — "this isn't the real one." Cyan is also distinct from the
// reserved emerald/blue (one side of a trade) and gold/amber/crimson
// (balance) palettes, so it can't be confused with an in-app role.
// ---------------------------------------------------------------------------

interface Palette {
  /** Hex for the bright "balance point" core dot in the banner +
   *  the brighter inner stop of the icon's aura gradient. */
  bright: string;
  /** Hex for the wordmark accent (TRADE) and the focal glow. */
  accent: string;
  /** Hex for the side-glow on the warmer half of the banner. */
  warmGlow: string;
  /** Hex for the side-glow on the cooler half. Always cool. */
  coolGlow: string;
}

const PALETTES: Record<'prod' | 'beta', Palette> = {
  prod: {
    bright:  '#FFD700',  // gold-bright
    accent:  '#F5A623',  // gold (the SWU primary chrome)
    warmGlow: '#F5A623',
    coolGlow: '#10b981', // emerald — hint of "trade sides"
  },
  beta: {
    bright:  '#67e8f9',  // cyan-300 — bright dev signal
    accent:  '#06b6d4',  // cyan-500 — readable at 24px
    warmGlow: '#06b6d4', // mirrored cyan, no warm tone in beta
    coolGlow: '#3b82f6', // blue — leans into the "cool, in-progress" feel
  },
};

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
// SWU above (gray) / TRADE below (accent). Sized so both lines fit
// inside Discord's safe-circle radius (≈ 440u within 1024u canvas).
// Beta variant adds a small "BETA" ribbon in the bottom-right corner;
// it falls outside the safe circle so it doesn't compete with the
// wordmark, but a portion peeks through at large render sizes.
// ---------------------------------------------------------------------------

const ICON_SIZE = 1024;
const ICON_BG = '#0a0e1a';

function buildAvatarSvg(variant: 'prod' | 'beta'): string {
  const p = PALETTES[variant];
  // The "BETA" ribbon. Lives just inside the bottom-right safe-circle
  // chord (~ 760, 760). Rendered as a rotated rounded-rect with text
  // so it reads as a "tag" applied to the icon, not part of the
  // brand mark itself. Empty string for prod.
  const betaBadge = variant === 'beta' ? `
    <g transform="translate(820, 920) rotate(-12)">
      <rect x="-110" y="-32" width="220" height="64" rx="6"
            fill="#06b6d4" opacity="0.92"/>
      <text x="0" y="14" text-anchor="middle"
            font-family="'Helvetica Neue', Arial, sans-serif"
            font-weight="900" font-size="44" letter-spacing="6"
            fill="#0a0e1a">BETA</text>
    </g>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${p.bright}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Solid navy fill. Discord crops to a circle so corner pixels
       fall outside the visible disc; doesn't matter that they're
       square. -->
  <rect width="${ICON_SIZE}" height="${ICON_SIZE}" fill="${ICON_BG}"/>

  <!-- Faint accent aura behind the wordmark — same brand cue the
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
    <text x="${ICON_SIZE / 2}" y="780" font-size="240" letter-spacing="8" fill="${p.accent}">TRADE</text>
  </g>${betaBadge}
</svg>`;
}

// ---------------------------------------------------------------------------
// 2) Banner — 680×240 (17:6), wordless brand surface.
//
// Stays wordless across both variants — the icon carries the SWU/
// TRADE text, and Discord overlays the cropped icon onto the
// banner's lower-left on the app page so any text would risk being
// clipped. The accent-color shift carries the "this is the beta
// app" signal without copy.
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

function buildBannerSvg(variant: 'prod' | 'beta'): string {
  const p = PALETTES[variant];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_W}" height="${BANNER_H}" viewBox="0 0 ${BANNER_W} ${BANNER_H}">
  <defs>
    <!-- Subtle vertical gradient: top space-900, bottom slightly
         lifted to space-800. Keeps the dark surface from feeling
         flat. -->
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0e1a"/>
      <stop offset="1" stop-color="#111627"/>
    </linearGradient>

    <!-- The balance-point glow — variant-accent that fades to fully
         transparent. Higher inner opacity than the icon's glow
         since it's the only focal element on this canvas. -->
    <radialGradient id="focal" cx="50%" cy="50%" r="50%">
      <stop offset="0%"  stop-color="${p.bright}" stop-opacity="0.42"/>
      <stop offset="35%" stop-color="${p.accent}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="leftGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${p.coolGlow}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${p.coolGlow}" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="rightGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${p.warmGlow}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${p.warmGlow}" stop-opacity="0"/>
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

  <!-- Tiny bright core at the focal point — single pixel of the
       variant's bright accent at full opacity. This is the
       "balance point" itself; everything else is the glow
       around it. -->
  <circle cx="${FOCAL_X}" cy="${FOCAL_Y}" r="2.5" fill="${p.bright}" opacity="0.95"/>
</svg>`;
}

// ---------------------------------------------------------------------------
// Render both variants. Output names match the existing prod files
// (so the Discord portal upload path is unchanged for prod) plus a
// `-beta` suffix for the dev variant.
// ---------------------------------------------------------------------------

renderPng({ svg: buildAvatarSvg('prod'), width: ICON_SIZE,  outFile: 'bot-avatar.png' });
renderPng({ svg: buildBannerSvg('prod'), width: BANNER_W,   outFile: 'bot-banner.png' });
renderPng({ svg: buildAvatarSvg('beta'), width: ICON_SIZE,  outFile: 'bot-avatar-beta.png' });
renderPng({ svg: buildBannerSvg('beta'), width: BANNER_W,   outFile: 'bot-banner-beta.png' });

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
