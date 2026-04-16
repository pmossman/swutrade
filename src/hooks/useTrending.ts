import { useState, useEffect } from 'react';

export interface TrendingCard {
  familyId: string;
  userCount: number;
  totalQty: number;
}

export function useTrending(): TrendingCard[] {
  const [trending, setTrending] = useState<TrendingCard[]>([]);

  useEffect(() => {
    fetch('/api/trending')
      .then(r => r.ok ? r.json() : [])
      .then(data => setTrending(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  return trending;
}
