// Pure helpers for joining TCGPlayer card rows with swuapi.com metadata.
// All functions here are pure (no I/O) so the build-time enrichment script
// and unit tests can share the same logic.

import type { CardVariant, CardType } from './types';
import { synthesizeBaseCardId } from './variants';

export interface SwuApiCard {
  uuid: string;
  externalId: number;
  id: string; // e.g. "SOR_005" — setCode + "_" + cardNumber
  name: string;
  subtitle: string | null;
  setCode: string;
  cardNumber: string;
  type: string;
  variantType: string;
  aspects?: string[];
  traits?: string[];
  isLeader?: boolean;
  isBase?: boolean;
}

export interface EnrichmentLookup {
  // Keyed by the same format swuapi uses for `id`: `${setCode}_${canonicalNumber}`.
  byCanonicalId: Map<string, SwuApiCard>;
  // Count of cards indexed; useful for CLI summaries.
  total: number;
}

// Collector numbers come from TCGPlayer in two shapes: "5" (plain) or
// "224/264" (ordinal-of-total). Occasionally padded to "005". swuapi uses
// a plain integer string without padding. Normalize to the plain form so
// join keys line up.
export function normalizeCardNumber(raw: string): string {
  if (!raw) return '';
  const primary = raw.split('/')[0].trim();
  // Strip leading zeros but preserve "0" itself.
  const stripped = primary.replace(/^0+(?=\d)/, '');
  return stripped;
}

export function canonicalId(setCode: string, cardNumber: string): string {
  return `${setCode.toUpperCase()}_${normalizeCardNumber(cardNumber)}`;
}

export function buildLookup(cards: SwuApiCard[]): EnrichmentLookup {
  const byCanonicalId = new Map<string, SwuApiCard>();
  for (const card of cards) {
    // Always derive the key via canonicalId so joins tolerate zero-padding
    // and fractional formats on either side. The stored swuapi record still
    // carries its original `id` for use as the baseCardId.
    const key = canonicalId(card.setCode, card.cardNumber);
    const existing = byCanonicalId.get(key);
    // Prefer Standard variants for metadata — they're the canonical record
    // for a card's type/aspects/traits. If we see Standard after a non-
    // Standard, upgrade to Standard. Otherwise first-wins.
    if (!existing || (card.variantType === 'Standard' && existing.variantType !== 'Standard')) {
      byCanonicalId.set(key, card);
    }
  }
  return { byCanonicalId, total: byCanonicalId.size };
}

// Map a swuapi `type` string onto our CardType union. Returns undefined
// for unrecognized strings so we don't silently coerce garbage.
export function normalizeCardType(raw: string | undefined): CardType | undefined {
  switch (raw) {
    case 'Leader':        return 'Leader';
    case 'Base':          return 'Base';
    case 'Unit':          return 'Unit';
    case 'Event':         return 'Event';
    case 'Upgrade':       return 'Upgrade';
    case 'Token Unit':    return 'Token Unit';
    case 'Token Upgrade': return 'Token Upgrade';
    default:              return undefined;
  }
}

export interface EnrichOptions {
  // Map from our internal set slugs to swuapi set codes. Built from SETS
  // at call time. Passed in rather than imported so this module stays pure.
  slugToCode: Record<string, string>;
}

/**
 * Return an enriched copy of the card. When a swuapi match is found, adds
 * baseCardId + metadata; otherwise falls back to a synthesized baseCardId
 * so downstream code can always assume the field exists.
 */
export function enrichCard(
  card: CardVariant,
  lookup: EnrichmentLookup,
  opts: EnrichOptions,
): CardVariant {
  const setCode = opts.slugToCode[card.set];
  if (!setCode) {
    return { ...card, baseCardId: synthesizeBaseCardId(card) };
  }
  const key = canonicalId(setCode, card.number);
  const match = lookup.byCanonicalId.get(key);
  if (!match) {
    return { ...card, baseCardId: synthesizeBaseCardId(card) };
  }
  const displayName = match.subtitle
    ? `${match.name} - ${match.subtitle}`
    : match.name;
  return {
    ...card,
    baseCardId: match.id,
    displayName,
    cardType: normalizeCardType(match.type),
    aspects: match.aspects,
    traits: match.traits,
  };
}
