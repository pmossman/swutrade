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
  // Secondary index keyed by `${setCode}::${normalizedName}` — used as a
  // fallback when TCGPlayer ships a set without populated collector
  // numbers (e.g. SECW shipped Apr 2026 with empty `number` fields on
  // every row). Lossy for cards whose name parsing differs across
  // sources, so we only consult it after byCanonicalId misses.
  byNameKey: Map<string, SwuApiCard>;
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

function isTokenType(type: string | undefined): boolean {
  return type === 'Token Unit' || type === 'Token Upgrade';
}

/**
 * Lossy slug suitable for cross-source name lookups. Lowercases, replaces
 * non-alphanumeric runs with single hyphens, trims edge hyphens. Matches
 * the shape produced by joining "Name - Subtitle" with the same algorithm.
 */
export function nameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fullNameKey(setCode: string, name: string, subtitle: string | null): string {
  const full = subtitle ? `${name} - ${subtitle}` : name;
  return `${setCode.toUpperCase()}::${nameSlug(full)}`;
}

export function buildLookup(cards: SwuApiCard[]): EnrichmentLookup {
  const byCanonicalId = new Map<string, SwuApiCard>();
  const byNameKey = new Map<string, SwuApiCard>();
  for (const card of cards) {
    // Always derive the key via canonicalId so joins tolerate zero-padding
    // and fractional formats on either side. The stored swuapi record still
    // carries its original `id` for use as the baseCardId.
    const key = canonicalId(card.setCode, card.cardNumber);
    const existing = byCanonicalId.get(key);
    // swuapi occasionally lists a token (e.g. "Experience" Token Upgrade
    // under SHD_1) alongside a real card at the same canonical id
    // ("Gar Saxon" Leader at SHD_1). The TCGPlayer product matching
    // those positions is always the real card, never the token —
    // tokens aren't sold as standalone SKUs — so real types win.
    const newIsToken = isTokenType(card.type);
    const existingIsToken = existing ? isTokenType(existing.type) : false;
    if (!existing) {
      byCanonicalId.set(key, card);
    } else if (existingIsToken && !newIsToken) {
      byCanonicalId.set(key, card);
    } else if (!existingIsToken && newIsToken) {
      // keep existing
    } else if (card.variantType === 'Standard' && existing.variantType !== 'Standard') {
      // Same "tokenness" — prefer Standard variantType for metadata.
      byCanonicalId.set(key, card);
    }

    // Name-key index uses the same token-suppression preference. Built
    // independently so a card whose number lookup miss-routed (e.g.
    // empty TCGPlayer number) can still be matched by name.
    if (!isTokenType(card.type)) {
      const nKey = fullNameKey(card.setCode, card.name, card.subtitle);
      const exN = byNameKey.get(nKey);
      if (!exN || (card.variantType === 'Standard' && exN.variantType !== 'Standard')) {
        byNameKey.set(nKey, card);
      }
    }
  }
  return { byCanonicalId, byNameKey, total: byCanonicalId.size };
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
 *
 * Match strategy:
 *   1. By canonicalId (setCode + collector number) — fast, exact.
 *   2. Fallback by setCode + normalized name when (1) misses. Lossy but
 *      essential for sets where TCGPlayer ships empty number fields
 *      (SECW shipped Apr 2026 in this state).
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
  let match = lookup.byCanonicalId.get(canonicalId(setCode, card.number));
  if (!match) {
    // Strip the variant suffix from the TCGPlayer name so the key matches
    // what buildLookup stored from swuapi's name + subtitle.
    const baseName = card.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const nameKey = `${setCode.toUpperCase()}::${nameSlug(baseName)}`;
    match = lookup.byNameKey.get(nameKey);
  }
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
