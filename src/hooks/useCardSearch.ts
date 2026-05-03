import { useState, useEffect, useRef, useCallback } from 'react';
import type { CardVariant, CardGroup } from '../types';
import { SETS } from '../types';
import { groupCards, extractVariantLabel, isLeaderOrBaseGroup } from '../variants';

function parseCardNumber(num: string): number {
  const match = num.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 9999;
}

/**
 * Sort key for a card group within its set. Uses the *minimum* card
 * number across every printing, which is reliably the Standard
 * (base-set) number — non-Standard printings (Hyperspace, Prestige,
 * Showcase, Serialized) carry sequential collector numbers that run
 * far past the Standard 1-N range. Reading from `variants[0]` alone
 * sorted by whichever printing happened to come first in the source
 * data, which silently demoted any card whose first-iterated variant
 * wasn't Standard. */
function groupSortNumber(variants: readonly CardVariant[]): number {
  let min = 9999;
  for (const v of variants) {
    const n = parseCardNumber(v.number ?? '');
    if (n < min) min = n;
  }
  return min;
}

// Browse order: main sets first (latest main at the top — LAW before
// JTL before LOF ... before SOR), then promo sets in declaration order.
// This is the order users expect when scrolling the catalog — the
// latest playable release is what they care about seeing first.
const BROWSE_ORDER: string[] = [
  ...SETS.filter(s => s.category === 'main').map(s => s.slug).reverse(),
  ...SETS.filter(s => s.category === 'promo').map(s => s.slug),
];

/**
 * Query-less browse mode: every card in the dataset, grouped by set
 * and by base name within a set (ascending card number). Used by the
 * search surfaces when the user hasn't typed anything — they can
 * still scroll through the catalog while filters narrow what's
 * visible. Virtualization handles the render cost, so we don't cap
 * the group count (capping would silently drop promo sets below the
 * main sets that fill the budget first).
 */
export function browseAllGroups(allCards: CardVariant[]): SetSearchGroup[] {
  const bySet: Record<string, CardVariant[]> = {};
  for (const card of allCards) {
    if (!bySet[card.set]) bySet[card.set] = [];
    bySet[card.set].push(card);
  }

  const result: SetSearchGroup[] = [];
  for (const slug of BROWSE_ORDER) {
    const cards = bySet[slug];
    if (!cards || cards.length === 0) continue;
    const setInfo = SETS.find(s => s.slug === slug);
    if (!setInfo) continue;
    const groups = groupCards(cards);
    // Leaders and bases sink to the bottom of each set — playable
    // tradable cards (units/events/upgrades) are what people scroll
    // for, and the leader/base splash art otherwise eats the first
    // several rows. Within each bucket, sort ascending by card number.
    groups.sort((a, b) => {
      const aLeader = isLeaderOrBaseGroup(a.variants) ? 1 : 0;
      const bLeader = isLeaderOrBaseGroup(b.variants) ? 1 : 0;
      if (aLeader !== bLeader) return aLeader - bLeader;
      return groupSortNumber(a.variants) - groupSortNumber(b.variants);
    });
    result.push({
      setSlug: slug,
      setCode: setInfo.code,
      setName: setInfo.name,
      groups,
    });
  }
  return result;
}

export interface SetSearchGroup {
  setSlug: string;
  setCode: string;
  setName: string;
  groups: CardGroup[];
}

interface UseCardSearchProps {
  allCards: CardVariant[];
  setFilter: string | null;
}

// Reverse index: latest set = 0 (highest priority)
const setOrder = Object.fromEntries(
  SETS.map((s, i) => [s.slug, SETS.length - 1 - i])
);

// --- Smart query parsing: detect set codes and variant keywords ---
//
// Aliases must be unambiguous — a misclassified token routes a search
// to the wrong set silently. Set codes (sor, jtl, sec, …) are short
// and don't collide with English. Slug-word aliases (e.g. "judge" →
// judge-promos) used to be auto-generated but caused real false
// positives — "of" mapped to ashes-of-the-empire, so a swap-variant
// seed like "Luke Skywalker - Hero of Yavin" routed the search to
// ATE and returned nothing. Stick to set codes plus the few
// hand-curated overrides below.

const setAliases: Record<string, string> = {};
for (const s of SETS) {
  setAliases[s.code.toLowerCase()] = s.slug;
}
// Manual shorthand overrides — short, unambiguous tokens that aren't
// SETS[].code values but are useful day-to-day.
setAliases['op'] = 'organized-play-promos';
setAliases['srp'] = 'sector-and-regional-promos-season-1';

// Map lowercase aliases → variant label to filter on
const variantAliases: Record<string, string> = {
  'standard': 'Standard',
  'std': 'Standard',
  'hyperspace': 'Hyperspace',
  'hyper': 'Hyperspace',
  'hs': 'Hyperspace',
  'hsf': 'Hyperspace Foil',
  'hyperfoil': 'Hyperspace Foil',
  'showcase': 'Showcase',
  'sc': 'Showcase',
};

export interface ParsedQuery {
  nameTerms: string[];
  setSlug: string | null;
  variantFilter: string | null;
}

export function parseQuery(raw: string): ParsedQuery {
  const tokens = raw.toLowerCase().trim().split(/\s+/);
  let setSlug: string | null = null;
  let variantFilter: string | null = null;
  const nameTerms: string[] = [];

  for (const token of tokens) {
    if (!setSlug && setAliases[token]) {
      setSlug = setAliases[token];
    } else if (!variantFilter && variantAliases[token]) {
      variantFilter = variantAliases[token];
    } else {
      nameTerms.push(token);
    }
  }

  return { nameTerms, setSlug, variantFilter };
}

export function localSearch(allCards: CardVariant[], query: string, setFilter: string | null): SetSearchGroup[] {
  const parsed = parseQuery(query);
  const { nameTerms, setSlug: querySetSlug, variantFilter } = parsed;

  // If the parsed query consumed everything as filters with no name terms,
  // and we have fewer than 2 chars of actual name to search, return empty
  // unless there's a meaningful filter applied
  const rawLen = query.trim().length;
  if (nameTerms.length === 0 && !querySetSlug && !variantFilter && rawLen < 2) {
    return [];
  }

  let filtered = allCards;

  // Apply set filter: explicit dropdown filter takes priority, then query-parsed set
  const effectiveSetFilter = setFilter || querySetSlug;
  if (effectiveSetFilter) {
    filtered = filtered.filter(c => c.set === effectiveSetFilter);
  }

  // Apply variant filter from query
  if (variantFilter) {
    filtered = filtered.filter(card => {
      const label = extractVariantLabel(card.name);
      // "Hyperspace" should match both "Hyperspace" and "Hyperspace Foil"
      if (variantFilter === 'Hyperspace') {
        return label.startsWith('Hyperspace');
      }
      return label === variantFilter;
    });
  }

  // Apply name terms
  if (nameTerms.length > 0) {
    filtered = filtered.filter(card => {
      const nameLower = card.name.toLowerCase();
      return nameTerms.every(term => nameLower.includes(term));
    });
  }

  // Group by set first, then by baseName within each set
  const bySet: Record<string, CardVariant[]> = {};
  for (const card of filtered) {
    if (!bySet[card.set]) bySet[card.set] = [];
    bySet[card.set].push(card);
  }

  // Sort sets by reverse chronological order (LAW first)
  const setEntries = Object.entries(bySet).sort(
    ([a], [b]) => (setOrder[a] ?? 99) - (setOrder[b] ?? 99)
  );

  const result: SetSearchGroup[] = [];

  for (const [slug, cards] of setEntries) {
    const setInfo = SETS.find(s => s.slug === slug);
    if (!setInfo) continue;

    const groups = groupCards(cards);
    const nameQuery = nameTerms.join(' ');
    groups.sort((a, b) => {
      const aStarts = a.baseName.toLowerCase().startsWith(nameQuery) ? 0 : 1;
      const bStarts = b.baseName.toLowerCase().startsWith(nameQuery) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.baseName.length - b.baseName.length;
    });

    // No cap: CardResultsGrid uses @tanstack/react-virtual, so DOM
    // cost is bounded by viewport regardless of group count. The
    // earlier 30-group ceiling silently clipped older sets out of
    // wide filter queries (e.g. a bare "showcase" returned LAW + the
    // first dozen of JTL and dropped LOF / SEC / TWI / SHD / SOR
    // entirely). Effectively-infinite scroll is the right shape here
    // since the underlying data is in-memory and synchronous.
    result.push({
      setSlug: slug,
      setCode: setInfo.code,
      setName: setInfo.name,
      groups,
    });
  }

  return result;
}

export function useCardSearch({ allCards, setFilter }: UseCardSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SetSearchGroup[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep latest allCards in a ref so the debounced effect doesn't
  // restart every time the cards array identity changes.
  const allCardsRef = useRef(allCards);
  allCardsRef.current = allCards;

  const setFilterRef = useRef(setFilter);
  setFilterRef.current = setFilter;

  // When allCards loads/changes and we have an active query, re-run immediately
  const prevCardsLenRef = useRef(allCards.length);
  useEffect(() => {
    if (allCards.length !== prevCardsLenRef.current) {
      prevCardsLenRef.current = allCards.length;
      const q = query.trim();
      if (q.length >= 2 && allCards.length > 0) {
        setResults(localSearch(allCards, q, setFilter));
        setIsSearching(false);
      }
    }
  }, [allCards, query, setFilter]);

  // Debounced search triggered by query/setFilter changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);

    debounceRef.current = setTimeout(() => {
      const cards = allCardsRef.current;
      const filter = setFilterRef.current;
      setResults(localSearch(cards, q, filter));
      setIsSearching(false);
    }, 150); // Faster debounce since search is now purely local

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, setFilter]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setResults([]);
  }, []);

  return {
    query,
    setQuery,
    results,
    isSearching,
    clearSearch,
  };
}
