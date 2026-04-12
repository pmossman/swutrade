export interface CardVariant {
  name: string;
  variant: string; // "Standard", "Hyperspace", "Hyperspace Foil", "Showcase", etc.
  printing: string;
  rarity: string;
  number: string;
  marketPrice: number | null;
  set: string;
  setName: string;
  productId?: string;
}

export interface CardGroup {
  baseName: string;
  variants: CardVariant[];
}

export interface TradeCard {
  card: CardVariant;
  qty: number;
}

// Unique key for deduplication — same card variant in the same set
export function tradeCardKey(card: CardVariant): string {
  return `${card.productId || card.name}-${card.set}`;
}

export type TradeSide = 'you' | 'them';

export interface SetInfo {
  slug: string;
  code: string;
  name: string;
  category?: 'main' | 'promo';
}

// Main expansion sets
export const SETS: SetInfo[] = [
  { slug: 'spark-of-rebellion', code: 'SOR', name: 'Spark of Rebellion', category: 'main' },
  { slug: 'shadows-of-the-galaxy', code: 'SHD', name: 'Shadows of the Galaxy', category: 'main' },
  { slug: 'twilight-of-the-republic', code: 'TWI', name: 'Twilight of the Republic', category: 'main' },
  { slug: 'secrets-of-power', code: 'SEC', name: 'Secrets of Power', category: 'main' },
  { slug: 'legends-of-the-force', code: 'LOF', name: 'Legends of the Force', category: 'main' },
  { slug: 'jump-to-lightspeed', code: 'JTL', name: 'Jump to Lightspeed', category: 'main' },
  { slug: 'a-lawless-time', code: 'LAW', name: 'A Lawless Time', category: 'main' },
  // Promo & special sets
  { slug: 'organized-play-promos', code: 'OPP', name: 'Organized Play Promos', category: 'promo' },
  { slug: 'sector-and-regional-promos-season-1', code: 'SRP', name: 'Sector & Regional Promos S1', category: 'promo' },
  { slug: 'judge-promos', code: 'JP', name: 'Judge Promos', category: 'promo' },
  { slug: 'twin-suns', code: 'TS', name: 'Twin Suns', category: 'promo' },
  { slug: 'intro-battle-hoth', code: 'IBH', name: 'Intro Battle: Hoth', category: 'promo' },
  { slug: 'a-lawless-time-weekly-play-promos', code: 'LAWW', name: 'LAW Weekly Play Promos', category: 'promo' },
  { slug: 'jump-to-lightspeed-weekly-play-promos', code: 'JTLW', name: 'JTL Weekly Play Promos', category: 'promo' },
  { slug: 'secrets-of-power-weekly-play-promos', code: 'SECW', name: 'SEC Weekly Play Promos', category: 'promo' },
  { slug: 'legends-of-the-force-weekly-play-promos', code: 'LOFW', name: 'LOF Weekly Play Promos', category: 'promo' },
  { slug: 'twilight-of-the-republic-weekly-play-promos', code: 'TWIW', name: 'TWI Weekly Play Promos', category: 'promo' },
  { slug: 'shadows-of-the-galaxy-weekly-play-promos', code: 'SHDW', name: 'SHD Weekly Play Promos', category: 'promo' },
  { slug: 'spark-of-rebellion-weekly-play-promos', code: 'SORW', name: 'SOR Weekly Play Promos', category: 'promo' },
  { slug: '2025-convention-exclusive', code: 'CON25', name: '2025 Convention Exclusive', category: 'promo' },
  { slug: '2024-convention-exclusive', code: 'CON24', name: '2024 Convention Exclusive', category: 'promo' },
  { slug: 'prerelease-promos', code: 'PRP', name: 'Prerelease Promos', category: 'promo' },
  { slug: 'gamegenic-promos', code: 'GGP', name: 'Gamegenic Promos', category: 'promo' },
  { slug: 'event-exclusive-promos', code: 'EEP', name: 'Event Exclusive Promos', category: 'promo' },
  { slug: '2025-gift-box', code: 'GB25', name: '2025 Gift Box', category: 'promo' },
  { slug: 'ashes-of-the-empire', code: 'ATE', name: 'Ashes of the Empire', category: 'promo' },
];
