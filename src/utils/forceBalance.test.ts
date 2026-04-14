import { describe, expect, it } from 'vitest';
import { computeBalance } from './forceBalance';

describe('computeBalance', () => {
  it('empty trade returns empty tier', () => {
    const b = computeBalance(0, 0, true);
    expect(b.tier).toBe('empty');
    expect(b.favored).toBe('none');
  });

  it('perfectly balanced trade is balanced tier, tone good', () => {
    const b = computeBalance(100, 100, false);
    expect(b.tier).toBe('balanced');
    expect(b.favored).toBe('none');
    expect(b.tone).toBe('good');
  });

  it('favors receiver when offering side is worth more', () => {
    const b = computeBalance(100, 50, false);
    expect(b.favored).toBe('them');
  });

  it('favors you when receiving side is worth more', () => {
    const b = computeBalance(50, 100, false);
    expect(b.favored).toBe('you');
  });

  it('clamps chaos to ripple under the $5 dollar floor', () => {
    // 200% skew, but $2 absolute gap → should stay at ripple.
    const b = computeBalance(3, 1, false);
    expect(b.tier).toBe('ripple');
  });

  it('clamps chaos to disturbance between $5 and $15 floors', () => {
    // 50% skew, $10 absolute gap → should be disturbance, not chaos.
    const b = computeBalance(30, 20, false);
    expect(b.tier).toBe('disturbance');
  });

  it('allows chaos above the $15 floor', () => {
    const b = computeBalance(100, 50, false);
    expect(b.tier).toBe('chaos');
  });
});
