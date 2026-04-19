import { useState, useEffect } from 'react';
import { apiGet } from '../services/apiClient';

export interface TrendingCard {
  familyId: string;
  userCount: number;
  totalQty: number;
}

export function useTrending(): TrendingCard[] {
  const [trending, setTrending] = useState<TrendingCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await apiGet<TrendingCard[]>('/api/trending');
      if (cancelled) return;
      if (result.ok && Array.isArray(result.data)) setTrending(result.data);
    })();
    return () => { cancelled = true; };
  }, []);

  return trending;
}
