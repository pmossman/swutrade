import { describe, expect, it } from 'vitest';
import { computeMatch } from './matchmaker';
import type { CardVariant } from '../types';

function card(productId: string, set: string, name: string, variant: string, market: number): CardVariant {
  return {
    name: variant === 'Standard' ? name : `${name} (${variant})`,
    variant,
    printing: 'Normal',
    rarity: 'Common',
    number: '1',
    marketPrice: market,
    lowPrice: market * 0.8,
    set,
    setName: set,
    productId,
  };
}

const CARDS = [
  card('100', 'jtl', 'Luke Skywalker - Hero of Yavin', 'Standard', 0.10),
  card('101', 'jtl', 'Luke Skywalker - Hero of Yavin', 'Hyperspace', 0.15),
  card('200', 'law', 'Cad Bane - Now Its My Turn', 'Standard', 2.00),
  card('201', 'law', 'Cad Bane - Now Its My Turn', 'Hyperspace', 4.00),
  card('300', 'law', 'Zuckuss - Dangerous', 'Hyperspace', 0.94),
  card('400', 'sec', 'Darth Vader - Dark Lord', 'Standard', 5.00),
  card('401', 'sec', 'Darth Vader - Dark Lord', 'Hyperspace', 8.00),
];

describe('computeMatch', () => {
  it('finds cards I can offer that they want', () => {
    const result = computeMatch(
      [],
      [{ productId: '200', qty: 1 }],
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
      [],
      CARDS,
      'market',
      100,
    );
    expect(result.offering).toHaveLength(1);
    expect(result.offering[0].productId).toBe('200');
    expect(result.receiving).toHaveLength(0);
  });

  it('finds cards I can receive that I want from their available', () => {
    const result = computeMatch(
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
      [],
      [],
      [{ productId: '201', qty: 1 }],
      CARDS,
      'market',
      100,
    );
    expect(result.receiving).toHaveLength(1);
    expect(result.receiving[0].productId).toBe('201');
    expect(result.offering).toHaveLength(0);
  });

  it('balances a mutual trade', () => {
    const result = computeMatch(
      // I want Darth Vader
      [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
      // I have Cad Bane Hyper + Zuckuss
      [{ productId: '201', qty: 1 }, { productId: '300', qty: 1 }],
      // They want Cad Bane
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
      // They have Darth Vader
      [{ productId: '400', qty: 1 }],
      CARDS,
      'market',
      100,
    );
    expect(result.offering.length).toBeGreaterThan(0);
    expect(result.receiving.length).toBeGreaterThan(0);
    expect(result.offeringTotal).toBeGreaterThan(0);
    expect(result.receivingTotal).toBeGreaterThan(0);
    expect(Math.abs(result.offeringTotal - result.receivingTotal)).toBeLessThan(2);
  });

  it('respects variant restrictions', () => {
    const result = computeMatch(
      [],
      [{ productId: '200', qty: 1 }, { productId: '201', qty: 1 }],
      // They want Cad Bane but only Hyperspace.
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'restricted', variants: ['Hyperspace'] } }],
      [],
      CARDS,
      'market',
      100,
    );
    expect(result.offering).toHaveLength(1);
    expect(result.offering[0].productId).toBe('201');
  });

  it('returns empty when there is no overlap', () => {
    const result = computeMatch(
      [{ familyId: 'jtl::luke-skywalker-hero-of-yavin', qty: 1, restriction: { mode: 'any' } }],
      [{ productId: '200', qty: 1 }],
      [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
      [{ productId: '300', qty: 1 }],
      CARDS,
      'market',
      100,
    );
    expect(result.offering).toHaveLength(0);
    expect(result.receiving).toHaveLength(0);
    expect(result.imbalance).toBe(0);
  });

  it('reports total overlap counts regardless of picked subset', () => {
    const result = computeMatch(
      [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
      [{ productId: '400', qty: 1 }],
      [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
      [{ productId: '200', qty: 1 }],
      CARDS,
      'market',
      100,
    );
    expect(result.overlapOffering).toBe(1);
    expect(result.overlapReceiving).toBe(1);
  });

  describe('imbalance', () => {
    it('reports |offeringTotal - receivingTotal| as the implied cash residual', () => {
      const result = computeMatch(
        // I want Cad Bane (any variant)
        [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
        // I offer Vader HS ($8)
        [{ productId: '401', qty: 1 }],
        // They want Vader
        [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
        // They have Cad Bane Std ($2) AND Cad Bane Hyper ($4), total $6
        [{ productId: '200', qty: 1 }, { productId: '201', qty: 1 }],
        CARDS,
        'market',
        100,
      );
      // Tightest balance: offering Vader ($8), receiving {Std + Hyper = $6}
      // → $2 imbalance, and the "more cards" tiebreaker prefers this
      // over the equally-balanced "offer nothing, receive Std only".
      expect(result.offering).toHaveLength(1);
      expect(result.receiving).toHaveLength(2);
      expect(result.imbalance).toBeCloseTo(2, 2);
    });

    it('echoes back the requested mode', () => {
      const myWants: Parameters<typeof computeMatch>[0] = [];
      const myAvail: Parameters<typeof computeMatch>[1] = [{ productId: '200', qty: 1 }];
      const theirWants: Parameters<typeof computeMatch>[2] = [
        { familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } },
      ];
      const theirAvail: Parameters<typeof computeMatch>[3] = [];
      expect(computeMatch(myWants, myAvail, theirWants, theirAvail, CARDS, 'market', 100).mode)
        .toBe('minimize-imbalance');
      expect(computeMatch(myWants, myAvail, theirWants, theirAvail, CARDS, 'market', 100, 'maximize-priorities').mode)
        .toBe('maximize-priorities');
    });
  });

  describe('minimize-imbalance: subset-sum correctness', () => {
    it('prefers the tightest-balance pair even when a larger pair would include more cards', () => {
      // Offering pool: one $5 card.
      // Receiving pool: one $10 card + one $4 card.
      // Greedy-by-price would pull $10 first, producing 5 vs 10 = $5 imbalance.
      // Subset-sum should instead pair $5 offering with $4 receiving = $1 imbalance.
      const result = computeMatch(
        [
          { familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } },
          { familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } },
        ],
        [{ productId: '400', qty: 1 }], // I offer Vader $5
        [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
        // They have Vader HS $8 AND Cad Bane Hyper $4 — but my wants list
        // only includes Vader and Cad Bane families, so both qualify.
        [{ productId: '401', qty: 1 }, { productId: '201', qty: 1 }],
        CARDS,
        'market',
        100,
      );
      // Best subset: offering $5 Vader, receiving $4 Cad Bane Hyper → $1 imbalance.
      expect(result.offering).toHaveLength(1);
      expect(result.offering[0].productId).toBe('400');
      expect(result.receiving).toHaveLength(1);
      expect(result.receiving[0].productId).toBe('201');
      expect(result.imbalance).toBeCloseTo(1, 2);
    });

    it('requires at least one card on either side (no degenerate empty trade)', () => {
      const result = computeMatch(
        [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
        [{ productId: '400', qty: 1 }],
        [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
        [{ productId: '200', qty: 1 }],
        CARDS,
        'market',
        100,
      );
      // Empty-subset pair would give 0 imbalance but is filtered out.
      expect(result.offering.length + result.receiving.length).toBeGreaterThan(0);
    });
  });

  describe('maximize-priorities mode', () => {
    it('force-includes every priority-starred overlap card', () => {
      const result = computeMatch(
        // I want Cad Bane (priority)
        [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' }, isPriority: true }],
        // I offer Vader HS ($8)
        [{ productId: '401', qty: 1 }],
        // They want Vader (priority)
        [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' }, isPriority: true }],
        // They have Cad Bane Std ($2)
        [{ productId: '200', qty: 1 }],
        CARDS,
        'market',
        100,
        'maximize-priorities',
      );
      // Both sides' priority wants resolve to a card → force-include each.
      expect(result.offering.map(c => c.productId)).toEqual(['401']);
      expect(result.receiving.map(c => c.productId)).toEqual(['200']);
      // And imbalance is allowed to be significant in this mode ($8 vs $2).
      expect(result.imbalance).toBeCloseTo(6, 2);
    });

    it('falls through to minimize-imbalance when no priority stars exist', () => {
      const priorityRes = computeMatch(
        [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
        [{ productId: '400', qty: 1 }],
        [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
        [{ productId: '200', qty: 1 }],
        CARDS,
        'market',
        100,
        'maximize-priorities',
      );
      const balanceRes = computeMatch(
        [{ familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' } }],
        [{ productId: '400', qty: 1 }],
        [{ familyId: 'law::cad-bane-now-its-my-turn', qty: 1, restriction: { mode: 'any' } }],
        [{ productId: '200', qty: 1 }],
        CARDS,
        'market',
        100,
      );
      expect(priorityRes.offering.map(c => c.productId)).toEqual(balanceRes.offering.map(c => c.productId));
      expect(priorityRes.receiving.map(c => c.productId)).toEqual(balanceRes.receiving.map(c => c.productId));
    });

    it('omits non-priority cards that would widen the imbalance', () => {
      // My wants: Vader (priority), Luke (non-priority).
      // My available: Vader HS ($8), Luke HS ($0.15).
      // Their wants: Vader (priority), Luke (non-priority).
      // Their available: Vader Std ($5) only.
      //
      // Priorities force offer Vader HS / receive Vader Std → $8 vs $5,
      // imbalance $3. Luke HS is the only non-priority candidate to add
      // to offering; doing so widens the gap to $3.15, so it should NOT
      // land.
      const result = computeMatch(
        [
          { familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' }, isPriority: true },
          { familyId: 'jtl::luke-skywalker-hero-of-yavin', qty: 1, restriction: { mode: 'any' } },
        ],
        [{ productId: '401', qty: 1 }, { productId: '101', qty: 1 }],
        [
          { familyId: 'sec::darth-vader-dark-lord', qty: 1, restriction: { mode: 'any' }, isPriority: true },
          { familyId: 'jtl::luke-skywalker-hero-of-yavin', qty: 1, restriction: { mode: 'any' } },
        ],
        [{ productId: '400', qty: 1 }],
        CARDS,
        'market',
        100,
        'maximize-priorities',
      );
      expect(result.offering.map(c => c.productId)).toEqual(['401']);
      expect(result.receiving.map(c => c.productId)).toEqual(['400']);
      expect(result.imbalance).toBeCloseTo(3, 2);
    });
  });
});
