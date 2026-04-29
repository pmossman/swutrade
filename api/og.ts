import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { inter_400, inter_700, inter_900 } from './_fonts.js';
// List-share decoders live in `lib/listShareCodec.ts` so the test
// suite can import them without pulling in the JSON data imports
// below (which are bundled at deploy time and absent in CI).
import {
  decodeWants,
  decodeAvailableRefs,
  type WantsRef,
  type AvailableRef,
} from '../lib/listShareCodec.js';
// Inlined at build time so the function never needs to self-fetch its own
// (potentially auth-walled) origin to resolve card names/prices.
import productIndex from '../public/data/product-index.json' with { type: 'json' };
import familyIndex from '../public/data/family-index.json' with { type: 'json' };
import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { cardSignals, wantsItems, availableItems, users } from '../lib/schema.js';
import { lookupSignalFamily, lookupSignalCard, type SignalFamily } from '../lib/signalMatching.js';

// resvg-js@2.6.2 only accepts font *file paths* (not buffers), so we write
// the inlined base64 fonts to /tmp on cold start and hand the paths to Resvg.
// /tmp is the only writable dir in Vercel functions and persists across warm
// invocations, so this happens at most once per instance.
const tmp = tmpdir();
const fontPaths: string[] = [];
for (const [name, b64] of [
  ['inter-400.ttf', inter_400],
  ['inter-700.ttf', inter_700],
  ['inter-900.ttf', inter_900],
] as const) {
  const p = join(tmp, name);
  try {
    writeFileSync(p, Buffer.from(b64, 'base64'));
    fontPaths.push(p);
  } catch (err) {
    console.error(`Failed to write ${name} to ${tmp}:`, err);
  }
}

interface CardInfo {
  n: string;  // name
  p: number | null;  // market price
  l: number | null;  // low price
  s: string;  // set name
}

type ProductIndex = Record<string, CardInfo>;

type FamilyEntry = { p: string; v: string; m: number | null; l: number | null; n: string };
type FamilyIndex = Record<string, FamilyEntry[]>;


// Fetched card images live here for the lifetime of the warm container so
// repeat renders of the same trade (or popular cards) don't re-fetch from
// TCGPlayer. Keyed by productId. Value is a base64 data URI ready to drop
// into `<image href="...">`, or null if the fetch failed (we cache misses
// too so we don't keep retrying broken IDs).
const imageCache = new Map<string, string | null>();

async function fetchCardImage(productId: string): Promise<string | null> {
  if (imageCache.has(productId)) return imageCache.get(productId)!;
  if (!productId || productId === '0') {
    imageCache.set(productId, null);
    return null;
  }
  try {
    const url = `https://product-images.tcgplayer.com/fit-in/200x279/${productId}.jpg`;
    const res = await fetch(url);
    if (!res.ok) {
      imageCache.set(productId, null);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
    imageCache.set(productId, dataUri);
    return dataUri;
  } catch {
    imageCache.set(productId, null);
    return null;
  }
}

function decodeCardRefs(param: string): { productId: string; qty: number }[] {
  if (!param) return [];
  return param.split(',').filter(Boolean).map(entry => {
    const [productId, qtyStr] = entry.split('.');
    return { productId, qty: parseInt(qtyStr, 10) || 1 };
  });
}

function formatPrice(price: number | null): string {
  if (price === null) return 'N/A';
  return `$${price.toFixed(2)}`;
}

// Colored-pill styling per variant, matching the app's variantBadgeColor.
// Returns null for Standard (no pill — it's the implicit baseline).
function variantBadgeStyle(variant: string): { bg: string; text: string } | null {
  switch (variant) {
    case 'Foil':            return { bg: '#312e8180', text: '#a5b4fc' };
    case 'Hyperspace':      return { bg: '#0c4a6e80', text: '#7dd3fc' };
    case 'Hyperspace Foil': return { bg: '#581c8780', text: '#d8b4fe' };
    case 'Showcase':        return { bg: '#78350f80', text: '#fcd34d' };
    case 'Prestige':        return { bg: '#701a7580', text: '#f0abfc' };
    case 'Prestige Foil':   return { bg: '#83184380', text: '#f9a8d4' };
    case 'Serialized':      return { bg: '#f5a62333', text: '#F5A623' };
    case 'Standard':
    default:                return null;
  }
}

function extractVariant(name: string): string {
  const match = name.match(/\(([^)]+)\)\s*$/);
  return match ? match[1] : 'Standard';
}

function extractBaseName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Truncate text to fit within a given width (approximate, in chars at 18pt)
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

type ResolvedCard = {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  price: number | null;
  imageDataUri: string | null;
};

// Layout constants — keep the math in one place
const COL_WIDTH = 540;
const LEFT_X = 36;
const RIGHT_X = 624;
const GRID_TOP = 185;        // top of the card grid area (under column header)
const GRID_BOTTOM = 615;     // bottom of grid (no footer anymore)
const GRID_HEIGHT = GRID_BOTTOM - GRID_TOP;
const CARD_ASPECT = 1.4;     // real card aspect (5:7 portrait) — no cropping

// Pick a grid layout that fits `count` cards in the available area.
// Each tile shows name → variant pill (if any) → price on separate
// lines so they can't overlap even at dense sizes.
function gridLayout(count: number): {
  cols: number;
  rows: number;
  tileW: number;
  imgH: number;
  tileH: number;
  nameSize: number;
  pillSize: number;
  priceSize: number;
} {
  const gap = 8;
  const candidates = [
    { cols: 4, nameSize: 13, pillSize: 10,  priceSize: 16 },
    { cols: 5, nameSize: 11, pillSize: 9,   priceSize: 14 },
    { cols: 6, nameSize: 10, pillSize: 8.5, priceSize: 13 },
    { cols: 7, nameSize: 9,  pillSize: 8,   priceSize: 12 },
    { cols: 8, nameSize: 8,  pillSize: 7.5, priceSize: 11 },
  ];
  for (const c of candidates) {
    const tileW = (COL_WIDTH - gap * (c.cols - 1)) / c.cols;
    const imgH = tileW * CARD_ASPECT;
    // 3-line text: name + pill + price with 2px gaps; pill ~ pillSize+3
    const textH = c.nameSize + 2 + (c.pillSize + 3) + 2 + c.priceSize + 4;
    const tileH = imgH + textH;
    const rowsAvail = Math.max(1, Math.floor((GRID_HEIGHT + 6) / (tileH + 6)));
    if (rowsAvail * c.cols >= count) {
      return { cols: c.cols, rows: Math.ceil(count / c.cols), tileW, imgH, tileH, nameSize: c.nameSize, pillSize: c.pillSize, priceSize: c.priceSize };
    }
  }
  const last = candidates[candidates.length - 1];
  const tileW = (COL_WIDTH - gap * (last.cols - 1)) / last.cols;
  const imgH = tileW * CARD_ASPECT;
  const textH = last.nameSize + 2 + (last.pillSize + 3) + 2 + last.priceSize + 4;
  const tileH = imgH + textH;
  const rowsAvail = Math.max(1, Math.floor((GRID_HEIGHT + 6) / (tileH + 6)));
  return { cols: last.cols, rows: rowsAvail, tileW, imgH, tileH, nameSize: last.nameSize, pillSize: last.pillSize, priceSize: last.priceSize };
}

function renderCardGrid(
  cards: ResolvedCard[],
  label: string,
  color: string,
  x: number,
): string {
  const total = cards.reduce((s, c) => s + (c.price ?? 0) * c.qty, 0);
  let svg = '';

  // Column header — saber-bar accent + label + total. Positioned
  // well below the balance section so there's clear breathing room.
  const headerBaselineY = 170;
  const saberTop = headerBaselineY - 14;
  const saberH = 20;
  svg += `<rect x="${x}" y="${saberTop}" width="3" height="${saberH}" rx="1.5" fill="${color}"/>`;
  svg += `<text x="${x + 12}" y="${headerBaselineY}" fill="${color}" font-size="16" font-weight="700" letter-spacing="2">${label.toUpperCase()}</text>`;
  svg += `<text x="${x + COL_WIDTH}" y="${headerBaselineY}" fill="#f3f4f6" font-size="20" font-weight="800" text-anchor="end">${escapeXml(formatPrice(total))}</text>`;
  svg += `<line x1="${x}" y1="${headerBaselineY + 10}" x2="${x + COL_WIDTH}" y2="${headerBaselineY + 10}" stroke="${color}" stroke-opacity="0.22" stroke-width="1.5"/>`;

  if (cards.length === 0) {
    svg += `<text x="${x + COL_WIDTH / 2}" y="${GRID_TOP + 80}" fill="#4b5563" font-size="16" text-anchor="middle">Empty</text>`;
    return svg;
  }

  const layout = gridLayout(cards.length);
  const maxVisible = layout.cols * layout.rows;
  const visible = cards.slice(0, maxVisible);
  const gap = 8;

  visible.forEach((card, i) => {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const tileX = x + col * (layout.tileW + gap);
    const tileY = GRID_TOP + row * (layout.tileH + 6);

    // Portrait aspect enforced — landscape leaders get center-cropped
    // to fit the portrait tile, keeping the grid visually uniform.
    if (card.imageDataUri) {
      svg += `<image href="${card.imageDataUri}" x="${tileX}" y="${tileY}" width="${layout.tileW}" height="${layout.imgH}" preserveAspectRatio="xMidYMid slice"/>`;
    } else {
      svg += `<rect x="${tileX}" y="${tileY}" width="${layout.tileW}" height="${layout.imgH}" fill="#1f2937" rx="3"/>`;
      svg += `<text x="${tileX + layout.tileW / 2}" y="${tileY + layout.imgH / 2 + 6}" fill="#4b5563" font-size="16" text-anchor="middle">?</text>`;
    }

    // Qty chip (top-right overlay, only when > 1)
    if (card.qty > 1) {
      const chipW = Math.max(22, layout.tileW * 0.3);
      const chipH = 16;
      const chipX = tileX + layout.tileW - chipW - 3;
      const chipY = tileY + 3;
      svg += `<rect x="${chipX}" y="${chipY}" width="${chipW}" height="${chipH}" rx="8" fill="#000" fill-opacity="0.85" stroke="${color}" stroke-opacity="0.7" stroke-width="1"/>`;
      svg += `<text x="${chipX + chipW / 2}" y="${chipY + 12}" fill="#fff" font-size="10" font-weight="800" text-anchor="middle">×${card.qty}</text>`;
    }

    // Metadata below image — matches the app's SummaryTile pattern:
    // name, optional variant pill, line total, all LEFT-ALIGNED so
    // the three stacked lines read as a coherent label column.
    const lineTotal = card.price !== null ? card.price * card.qty : null;
    const textTop = tileY + layout.imgH + 3;
    const nameMax = Math.max(8, Math.floor(layout.tileW / (layout.nameSize * 0.55)));
    const vbs = variantBadgeStyle(card.variant);

    // Line 1: card name
    const nameBaselineY = textTop + layout.nameSize;
    svg += `<text x="${tileX}" y="${nameBaselineY}" fill="#d1d5db" font-size="${layout.nameSize}" font-weight="500">${escapeXml(truncate(card.name, nameMax))}</text>`;

    // Line 2 (if non-Standard): variant pill, left-aligned
    const pillH = layout.pillSize + 3;
    let afterPillY = nameBaselineY;
    if (vbs) {
      const vlabel = card.variant === 'Hyperspace Foil' ? 'HS Foil' : card.variant;
      const pillTextW = vlabel.length * layout.pillSize * 0.6;
      const pillPadX = 4;
      const pillW = Math.min(pillTextW + pillPadX * 2, layout.tileW);
      const pillTopY = nameBaselineY + 3;
      svg += `<rect x="${tileX}" y="${pillTopY}" width="${pillW}" height="${pillH}" rx="2" fill="${vbs.bg}"/>`;
      svg += `<text x="${tileX + pillPadX}" y="${pillTopY + layout.pillSize + 0.5}" fill="${vbs.text}" font-size="${layout.pillSize}" font-weight="700" letter-spacing="0.3">${escapeXml(vlabel.toUpperCase())}</text>`;
      afterPillY = pillTopY + pillH;
    }

    // Line 3 (or 2 for Standard): line total, left-aligned gold
    const priceBaselineY = afterPillY + layout.priceSize + 2;
    const priceColor = card.price === null ? '#f87171' : '#d4a843';
    svg += `<text x="${tileX}" y="${priceBaselineY}" fill="${priceColor}" font-size="${layout.priceSize}" font-weight="700">${escapeXml(formatPrice(lineTotal))}</text>`;
  });

  if (cards.length > maxVisible) {
    const overflowY = GRID_TOP + layout.rows * (layout.tileH + 6) + 12;
    svg += `<text x="${x + COL_WIDTH / 2}" y="${overflowY}" fill="#9ca3af" font-size="12" font-weight="600" text-anchor="middle">+${cards.length - maxVisible} more</text>`;
  }

  return svg;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const y = (req.query.y as string) || '';
  const t = (req.query.t as string) || '';
  const w = (req.query.w as string) || '';
  const a = (req.query.a as string) || '';
  const signalGroupId = (req.query.signal as string) || '';
  const pct = parseInt((req.query.pct as string) || '80', 10);
  const pm = req.query.pm === 'l' ? 'low' : 'market';

  // Signal-post unfurl: composite card-image header for a signal
  // group, referenced from the embed's `image.url`. Discord fetches
  // it once per unique URL — status changes (cancel / expire) just
  // drop the field rather than re-render here.
  if (signalGroupId) {
    return renderSignalImage(req, res, signalGroupId);
  }

  // List mode: render a list image when there's no active trade.
  // Three variants:
  //   - wishlist-only  (w && !a)  → single-list layout titled "WISHLIST"
  //   - binder-only    (!w && a)  → single-list layout titled "TRADE BINDER"
  //   - combined       (w && a)   → two-column "SHARED LIST" (legacy)
  // The dedicated single-list variants ship with the Wishlist / Binder
  // split: each view shares only its own list, so the image should
  // reflect just that list with tailored copy + color + full-canvas
  // real estate instead of a half-empty "Available: Empty" column.
  if (!y && !t && w && !a) {
    return renderSingleListImage(req, res, 'wishlist', w, pct, pm);
  }
  if (!y && !t && !w && a) {
    return renderSingleListImage(req, res, 'binder', a, pct, pm);
  }
  if (!y && !t && (w || a)) {
    return renderListImage(req, res, w, a, pct, pm);
  }

  const index = productIndex as ProductIndex;
  const yourRefs = decodeCardRefs(y);
  const theirRefs = decodeCardRefs(t);

  // Fetch all card images in parallel — module-level cache means repeat
  // renders of the same trade hit warm cache and skip the network entirely.
  const allRefs = [...yourRefs, ...theirRefs];
  // Fetch up to a conservative per-side cap (matches the densest grid
  // layout which tops out around 28 tiles) so we have images for
  // anything the grid might render.
  const visibleIds = allRefs.slice(0, 60).map(r => r.productId);
  const imageMap = new Map<string, string | null>();
  await Promise.all(
    Array.from(new Set(visibleIds)).map(async id => {
      imageMap.set(id, await fetchCardImage(id));
    }),
  );

  const resolveCards = (refs: { productId: string; qty: number }[]): ResolvedCard[] =>
    refs.map(ref => {
      const card = index[ref.productId];
      const imageDataUri = imageMap.get(ref.productId) ?? null;
      if (!card) {
        return { productId: ref.productId, name: `#${ref.productId}`, variant: '', qty: ref.qty, price: null, imageDataUri };
      }
      const rawPrice = pm === 'low' ? card.l : card.p;
      const price = rawPrice !== null ? Math.round(rawPrice * pct) / 100 : null;
      return {
        productId: ref.productId,
        name: extractBaseName(card.n),
        variant: extractVariant(card.n),
        qty: ref.qty,
        price,
        imageDataUri,
      };
    });

  const yourCards = resolveCards(yourRefs);
  const theirCards = resolveCards(theirRefs);

  const yourTotal = yourCards.reduce((s, c) => s + (c.price ?? 0) * c.qty, 0);
  const theirTotal = theirCards.reduce((s, c) => s + (c.price ?? 0) * c.qty, 0);
  const diff = yourTotal - theirTotal;
  const absDiff = Math.abs(diff);
  const larger = Math.max(yourTotal, theirTotal);
  const ratio = larger > 0 ? absDiff / larger : 0;
  // "Your" side (Offering) being worth MORE means you're giving up more
  // value than you're getting — the trade tilts toward THEM. Inverted
  // from the raw diff sign because "your total" is what you're giving.
  const favored = absDiff < 0.01 ? 'none' : diff > 0 ? 'them' : 'you';

  // Force-themed balance message. Colors intentionally avoid emerald/blue —
  // those are reserved as side-identity colors (Offering / Receiving).
  // Absolute-dollar floors keep small-total trades from escalating into
  // alarm territory: a $2 gap on a $5 trade is high ratio-wise but
  // trivial in absolute terms.
  let tier: 'balanced' | 'ripple' | 'disturbance' | 'chaos';
  if (ratio < 0.02) tier = 'balanced';
  else if (ratio < 0.07) tier = 'ripple';
  else if (ratio < 0.15) tier = 'disturbance';
  else tier = 'chaos';
  if (absDiff < 5 && (tier === 'disturbance' || tier === 'chaos')) tier = 'ripple';
  else if (absDiff < 15 && tier === 'chaos') tier = 'disturbance';

  let balanceText: string;
  let balanceAction: string | null;
  let balanceColor: string;
  const amount = `$${absDiff.toFixed(2)}`;
  // Action verb from the sharer's perspective — matches the app's
  // bottom-banner copy so the image stays on-brand. "Ask for" when the
  // Offering side is paying too much; "Offer" when Receiving is.
  const verb = favored === 'them' ? 'Ask for' : 'Offer';
  switch (tier) {
    case 'balanced':
      balanceText = 'Balance in the Force';
      balanceColor = '#FFD700';
      balanceAction = favored === 'none' ? null : `${amount} in ${favored === 'you' ? 'your' : 'their'} favor`;
      break;
    case 'ripple':
      balanceText = 'A ripple in the Force';
      balanceColor = '#F5A623';
      balanceAction = `${verb} ${amount} to restore balance`;
      break;
    case 'disturbance':
      balanceText = 'A disturbance in the Force';
      balanceColor = '#fbbf24';
      balanceAction = `${verb} ${amount} to restore balance`;
      break;
    case 'chaos':
      balanceText = 'A great disturbance in the Force';
      balanceColor = '#f87171';
      balanceAction = `${verb} ${amount} to restore balance`;
      break;
  }

  const priceLabel = pm === 'low' ? 'Low' : 'Market';

  // Vertical structure (1200×630):
  //   y=0–80   header (logomark + wordmark + pricing meta)
  //   y=80    thin divider
  //   y=100–210 balance section (headline + action line)
  //   y=230–570 two columns (header + card grid)
  //   y=600    footer (swutrade.com)
  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="logo-glow" cx="50%" cy="55%" r="50%">
      <stop offset="0%" stop-color="#FFD700" stop-opacity="1"/>
      <stop offset="100%" stop-color="#F5A623" stop-opacity="0"/>
    </radialGradient>
    <filter id="logo-shadow">
      <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-opacity="0.4"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="#0a0e1a"/>
  <style>
    text { font-family: 'Inter', sans-serif; }
  </style>

  <!-- Header: compact logomark + wordmark + pricing meta -->
  <g transform="translate(36 14) scale(0.38)">
    <g transform="translate(0 -8)">
      <circle cx="50" cy="55" r="18" fill="url(#logo-glow)" opacity="0.55"/>
      <g transform="translate(38 58) rotate(-18)" filter="url(#logo-shadow)">
        <rect x="-17" y="-25" width="34" height="50" rx="4" fill="#0f3f2f" stroke="#34d399" stroke-width="3"/>
        <rect x="-12" y="-20" width="24" height="26" rx="2" fill="#065f46" opacity="0.7"/>
      </g>
      <g transform="translate(62 58) rotate(18)" filter="url(#logo-shadow)">
        <rect x="-17" y="-25" width="34" height="50" rx="4" fill="#0f2a52" stroke="#60a5fa" stroke-width="3"/>
        <rect x="-12" y="-20" width="24" height="26" rx="2" fill="#1e3a8a" opacity="0.7"/>
      </g>
      <circle cx="50" cy="48" r="5" fill="#FFD700"/>
      <circle cx="50" cy="48" r="7" fill="none" stroke="#FFA500" stroke-width="1" opacity="0.7"/>
    </g>
  </g>
  <text x="80" y="40" font-size="22" font-weight="900" letter-spacing="2.5">
    <tspan fill="#e5e7eb">SWU</tspan><tspan fill="#F5A623">TRADE</tspan>
    <tspan fill="#6b7280" font-size="13" font-weight="500" letter-spacing="0" dx="2">.com</tspan>
  </text>
  <text x="1164" y="38" fill="#9ca3af" font-size="13" font-weight="500" text-anchor="end">@ ${pct}% TCGPlayer ${priceLabel}</text>
  <line x1="36" y1="58" x2="1164" y2="58" stroke="#1f2937" stroke-width="1"/>

  <!-- Balance section — compact headline + thematic action line -->
  <text x="600" y="90" fill="${balanceColor}" font-size="20" font-weight="900" letter-spacing="2.5" text-anchor="middle">${escapeXml(balanceText.toUpperCase())}</text>
  ${balanceAction ? `<text x="600" y="114" fill="#d1d5db" font-size="14" font-weight="500" text-anchor="middle">${escapeXml(balanceAction)}</text>` : ''}

  <!-- Offering column (your side) -->
  ${renderCardGrid(yourCards, 'Offering', '#34d399', LEFT_X)}

  <!-- Receiving column (their side) -->
  ${renderCardGrid(theirCards, 'Receiving', '#60a5fa', RIGHT_X)}
</svg>`;

  // Debug helpers — `?format=svg` returns the raw SVG, `?debug=1` returns JSON
  // diagnostics. Useful for triaging font/render issues without re-deploying.
  if (req.query.format === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.status(200).send(svg);
    return;
  }
  if (req.query.debug === '1') {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      cardCounts: { your: yourCards.length, their: theirCards.length },
      indexEntries: Object.keys(index).length,
      fontPaths,
      imagesFetched: Array.from(imageMap.entries()).map(([id, v]) => ({ id, ok: v !== null })),
      svgLength: svg.length,
    });
    return;
  }

  // Render at 2x for crisper text/images on retina embeds. Output is 2400×1260
  // PNG which still embeds well in Discord/iMessage/Twitter (they downscale).
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 2400 },
    font: {
      fontFiles: fontPaths,
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
    },
  });
  const png = resvg.render().asPng();

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(Buffer.from(png));
}

// =====================================================================
// Shared list image — renders Wants + Available columns. Mirrors the
// trade image layout (1200×630, two columns, header) but drops the
// balance section since lists aren't comparable. Adds priority stars
// to wants tiles.
// =====================================================================

async function renderListImage(
  req: VercelRequest,
  res: VercelResponse,
  w: string,
  a: string,
  pct: number,
  pm: 'low' | 'market',
) {
  const fams = familyIndex as FamilyIndex;
  const index = productIndex as ProductIndex;

  const wants = decodeWants(w);
  const avail = decodeAvailableRefs(a);

  // Resolve wants: pick cheapest variant matching the restriction.
  const wantsResolved: ResolvedListCard[] = wants.map(want => {
    const candidates = fams[want.familyId] ?? [];
    const matching = want.acceptedVariants
      ? candidates.filter(c => want.acceptedVariants!.includes(c.v))
      : candidates;
    if (matching.length === 0) return null;
    const priceField = pm === 'low' ? 'l' : 'm';
    const best = matching.reduce((b, c) => {
      const bp = b[priceField] ?? Infinity;
      const cp = c[priceField] ?? Infinity;
      return cp < bp ? c : b;
    });
    const raw = best[priceField];
    const price = raw !== null ? Math.round(raw * pct) / 100 : null;
    return {
      productId: best.p,
      name: best.n,
      variant: best.v,
      qty: want.qty,
      price,
      isPriority: want.isPriority,
      imageDataUri: null,
    };
  }).filter((c): c is ResolvedListCard => c !== null);

  // Resolve available: exact productId lookup.
  const availResolved: ResolvedListCard[] = avail.map(ref => {
    const card = index[ref.productId];
    if (!card) return null;
    const raw = pm === 'low' ? card.l : card.p;
    const price = raw !== null ? Math.round(raw * pct) / 100 : null;
    return {
      productId: ref.productId,
      name: extractBaseName(card.n),
      variant: extractVariant(card.n),
      qty: ref.qty,
      price,
      isPriority: false,
      imageDataUri: null,
    };
  }).filter((c): c is ResolvedListCard => c !== null);

  // Fetch images in parallel — same warm-cache pattern as trade.
  const allIds = [...wantsResolved, ...availResolved].slice(0, 60).map(c => c.productId);
  const imageMap = new Map<string, string | null>();
  await Promise.all(
    Array.from(new Set(allIds)).map(async id => {
      imageMap.set(id, await fetchCardImage(id));
    }),
  );
  for (const c of wantsResolved) c.imageDataUri = imageMap.get(c.productId) ?? null;
  for (const c of availResolved) c.imageDataUri = imageMap.get(c.productId) ?? null;

  const wantsCount = wantsResolved.length;
  const availCount = availResolved.length;
  const subtitleParts: string[] = [];
  if (wantsCount > 0) subtitleParts.push(`${wantsCount} want${wantsCount === 1 ? '' : 's'}`);
  if (availCount > 0) subtitleParts.push(`${availCount} available`);
  const subtitle = subtitleParts.join(' · ');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0e1a"/>
      <stop offset="1" stop-color="#111627"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Header -->
  <text x="36" y="56" font-size="32" font-weight="900" letter-spacing="3" fill="#e5e7eb">SWU<tspan fill="#F5A623">TRADE</tspan></text>
  <text x="36" y="86" font-size="14" font-weight="700" letter-spacing="3" fill="#9ca3af">SHARED LIST${subtitle ? ` · ${subtitle.toUpperCase()}` : ''}</text>
  <line x1="36" y1="100" x2="1164" y2="100" stroke="#1a1f2e" stroke-width="2"/>

  ${renderListColumn(wantsResolved, 'Wants', '#60a5fa', LEFT_X)}
  ${renderListColumn(availResolved, 'Available', '#34d399', RIGHT_X)}

  <!-- Footer -->
  <text x="600" y="610" font-size="12" font-weight="600" fill="#6b7280" text-anchor="middle">swutrade.com</text>
</svg>`;

  if (req.query.format === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.status(200).send(svg);
    return;
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 2400 },
    font: {
      fontFiles: fontPaths,
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
    },
  });
  const png = resvg.render().asPng();

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(Buffer.from(png));
}

// =====================================================================
// Single-list image — used when only `w` (wishlist) or only `a`
// (binder) is present on the URL. Same 1200×630 canvas as the combined
// share, but the full width is given over to a single list's rows
// (split across two columns) with a tailored header + accent color.
// Introduced with the 2026-04-21 Wishlist / Binder split: the dedicated
// views' share buttons each encode only their own list, so the image
// reads as "here is my wishlist" / "here is my trade binder" rather
// than an awkward half-empty "SHARED LIST · 0 available" combined view.
// =====================================================================

async function renderSingleListImage(
  req: VercelRequest,
  res: VercelResponse,
  list: 'wishlist' | 'binder',
  encoded: string,
  pct: number,
  pm: 'low' | 'market',
) {
  const fams = familyIndex as FamilyIndex;
  const index = productIndex as ProductIndex;

  // Resolve cards per list type. Wishlist picks the cheapest variant
  // matching each want's restriction (same as the combined list image);
  // binder resolves exact productIds.
  let resolved: ResolvedListCard[] = [];
  if (list === 'wishlist') {
    const wants = decodeWants(encoded);
    resolved = wants.map(want => {
      const candidates = fams[want.familyId] ?? [];
      const matching = want.acceptedVariants
        ? candidates.filter(c => want.acceptedVariants!.includes(c.v))
        : candidates;
      if (matching.length === 0) return null;
      const priceField = pm === 'low' ? 'l' : 'm';
      const best = matching.reduce((b, c) => {
        const bp = b[priceField] ?? Infinity;
        const cp = c[priceField] ?? Infinity;
        return cp < bp ? c : b;
      });
      const raw = best[priceField];
      const price = raw !== null ? Math.round(raw * pct) / 100 : null;
      return {
        productId: best.p,
        name: best.n,
        variant: best.v,
        qty: want.qty,
        price,
        isPriority: want.isPriority,
        imageDataUri: null,
      };
    }).filter((c): c is ResolvedListCard => c !== null);
    // Priority-first, mirrors HomeView + WantsPanel sort so the top of
    // the image matches what the author sees in the app.
    resolved.sort((a, b) => {
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
      return 0;
    });
  } else {
    const avail = decodeAvailableRefs(encoded);
    resolved = avail.map(ref => {
      const card = index[ref.productId];
      if (!card) return null;
      const raw = pm === 'low' ? card.l : card.p;
      const price = raw !== null ? Math.round(raw * pct) / 100 : null;
      return {
        productId: ref.productId,
        name: extractBaseName(card.n),
        variant: extractVariant(card.n),
        qty: ref.qty,
        price,
        isPriority: false,
        imageDataUri: null,
      };
    }).filter((c): c is ResolvedListCard => c !== null);
  }

  // Cap total cards rendered so we don't blow the image-fetch budget
  // on a gigantic list. Two columns × ~11 rows each = ~22 visible.
  const visible = resolved.slice(0, 40);
  const imageMap = new Map<string, string | null>();
  await Promise.all(
    Array.from(new Set(visible.map(c => c.productId))).map(async id => {
      imageMap.set(id, await fetchCardImage(id));
    }),
  );
  for (const c of visible) c.imageDataUri = imageMap.get(c.productId) ?? null;

  // Title + subtitle + accent pulled from the list type. Trade-side
  // palette reuse: blue = wishlist (Receiving-side, "cards I want in"),
  // emerald = binder (Offering-side, "cards I have out").
  const isWishlist = list === 'wishlist';
  const accent = isWishlist ? '#60a5fa' : '#34d399';
  const title = isWishlist ? 'WISHLIST' : 'TRADE BINDER';
  const count = resolved.length;
  let subtitleParts: string[] = [];
  if (isWishlist) {
    subtitleParts.push(`${count} card${count === 1 ? '' : 's'}`);
    const priority = resolved.filter(c => c.isPriority).length;
    if (priority > 0) subtitleParts.push(`${priority} priority`);
  } else {
    subtitleParts.push(`${count} card${count === 1 ? '' : 's'} available`);
  }
  const subtitle = subtitleParts.join(' · ');

  // Split the list across two columns. `ceil(n/2)` goes in the left
  // column so an odd count doesn't leave the right column with one
  // stranded row beneath many empty slots.
  const leftHalf = visible.slice(0, Math.ceil(visible.length / 2));
  const rightHalf = visible.slice(Math.ceil(visible.length / 2));

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0e1a"/>
      <stop offset="1" stop-color="#111627"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Header: SWUTRADE brandmark + list title with accent saber -->
  <text x="36" y="56" font-size="32" font-weight="900" letter-spacing="3" fill="#e5e7eb">SWU<tspan fill="#F5A623">TRADE</tspan></text>
  <rect x="36" y="78" width="3" height="20" rx="1.5" fill="${accent}"/>
  <text x="48" y="94" font-size="18" font-weight="800" letter-spacing="3" fill="${accent}">${title}</text>
  ${subtitle
    ? `<text x="1164" y="94" font-size="14" font-weight="700" letter-spacing="2" fill="#9ca3af" text-anchor="end">${escapeXml(subtitle.toUpperCase())}</text>`
    : ''}
  <line x1="36" y1="110" x2="1164" y2="110" stroke="#1a1f2e" stroke-width="2"/>

  ${count === 0
    ? `<text x="600" y="340" fill="#4b5563" font-size="18" text-anchor="middle">Empty</text>`
    : `${renderListRows(leftHalf, LEFT_X, accent, isWishlist)}
       ${renderListRows(rightHalf, RIGHT_X, accent, isWishlist)}`}

  ${count > visible.length
    ? `<text x="600" y="602" font-size="12" font-weight="600" fill="#6b7280" text-anchor="middle">+${count - visible.length} more not shown · swutrade.com</text>`
    : `<text x="600" y="610" font-size="12" font-weight="600" fill="#6b7280" text-anchor="middle">swutrade.com</text>`}
</svg>`;

  if (req.query.format === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.status(200).send(svg);
    return;
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 2400 },
    font: {
      fontFiles: fontPaths,
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
    },
  });
  const png = resvg.render().asPng();

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(Buffer.from(png));
}

type ResolvedListCard = ResolvedCard & { isPriority: boolean };

// Row-based layout for list images. Optimized for recipient scanning
// — tiny thumbnail on the left, name / variant / qty / price laid
// out horizontally. Fits 18+ rows per column on the 1200×630 canvas
// vs 6-ish tiles with the old grid design.
const LIST_ROW_H = 32;
const LIST_ROW_GAP = 4;
const LIST_THUMB_W = 24;
const LIST_THUMB_H = 34;

function renderListColumn(
  cards: ResolvedListCard[],
  label: string,
  color: string,
  x: number,
): string {
  let svg = '';
  const headerBaselineY = 170;
  const saberTop = headerBaselineY - 14;
  const saberH = 20;
  svg += `<rect x="${x}" y="${saberTop}" width="3" height="${saberH}" rx="1.5" fill="${color}"/>`;
  svg += `<text x="${x + 12}" y="${headerBaselineY}" fill="${color}" font-size="16" font-weight="700" letter-spacing="2">${label.toUpperCase()}</text>`;
  svg += `<text x="${x + COL_WIDTH}" y="${headerBaselineY}" fill="#9ca3af" font-size="14" font-weight="600" text-anchor="end">${cards.length}</text>`;
  svg += `<line x1="${x}" y1="${headerBaselineY + 10}" x2="${x + COL_WIDTH}" y2="${headerBaselineY + 10}" stroke="${color}" stroke-opacity="0.22" stroke-width="1.5"/>`;

  if (cards.length === 0) {
    svg += `<text x="${x + COL_WIDTH / 2}" y="${GRID_TOP + 80}" fill="#4b5563" font-size="16" text-anchor="middle">Empty</text>`;
    return svg;
  }

  // How many rows fit in the available area? Reserve ~20px at the
  // bottom for a potential "+N more" indicator.
  const available = GRID_HEIGHT - 20;
  const maxVisible = Math.floor(available / (LIST_ROW_H + LIST_ROW_GAP));
  const visible = cards.slice(0, maxVisible);

  visible.forEach((card, i) => {
    const rowY = GRID_TOP + i * (LIST_ROW_H + LIST_ROW_GAP);
    const thumbX = x;
    const thumbY = rowY + (LIST_ROW_H - LIST_THUMB_H) / 2;
    const textX = x + LIST_THUMB_W + 10;

    // Thumbnail — kept small so the row carries most of its info in
    // text. Priority stars (wants only) sit bottom-left of the thumb.
    if (card.imageDataUri) {
      svg += `<image href="${card.imageDataUri}" x="${thumbX}" y="${thumbY}" width="${LIST_THUMB_W}" height="${LIST_THUMB_H}" preserveAspectRatio="xMidYMid slice"/>`;
    } else {
      svg += `<rect x="${thumbX}" y="${thumbY}" width="${LIST_THUMB_W}" height="${LIST_THUMB_H}" fill="#1f2937" rx="2"/>`;
    }
    if (card.isPriority) {
      svg += `<text x="${thumbX + LIST_THUMB_W - 2}" y="${thumbY + 10}" fill="#FFD700" font-size="11" font-weight="900" text-anchor="end" stroke="#000" stroke-width="0.4">★</text>`;
    }

    // Right edge: price first (anchored end), qty just inside of it.
    const rightEdge = x + COL_WIDTH;
    const priceBaselineY = rowY + 20;
    const lineTotal = card.price !== null ? card.price * card.qty : null;
    const priceColor = card.price === null ? '#f87171' : '#d4a843';
    svg += `<text x="${rightEdge}" y="${priceBaselineY}" fill="${priceColor}" font-size="13" font-weight="700" text-anchor="end">${escapeXml(formatPrice(lineTotal))}</text>`;

    let qtyRightEdge = rightEdge;
    if (card.qty > 1) {
      // Approximate price width so we can stack qty to its left.
      const priceW = Math.max(40, 10 + (formatPrice(lineTotal).length * 7));
      qtyRightEdge = rightEdge - priceW - 8;
      svg += `<text x="${qtyRightEdge}" y="${priceBaselineY}" fill="#9ca3af" font-size="12" font-weight="700" text-anchor="end">×${card.qty}</text>`;
      qtyRightEdge -= 24;
    } else {
      qtyRightEdge = rightEdge - 54;
    }

    // Variant pill between the name and the qty/price cluster.
    const vbs = variantBadgeStyle(card.variant);
    let pillRightEdge = qtyRightEdge;
    if (vbs) {
      const vlabel = card.variant === 'Hyperspace Foil' ? 'HS Foil' : card.variant;
      const pillSize = 9;
      const pillH = pillSize + 4;
      const pillTextW = vlabel.length * pillSize * 0.6;
      const pillPadX = 4;
      const pillW = pillTextW + pillPadX * 2;
      const pillX = qtyRightEdge - pillW;
      const pillTopY = rowY + (LIST_ROW_H - pillH) / 2;
      svg += `<rect x="${pillX}" y="${pillTopY}" width="${pillW}" height="${pillH}" rx="2" fill="${vbs.bg}"/>`;
      svg += `<text x="${pillX + pillPadX}" y="${pillTopY + pillSize + 1}" fill="${vbs.text}" font-size="${pillSize}" font-weight="700" letter-spacing="0.3">${escapeXml(vlabel.toUpperCase())}</text>`;
      pillRightEdge = pillX - 8;
    }

    // Card name — fills the space between thumbnail and the pill. Back
    // off a character or two if the pill is wide.
    const nameMaxPx = pillRightEdge - textX;
    const nameSize = 13;
    const nameMaxChars = Math.max(10, Math.floor(nameMaxPx / (nameSize * 0.55)));
    const nameBaselineY = rowY + 20;
    svg += `<text x="${textX}" y="${nameBaselineY}" fill="#e5e7eb" font-size="${nameSize}" font-weight="500">${escapeXml(truncate(card.name, nameMaxChars))}</text>`;
  });

  if (cards.length > maxVisible) {
    const overflowY = GRID_TOP + maxVisible * (LIST_ROW_H + LIST_ROW_GAP) + 14;
    svg += `<text x="${x + COL_WIDTH / 2}" y="${overflowY}" fill="#9ca3af" font-size="12" font-weight="600" text-anchor="middle">+${cards.length - maxVisible} more</text>`;
  }

  return svg;
}

// Per-row renderer used by the single-list image path. Same row
// shape as `renderListColumn` but with no header — the single-list
// variant carries its title in the top-of-canvas chrome, so each
// column body is just rows. Starts at the same `GRID_TOP` baseline
// so the two columns line up.
//
// `showPriorityStars` is currently `false` in every call (priority
// is already bubbled up via the priority-first sort) but kept as a
// parameter so a future callout design can re-enable the per-row
// star without restructuring.
function renderListRows(
  cards: ResolvedListCard[],
  x: number,
  _accent: string,
  showPriorityStars: boolean,
): string {
  let svg = '';
  // How many rows fit — matches renderListColumn's budget so the
  // two halves of a single-list image line up with the combined
  // image when viewed side-by-side.
  const available = GRID_HEIGHT - 20;
  const maxVisible = Math.floor(available / (LIST_ROW_H + LIST_ROW_GAP));
  const visible = cards.slice(0, maxVisible);

  visible.forEach((card, i) => {
    const rowY = GRID_TOP + i * (LIST_ROW_H + LIST_ROW_GAP);
    const thumbX = x;
    const thumbY = rowY + (LIST_ROW_H - LIST_THUMB_H) / 2;
    const textX = x + LIST_THUMB_W + 10;

    if (card.imageDataUri) {
      svg += `<image href="${card.imageDataUri}" x="${thumbX}" y="${thumbY}" width="${LIST_THUMB_W}" height="${LIST_THUMB_H}" preserveAspectRatio="xMidYMid slice"/>`;
    } else {
      svg += `<rect x="${thumbX}" y="${thumbY}" width="${LIST_THUMB_W}" height="${LIST_THUMB_H}" fill="#1f2937" rx="2"/>`;
    }
    if (showPriorityStars && card.isPriority) {
      svg += `<text x="${thumbX + LIST_THUMB_W - 2}" y="${thumbY + 10}" fill="#FFD700" font-size="11" font-weight="900" text-anchor="end" stroke="#000" stroke-width="0.4">★</text>`;
    }

    const rightEdge = x + COL_WIDTH;
    const priceBaselineY = rowY + 20;
    const lineTotal = card.price !== null ? card.price * card.qty : null;
    const priceColor = card.price === null ? '#f87171' : '#d4a843';
    svg += `<text x="${rightEdge}" y="${priceBaselineY}" fill="${priceColor}" font-size="13" font-weight="700" text-anchor="end">${escapeXml(formatPrice(lineTotal))}</text>`;

    let qtyRightEdge = rightEdge;
    if (card.qty > 1) {
      const priceW = Math.max(40, 10 + (formatPrice(lineTotal).length * 7));
      qtyRightEdge = rightEdge - priceW - 8;
      svg += `<text x="${qtyRightEdge}" y="${priceBaselineY}" fill="#9ca3af" font-size="12" font-weight="700" text-anchor="end">×${card.qty}</text>`;
      qtyRightEdge -= 24;
    } else {
      qtyRightEdge = rightEdge - 54;
    }

    const vbs = variantBadgeStyle(card.variant);
    let pillRightEdge = qtyRightEdge;
    if (vbs) {
      const vlabel = card.variant === 'Hyperspace Foil' ? 'HS Foil' : card.variant;
      const pillSize = 9;
      const pillH = pillSize + 4;
      const pillTextW = vlabel.length * pillSize * 0.6;
      const pillPadX = 4;
      const pillW = pillTextW + pillPadX * 2;
      const pillX = qtyRightEdge - pillW;
      const pillTopY = rowY + (LIST_ROW_H - pillH) / 2;
      svg += `<rect x="${pillX}" y="${pillTopY}" width="${pillW}" height="${pillH}" rx="2" fill="${vbs.bg}"/>`;
      svg += `<text x="${pillX + pillPadX}" y="${pillTopY + pillSize + 1}" fill="${vbs.text}" font-size="${pillSize}" font-weight="700" letter-spacing="0.3">${escapeXml(vlabel.toUpperCase())}</text>`;
      pillRightEdge = pillX - 8;
    }

    const nameMaxPx = pillRightEdge - textX;
    const nameSize = 13;
    const nameMaxChars = Math.max(10, Math.floor(nameMaxPx / (nameSize * 0.55)));
    const nameBaselineY = rowY + 20;
    svg += `<text x="${textX}" y="${nameBaselineY}" fill="#e5e7eb" font-size="${nameSize}" font-weight="500">${escapeXml(truncate(card.name, nameMaxChars))}</text>`;
  });

  return svg;
}


// ---- Signal post unfurl image ------------------------------------------
//
// Composite header image referenced from a signal embed's `image.url`.
// Discord caches by URL, so status changes (cancel / expire) drop the
// image entry from the embed rather than re-rendering this. Layout:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ SWUTRADE [accent saber] LOOKING FOR · @handle    ⏱ 7 days │
//   │──────────────────────────────────────────────────────────│
//   │ ┌────┐ ┌────┐ ┌────┐ ┌────┐                               │
//   │ │card│ │card│ │card│ │card│   (auto-flow grid)            │
//   │ │ ×2 │ │ ×1 │ │ ×3 │ │ ×1 │                               │
//   │ └────┘ └────┘ └────┘ └────┘                               │
//   │ Name [SET] · variant   ← caption per tile                 │
//   └──────────────────────────────────────────────────────────┘

interface ResolvedSignalCard {
  productId: string;
  name: string;
  setCode: string;
  cardType?: string;
  qty: number;
  variant: string | null; // null = any printing
  imageDataUri: string | null;
}

async function renderSignalImage(
  req: VercelRequest,
  res: VercelResponse,
  groupId: string,
) {
  const db = getDb();

  // Pull the signal rows + signaler. One DB roundtrip; group rows
  // share userId so the join would be redundant.
  const rows = await db
    .select()
    .from(cardSignals)
    .where(eq(cardSignals.groupId, groupId));
  if (rows.length === 0) {
    res.status(404).send(signal not found);
    return;
  }
  const [signaler] = await db
    .select({ handle: users.handle, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, rows[0].userId))
    .limit(1);

  // Resolve each row's family + variant. Same pattern as
  // api/bot.ts's resolveSignalFamily / resolveVariantSpec, inlined
  // here so we can keep this in og.ts (function-count ceiling forces
  // consolidation).
  const resolved: ResolvedSignalCard[] = [];
  for (const row of rows) {
    let family: SignalFamily | null = null;
    let variant: string | null = null;
    let qty = 1;
    if (row.kind === 'wanted' && row.wantsItemId) {
      const [w] = await db
        .select({ familyId: wantsItems.familyId, qty: wantsItems.qty, mode: wantsItems.restrictionMode, variants: wantsItems.restrictionVariants })
        .from(wantsItems)
        .where(eq(wantsItems.id, row.wantsItemId))
        .limit(1);
      if (!w) continue;
      family = lookupSignalFamily(w.familyId);
      qty = w.qty;
      variant = w.mode === 'restricted' && w.variants && w.variants.length === 1 ? w.variants[0] : null;
    } else if (row.kind === 'offering' && row.availableItemId) {
      const [a] = await db
        .select({ productId: availableItems.productId, qty: availableItems.qty })
        .from(availableItems)
        .where(eq(availableItems.id, row.availableItemId))
        .limit(1);
      if (!a) continue;
      const card = lookupSignalCard(a.productId);
      if (card) {
        family = lookupSignalFamily(card.familyId);
        variant = card.variant;
      }
      qty = a.qty;
    }
    if (!family) continue;
    const productId = variant
      ? family.variants.find(v => v.variant === variant)?.productId ?? family.variants[0].productId
      : family.variants[0].productId;
    resolved.push({
      productId,
      name: family.name,
      setCode: family.setCode,
      cardType: family.cardType,
      qty,
      variant,
      imageDataUri: null,
    });
  }

  if (resolved.length === 0) {
    res.status(404).send(signal cards could not be resolved);
    return;
  }

  // Cap the rendered cards. The signal API allows up to 20 cards, but
  // the image gets unreadable past ~12 — beyond that we just show
  // "+N more" text and the post embed itself lists everything.
  const RENDER_CAP = 12;
  const visible = resolved.slice(0, RENDER_CAP);
  const overflow = resolved.length - visible.length;

  // Fetch images in parallel.
  const imageMap = new Map<string, string | null>();
  await Promise.all(
    Array.from(new Set(visible.map(c => c.productId))).map(async id => {
      imageMap.set(id, await fetchCardImage(id));
    }),
  );
  for (const c of visible) c.imageDataUri = imageMap.get(c.productId) ?? null;

  // Side palette mirrors the embed accent.
  const kind = rows[0].kind;
  const accent = kind === 'wanted' ? '#60a5fa' : '#34d399'; // blue : emerald
  const verbLabel = kind === 'wanted' ? 'LOOKING FOR' : 'OFFERING';
  const handle = signaler?.handle ?? '?';

  // Tile layout — 4 cols × 3 rows fits the cap with breathing room.
  const COLS = visible.length <= 4 ? Math.max(1, visible.length) : visible.length <= 8 ? 4 : 6;
  const ROWS = Math.ceil(visible.length / COLS);
  const HEADER_BOTTOM = 84;
  const FOOTER_TOP = 600;
  const GRID_TOP_Y = HEADER_BOTTOM + 20;
  const GRID_BOTTOM_Y = FOOTER_TOP - 10;
  const SIDE_PAD = 36;
  const COL_GAP = 12;
  const ROW_GAP = 14;
  const gridW = 1200 - SIDE_PAD * 2;
  const tileW = (gridW - COL_GAP * (COLS - 1)) / COLS;
  // Tile = card image (5:7) + caption strip beneath.
  const captionH = 38;
  const imgH_uncapped = tileW * 1.4;
  const totalRowH_uncapped = imgH_uncapped + captionH + ROW_GAP;
  const availableH = GRID_BOTTOM_Y - GRID_TOP_Y;
  // Scale down if the natural row height overflows.
  const scale = Math.min(1, availableH / (totalRowH_uncapped * ROWS - ROW_GAP));
  const imgH = imgH_uncapped * scale;
  const imgW = tileW * scale;
  const tileImgX_offset = (tileW - imgW) / 2;
  const rowH = imgH + captionH + ROW_GAP;

  const tiles = visible.map((card, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = SIDE_PAD + col * (tileW + COL_GAP);
    const y = GRID_TOP_Y + row * rowH;
    const imgX = x + tileImgX_offset;
    const captionY = y + imgH + 4;
    const variantLabel = card.variant ?? 'any printing';
    const setBadge = card.cardType === 'Leader' ? ' (Leader)' : '';
    const nameTrunc = truncate(card.name, Math.max(14, Math.floor(tileW / 7)));
    return `
    <g>
      ${card.imageDataUri
        ? `<image href="${card.imageDataUri}" x="${imgX}" y="${y}" width="${imgW}" height="${imgH}" preserveAspectRatio="xMidYMid meet"/>`
        : `<rect x="${imgX}" y="${y}" width="${imgW}" height="${imgH}" fill="#1f2937" rx="6"/>`}
      ${card.qty > 1
        ? `<g>
             <rect x="${imgX + imgW - 38}" y="${y + 6}" width="32" height="22" rx="4" fill="#0a0e1a" fill-opacity="0.85" stroke="${accent}" stroke-width="1.5"/>
             <text x="${imgX + imgW - 22}" y="${y + 22}" fill="${accent}" font-size="14" font-weight="900" text-anchor="middle">×${card.qty}</text>
           </g>`
        : ''}
      <text x="${x + tileW / 2}" y="${captionY + 14}" fill="#e5e7eb" font-size="12" font-weight="700" text-anchor="middle">${escapeXml(nameTrunc)}</text>
      <text x="${x + tileW / 2}" y="${captionY + 28}" fill="#9ca3af" font-size="10" font-weight="600" text-anchor="middle">[${escapeXml(card.setCode)}]${escapeXml(setBadge)} · ${escapeXml(variantLabel)}</text>
    </g>`;
  }).join('\n');

  const overflowFooter = overflow > 0
    ? `<text x="600" y="${FOOTER_TOP + 18}" fill="#9ca3af" font-size="13" font-weight="700" text-anchor="middle">+${overflow} more in the post</text>`
    : '';

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0e1a"/>
      <stop offset="1" stop-color="#111627"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Header: brandmark on the left, kind verb + handle on the right.
       Use a single flowing <text> for the verb+handle so the handle
       can't collide with the verb label regardless of how wide
       "LOOKING FOR" / "OFFERING" renders at 18pt+letter-spacing=3. -->
  <text x="36" y="60" font-size="32" font-weight="900" letter-spacing="3" fill="#e5e7eb">SWU<tspan fill="#F5A623">TRADE</tspan></text>
  <text x="1164" y="60" font-size="14" font-weight="700" letter-spacing="2" fill="${accent}" text-anchor="end">${verbLabel}<tspan fill="#9ca3af" font-weight="600" letter-spacing="0" dx="10">· @${escapeXml(handle)}</tspan></text>
  <line x1="36" y1="84" x2="1164" y2="84" stroke="#1a1f2e" stroke-width="2"/>

  ${tiles}

  <line x1="36" y1="${FOOTER_TOP - 6}" x2="1164" y2="${FOOTER_TOP - 6}" stroke="#1a1f2e" stroke-width="1"/>
  ${overflowFooter}
  <text x="600" y="618" font-size="11" font-weight="600" fill="#6b7280" text-anchor="middle">swutrade.com</text>
</svg>`;

  if (req.query.format === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.status(200).send(svg);
    return;
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 2400 },
    font: {
      fontFiles: fontPaths,
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
    },
  });
  const png = resvg.render().asPng();
  res.setHeader('Content-Type', 'image/png');
  // Long s-maxage — Discord caches embed images by URL, so we want
  // the CDN to also serve repeat fetches without round-tripping the
  // function. The image content is stable for the life of the signal
  // (status changes drop the image rather than re-render here).
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  res.status(200).send(Buffer.from(png));
}
