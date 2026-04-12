import { useState, useEffect, useRef, useCallback } from 'react';
import type { CardVariant, CardGroup } from '../types';
import { SETS } from '../types';
import { groupCards } from '../services/priceService';

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

function localSearch(allCards: CardVariant[], query: string, setFilter: string | null): SetSearchGroup[] {
  const q = query.toLowerCase().trim();
  const queryTerms = q.split(/\s+/);

  let filtered = allCards;
  if (setFilter) {
    filtered = filtered.filter(c => c.set === setFilter);
  }

  filtered = filtered.filter(card => {
    const nameLower = card.name.toLowerCase();
    return queryTerms.every(term => nameLower.includes(term));
  });

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
    groups.sort((a, b) => {
      const aStarts = a.baseName.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.baseName.toLowerCase().startsWith(q) ? 0 : 1;
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
