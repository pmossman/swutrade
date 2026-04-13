import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load Inter font once at module load — bundled with the function via @fontsource
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadFont(filename: string): Buffer | null {
  const candidates = [
    join(__dirname, '..', 'node_modules', '@fontsource', 'inter', 'files', filename),
    join(process.cwd(), 'node_modules', '@fontsource', 'inter', 'files', filename),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p);
    } catch {
      // try next
    }
  }
  return null;
}

const fontRegular = loadFont('inter-latin-400-normal.woff');
const fontBold = loadFont('inter-latin-700-normal.woff');
const fontBlack = loadFont('inter-latin-900-normal.woff');

interface CardInfo {
  n: string;  // name
  p: number | null;  // market price
  l: number | null;  // low price
  s: string;  // set name
}

type ProductIndex = Record<string, CardInfo>;

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

// Truncate text to fit within a given width (approximate)
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

type ResolvedCard = { name: string; variant: string; qty: number; price: number | null };

function renderCardList(
  cards: ResolvedCard[],
  label: string,
  color: string,
  x: number,
): string {
  const total = cards.reduce((s, c) => s + (c.price ?? 0) * c.qty, 0);
  let svg = '';

  // Header
  svg += `<line x1="${x}" y1="130" x2="${x + 500}" y2="130" stroke="${color}" stroke-opacity="0.3" stroke-width="2"/>`;
  svg += `<text x="${x}" y="122" fill="${color}" font-size="20" font-weight="700" letter-spacing="1">${label.toUpperCase()}</text>`;
  svg += `<text x="${x + 500}" y="122" fill="${color}" font-size="22" font-weight="700" text-anchor="end">${escapeXml(formatPrice(total))}</text>`;

  if (cards.length === 0) {
    svg += `<text x="${x}" y="160" fill="#6b7280" font-size="16">No cards</text>`;
    return svg;
  }

  const maxCards = 8;
  const visibleCards = cards.slice(0, maxCards);

  visibleCards.forEach((card, i) => {
    const cy = 158 + i * 44;
    const displayName = escapeXml(truncate(card.name, 30));
    const variantText = escapeXml(card.variant + (card.qty > 1 ? ` × ${card.qty}` : ''));
    const lineTotal = card.price !== null ? card.price * card.qty : null;

    svg += `<text x="${x}" y="${cy}" fill="#e5e7eb" font-size="16">${displayName}</text>`;
    svg += `<text x="${x}" y="${cy + 18}" fill="#6b7280" font-size="12">${variantText}</text>`;
    svg += `<text x="${x + 500}" y="${cy}" fill="#d4a843" font-size="16" font-weight="600" text-anchor="end">${escapeXml(formatPrice(lineTotal))}</text>`;
  });

  if (cards.length > maxCards) {
    const overflowY = 158 + maxCards * 44;
    svg += `<text x="${x}" y="${overflowY}" fill="#6b7280" font-size="14">+${cards.length - maxCards} more</text>`;
  }

  return svg;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const y = (req.query.y as string) || '';
  const t = (req.query.t as string) || '';
  const pct = parseInt((req.query.pct as string) || '80', 10);
  const pm = req.query.pm === 'l' ? 'low' : 'market';

  // Fetch the product index from our own deployment
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'swutrade.com';
  const origin = `${proto}://${host}`;

  let index: ProductIndex = {};
  try {
    const fetchRes = await fetch(`${origin}/data/product-index.json`);
    if (fetchRes.ok) index = await fetchRes.json();
  } catch {
    // Fall back to empty
  }

  const yourRefs = decodeCardRefs(y);
  const theirRefs = decodeCardRefs(t);

  const resolveCards = (refs: { productId: string; qty: number }[]): ResolvedCard[] =>
    refs.map(ref => {
      const card = index[ref.productId];
      if (!card) return { name: `#${ref.productId}`, variant: '', qty: ref.qty, price: null };
      const rawPrice = pm === 'low' ? card.l : card.p;
      const price = rawPrice !== null ? Math.round(rawPrice * pct) / 100 : null;
      return { name: extractBaseName(card.n), variant: extractVariant(card.n), qty: ref.qty, price };
    });

  const yourCards = resolveCards(yourRefs);
  const theirCards = resolveCards(theirRefs);

  const yourTotal = yourCards.reduce((s, c) => s + (c.price ?? 0) * c.qty, 0);
  const theirTotal = theirCards.reduce((s, c) => s + (c.price ?? 0) * c.qty, 0);
  const diff = yourTotal - theirTotal;
  const absDiff = Math.abs(diff);
  const isEven = absDiff < 0.01;

  let balanceText: string;
  let balanceColor: string;
  if (isEven) {
    balanceText = 'Trade is even!';
    balanceColor = '#34d399';
  } else if (diff > 0) {
    balanceText = `They owe you ${escapeXml(formatPrice(absDiff))}`;
    balanceColor = '#34d399';
  } else {
    balanceText = `You owe them ${escapeXml(formatPrice(absDiff))}`;
    balanceColor = '#fbbf24';
  }

  const priceLabel = pm === 'low' ? 'Low' : 'Market';

  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#0a0e1a"/>
  <style>
    text { font-family: 'Inter', sans-serif; }
  </style>

  <!-- Header -->
  <text x="48" y="60" fill="#d4a843" font-size="36" font-weight="900" letter-spacing="2">SWU TRADE</text>
  <text x="1152" y="60" fill="#6b7280" font-size="16" text-anchor="end">@ ${pct}% TCGPlayer ${priceLabel}</text>

  <!-- Balance -->
  <text x="600" y="96" fill="${balanceColor}" font-size="30" font-weight="700" text-anchor="middle">${balanceText}</text>

  <!-- You column -->
  ${renderCardList(yourCards, 'You', '#34d399', 48)}

  <!-- Them column -->
  ${renderCardList(theirCards, 'Them', '#60a5fa', 648)}

  <!-- Footer -->
  <text x="600" y="610" fill="#4b5563" font-size="14" text-anchor="middle">swutrade.com</text>
</svg>`;

  // Convert SVG to PNG for broad platform compatibility (Discord, iMessage, etc.)
  const fontBuffers: Buffer[] = [];
  if (fontRegular) fontBuffers.push(fontRegular);
  if (fontBold) fontBuffers.push(fontBold);
  if (fontBlack) fontBuffers.push(fontBlack);

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: {
      fontBuffers,
      loadSystemFonts: false,
      defaultFontFamily: 'Inter',
    },
  });
  const png = resvg.render().asPng();

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(Buffer.from(png));
}
