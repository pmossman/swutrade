import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

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

export default async function handler(req: Request) {
  const { searchParams } = new URL(req.url);
  const y = searchParams.get('y') || '';
  const t = searchParams.get('t') || '';
  const pct = parseInt(searchParams.get('pct') || '80', 10);
  const pm = searchParams.get('pm') === 'l' ? 'low' : 'market';

  // Fetch the product index from our own origin
  const origin = new URL(req.url).origin;
  let index: ProductIndex = {};
  try {
    const res = await fetch(`${origin}/data/product-index.json`);
    if (res.ok) index = await res.json();
  } catch {
    // Fall back to empty index
  }

  const yourRefs = decodeCardRefs(y);
  const theirRefs = decodeCardRefs(t);

  type ResolvedCard = { name: string; variant: string; qty: number; price: number | null };

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
    balanceText = `They owe you ${formatPrice(absDiff)}`;
    balanceColor = '#34d399';
  } else {
    balanceText = `You owe them ${formatPrice(absDiff)}`;
    balanceColor = '#fbbf24';
  }

  const priceLabel = pm === 'low' ? 'Low' : 'Market';

  const renderCardList = (cards: ResolvedCard[], label: string, color: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `2px solid ${color}40`, paddingBottom: 8 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
        <span style={{ fontSize: 22, fontWeight: 700, color }}>
          {formatPrice(cards.reduce((s, c) => s + (c.price ?? 0) * c.qty, 0))}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {cards.length === 0 ? (
          <span style={{ fontSize: 16, color: '#6b7280' }}>No cards</span>
        ) : (
          cards.slice(0, 8).map((card, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 280 }}>
                <span style={{ fontSize: 16, color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {card.name}
                </span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  {card.variant}{card.qty > 1 ? ` × ${card.qty}` : ''}
                </span>
              </div>
              <span style={{ fontSize: 16, fontWeight: 600, color: '#d4a843' }}>
                {formatPrice(card.price !== null && card.qty > 0 ? card.price * card.qty : card.price)}
              </span>
            </div>
          ))
        )}
        {cards.length > 8 && (
          <span style={{ fontSize: 14, color: '#6b7280' }}>+{cards.length - 8} more</span>
        )}
      </div>
    </div>
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#0a0e1a',
          padding: 48,
          fontFamily: 'sans-serif',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <span style={{ fontSize: 36, fontWeight: 900, color: '#d4a843', letterSpacing: 2, textTransform: 'uppercase' }}>
            SWU Trade
          </span>
          <span style={{ fontSize: 16, color: '#6b7280' }}>
            @ {pct}% TCGPlayer {priceLabel}
          </span>
        </div>

        {/* Balance */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 32 }}>
          <span style={{ fontSize: 32, fontWeight: 700, color: balanceColor }}>
            {balanceText}
          </span>
        </div>

        {/* Card lists side by side */}
        <div style={{ display: 'flex', gap: 48, flex: 1 }}>
          {renderCardList(yourCards, 'You', '#34d399')}
          {renderCardList(theirCards, 'Them', '#60a5fa')}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
          <span style={{ fontSize: 14, color: '#4b5563' }}>swutrade.com</span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
