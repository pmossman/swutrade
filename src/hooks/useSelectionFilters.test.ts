import { describe, expect, it } from 'vitest';
import {
  toggleVariantReducer,
  toggleSetReducer,
  replaceGroupReducer,
} from './useSelectionFilters';
import { MAIN_GROUP, SPECIAL_GROUP } from '../applySelectionFilters';

describe('toggleVariantReducer', () => {
  it('adds a new variant', () => {
    expect(toggleVariantReducer([], 'Hyperspace')).toEqual(['Hyperspace']);
  });

  it('removes a variant that was already selected', () => {
    expect(toggleVariantReducer(['Hyperspace', 'Showcase'], 'Hyperspace'))
      .toEqual(['Showcase']);
  });

  it('is a no-op-equivalent across two toggles', () => {
    const once = toggleVariantReducer(['Foil'], 'Hyperspace');
    const twice = toggleVariantReducer(once, 'Hyperspace');
    expect(twice).toEqual(['Foil']);
  });
});

describe('toggleSetReducer', () => {
  it('adds a specific set slug', () => {
    expect(toggleSetReducer([], 'jump-to-lightspeed'))
      .toEqual(['jump-to-lightspeed']);
  });

  it('removes a specific set slug that was already selected', () => {
    expect(toggleSetReducer(['jump-to-lightspeed', 'a-lawless-time'], 'jump-to-lightspeed'))
      .toEqual(['a-lawless-time']);
  });

  it('tapping a specific slug drops any active group preset', () => {
    // Mutual-exclusion invariant: users can't be simultaneously in
    // "Main preset" and "this specific main set" mode — tapping a
    // specific slug narrows them unambiguously to per-set selection.
    const next = toggleSetReducer([MAIN_GROUP], 'jump-to-lightspeed');
    expect(next).toEqual(['jump-to-lightspeed']);
  });

  it('tapping a group slug preserves other group slugs (neither mutually excluded here)', () => {
    // Group vs group mutual exclusion is handled by replaceGroupReducer;
    // toggleSetReducer only strips group slugs when toggling an
    // INDIVIDUAL set.
    const next = toggleSetReducer([MAIN_GROUP], SPECIAL_GROUP);
    expect(next).toEqual([MAIN_GROUP, SPECIAL_GROUP]);
  });

  it('tapping a group slug does not strip other group slugs', () => {
    // Consistency check: tapping a group slug starts from `prev` as-is
    // (per the "group-in, group-out" branch).
    const next = toggleSetReducer(['jump-to-lightspeed'], MAIN_GROUP);
    expect(next).toEqual(['jump-to-lightspeed', MAIN_GROUP]);
  });
});

describe('replaceGroupReducer', () => {
  it('returns [group] when a preset is chosen', () => {
    expect(replaceGroupReducer(MAIN_GROUP)).toEqual([MAIN_GROUP]);
    expect(replaceGroupReducer(SPECIAL_GROUP)).toEqual([SPECIAL_GROUP]);
  });

  it('returns [] when cleared', () => {
    expect(replaceGroupReducer(null)).toEqual([]);
  });

  it('does not preserve prior state — replaces outright', () => {
    // The reducer takes no prev arg; the hook uses it to wipe any
    // individual set chips when switching into broad-preset mode.
    // Documenting the contract so future changes don't add prev-merging
    // behavior without an explicit design decision.
    expect(replaceGroupReducer(MAIN_GROUP)).toEqual([MAIN_GROUP]);
    expect(replaceGroupReducer(MAIN_GROUP)).not.toContain('jump-to-lightspeed');
  });
});
