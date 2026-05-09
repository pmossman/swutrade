import { describe, it, expect } from 'vitest';
import { tcgProductId } from '../../lib/shared';

/**
 * `tcgProductId` strips our internal `:foil` suffix from a productId.
 * The suffix exists because TWI-era TCGPlayer products carry both
 * Normal and Foil printings under the SAME productId — we synthesize
 * a second `CardVariant` for the foil with a `${id}:foil` key so the
 * two records can coexist in our maps. URL/image lookups need the
 * raw numeric id back.
 */
describe('tcgProductId', () => {
  it('returns plain numeric productIds unchanged (no suffix)', () => {
    expect(tcgProductId('588451')).toBe('588451');
    expect(tcgProductId('660784')).toBe('660784');
  });

  it('strips a `:foil` suffix back to the raw numeric id', () => {
    expect(tcgProductId('588451:foil')).toBe('588451');
  });

  it('strips any colon-separated suffix (forward-compat for future printing keys)', () => {
    // The helper splits at the first colon — so a future "Hyperspace
    // Foil" key carried as `:hsfoil` would also resolve back to the
    // raw id. Defensive against the suffix vocabulary growing.
    expect(tcgProductId('588451:hsfoil')).toBe('588451');
    expect(tcgProductId('588451:something:weird')).toBe('588451');
  });

  it('returns undefined for undefined input — caller is responsible for null-checks', () => {
    expect(tcgProductId(undefined)).toBeUndefined();
  });

  it('returns empty string unchanged (no implicit defaulting)', () => {
    // Empty string is a degenerate productId we sometimes get from
    // the OG renderer's fallback path; consumers handle the empty
    // case themselves.
    expect(tcgProductId('')).toBe('');
  });

  it('handles a leading colon (treats it as suffix-only) — defensive against malformed input', () => {
    // Not a real-world case, but the implementation just splits at
    // the first colon; document the behavior.
    expect(tcgProductId(':foil')).toBe('');
  });
});
