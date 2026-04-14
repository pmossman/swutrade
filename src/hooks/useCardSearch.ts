import { useState, useEffect, useRef, useCallback } from 'react';
import type { CardVariant, CardGroup } from '../types';
import { SETS } from '../types';
import { groupCards, extractVariantLabel } from '../variants';

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

// Map lowercase aliases → set slug
const setAliases: Record<string, string> = {};
for (const s of SETS) {
  setAliases[s.code.toLowerCase()] = s.slug;
  // Also add slug words as aliases for common shorthand (e.g. "op" for organized-play-promos)
  if (s.category === 'promo') {
    // "op" → organized-play-promos, "judge" → judge-promos, etc.
    for (const word of s.slug.split('-')) {
      if (word.length >= 2 && !setAliases[word]) {
        setAliases[word] = s.slug;
      }
    }
  }
}
// Manual shorthand overrides
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

interface ParsedQuery {
  nameTerms: string[];
  setSlug: string | null;
  variantFilter: string | null;
}

function parseQuery(raw: string): ParsedQuery {
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

function localSearch(allCards: CardVariant[], query: string, setFilter: string | null): SetSearchGroup[] {
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
  let totalGroups = 0;

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

    // Limit total groups across all sets
    const remaining = 30 - totalGroups;
    if (remaining <= 0) break;
    const limited = groups.slice(0, remaining);
    totalGroups += limited.length;

    result.push({
      setSlug: slug,
      setCode: setInfo.code,
      setName: setInfo.name,
      groups: limited,
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
