import { describe, expect, it } from 'vitest';
import { parseIntentFromSearch, EMPTY_INTENT } from './useTradeIntent';

/**
 * Covers the URL-parsing reducer for useTradeIntent. The React bindings
 * (useState seed + popstate listener + imperative setters) are thin
 * glue over this pure function — if the parse is right and the setter
 * does an object spread, the hook is correct.
 *
 * See App.tsx's onProposeTo / handleStartTrade for the integration:
 * in-app pushState navigation now mirrors into intent state via
 * setIntent so we don't silently drop the propose/from/counter/edit
 * signal on a non-reload navigation.
 */
describe('parseIntentFromSearch', () => {
  it('seeds every field from the URL', () => {
    const intent = parseIntentFromSearch('propose=alice&from=bob&counter=c-1&edit=e-2&autoBalance=1');
    expect(intent).toEqual({
      propose: 'alice',
      from: 'bob',
      counter: 'c-1',
      edit: 'e-2',
      autoBalance: true,
    });
  });

  it('strips a leading @ from handle-valued params', () => {
    const intent = parseIntentFromSearch('propose=%40carol&from=%40dave');
    expect(intent.propose).toBe('carol');
    expect(intent.from).toBe('dave');
  });

  it('trims whitespace', () => {
    const intent = parseIntentFromSearch('propose=%20%20eve%20%20&counter=%20t-9%20');
    expect(intent.propose).toBe('eve');
    expect(intent.counter).toBe('t-9');
  });

  it('returns all-null / false for empty search', () => {
    expect(parseIntentFromSearch('')).toEqual(EMPTY_INTENT);
  });

  it('treats empty-string handle params as null', () => {
    const intent = parseIntentFromSearch('propose=&from=');
    expect(intent.propose).toBeNull();
    expect(intent.from).toBeNull();
  });

  it('treats autoBalance values other than "1" as false', () => {
    expect(parseIntentFromSearch('autoBalance=0').autoBalance).toBe(false);
    expect(parseIntentFromSearch('autoBalance=true').autoBalance).toBe(false);
    expect(parseIntentFromSearch('autoBalance=').autoBalance).toBe(false);
    expect(parseIntentFromSearch('autoBalance=1').autoBalance).toBe(true);
  });
});
