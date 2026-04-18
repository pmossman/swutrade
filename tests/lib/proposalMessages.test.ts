import { describe, it, expect } from 'vitest';
import { buildProposalMessage } from '../../lib/proposalMessages.js';
import type { TradeCardSnapshot } from '../../lib/schema.js';

/**
 * Regression tests for the embed-field truncation fix (2026-04-18).
 * Before: a proposal with ~15+ cards crossed Discord's 1024-char
 * embed field value cap, returning 400 and failing the whole send.
 * Now: cards past the soft cap collapse to a "+N more" summary line
 * so the DM always delivers.
 */

function snap(name: string, variant = 'Standard', qty = 1, unitPrice = 1.23): TradeCardSnapshot {
  return { productId: `p-${name.slice(0, 8)}`, name, variant, qty, unitPrice };
}

function cardListField(body: ReturnType<typeof buildProposalMessage>, kind: 'offering' | 'asking') {
  const embed = body.embeds?.[0];
  const field = embed?.fields?.find(f => kind === 'offering'
    ? f.name.startsWith("They're offering")
    : f.name.startsWith("They're asking")
  );
  return field?.value ?? '';
}

describe('formatCardList truncation (via buildProposalMessage)', () => {
  const baseCtx = {
    tradeId: 'trade-trunc-test',
    proposerUserId: 'user-proposer',
    proposerHandle: 'alice',
    proposerUsername: 'Alice',
    receivingCards: [snap('Mace Windu')],
    message: null,
  };

  it('small proposals render every card (no summary line)', () => {
    const body = buildProposalMessage({
      ...baseCtx,
      offeringCards: Array.from({ length: 4 }, (_, i) => snap(`Card ${i}`)),
    });
    const offering = cardListField(body, 'offering');
    expect(offering).toMatch(/Card 0/);
    expect(offering).toMatch(/Card 3/);
    // No summary line.
    expect(offering).not.toMatch(/more — open the web app/);
  });

  it('oversized proposals truncate at the soft cap + emit a "+N more" summary', () => {
    // 40 cards with realistic-length SWU names guarantees overflow.
    const cards = Array.from({ length: 40 }, (_, i) =>
      snap(`Luke Skywalker - Hero of Yavin Variant #${i}`, 'Hyperspace Foil', 1, 12.34),
    );
    const body = buildProposalMessage({ ...baseCtx, offeringCards: cards });
    const offering = cardListField(body, 'offering');

    // Field length stays under Discord's hard 1024-char cap. Hitting
    // the cap is what caused the original bug.
    expect(offering.length).toBeLessThanOrEqual(1024);
    // Summary line present with a plausible N.
    const summaryMatch = offering.match(/_\+(\d+) more — open the web app for the full list_/);
    expect(summaryMatch).toBeTruthy();
    const hiddenCount = Number(summaryMatch?.[1] ?? '0');
    expect(hiddenCount).toBeGreaterThan(0);
    expect(hiddenCount).toBeLessThanOrEqual(cards.length);
    // First card still renders (we don't drop from the front).
    expect(offering).toMatch(/Variant #0/);
  });

  it('subtotal calculation includes ALL cards, not just the shown ones', () => {
    // Subtotal is on the field NAME (e.g. "They're offering ($X.XX)")
    // — must reflect the full value regardless of truncation, so the
    // recipient doesn't see a misleading "low" total.
    const cards = Array.from({ length: 40 }, () =>
      snap('Some Expensive Card With A Long Name', 'Hyperspace Foil', 1, 10.00),
    );
    const body = buildProposalMessage({ ...baseCtx, offeringCards: cards });
    const embed = body.embeds?.[0];
    const offeringField = embed?.fields?.find(f => f.name.startsWith("They're offering"));
    // 40 cards × $10 = $400 shown in the header regardless of truncation.
    expect(offeringField?.name).toContain('$400.00');
  });

  it('empty list renders the "_none_" placeholder (no truncation noise)', () => {
    const body = buildProposalMessage({
      ...baseCtx,
      offeringCards: [],
    });
    expect(cardListField(body, 'offering')).toBe('_none_');
  });
});
