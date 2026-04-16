import { useCallback, useState } from 'react';
import {
  PERSIST_KEYS,
  WantsListSchema,
  DEFAULTS,
  readPersisted,
  writePersisted,
  type WantsItem,
  type VariantRestriction,
} from '../persistence';
import { CANONICAL_VARIANTS } from '../variants';

/**
 * Collapse a "restricted to every canonical variant" restriction back
 * to { mode: 'any' }. Matches two cases:
 *   - all current canonical variants selected (10)
 *   - all original canonical variants selected (8, pre-Gold/Rose-Gold)
 */
export function normalizeRestriction(r: VariantRestriction): VariantRestriction {
  if (r.mode === 'any') return r;
  const selected = new Set(r.variants);
  if (CANONICAL_VARIANTS.every(v => selected.has(v))) return { mode: 'any' };
  const ORIGINAL_COUNT = 8;
  if (
    r.variants.length === ORIGINAL_COUNT &&
    CANONICAL_VARIANTS.slice(0, ORIGINAL_COUNT).every(v => selected.has(v))
  ) {
    return { mode: 'any' };
  }
  return r;
}

/**
 * Stable signature for a restriction. Two wants items with the same
 * (familyId, restrictionKey) are treated as the same item — adding
 * bumps qty rather than creating a duplicate row. Different keys
 * (e.g., Hyperspace vs Hyperspace Foil restrictions on the same
 * card) are tracked as separate items.
 *
 * Shared with API sync endpoints via lib/shared.ts re-export.
 */
export function restrictionKey(r: VariantRestriction): string {
  if (r.mode === 'any') return 'any';
  return [...r.variants].sort().join('|');
}

function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Pure reducer factored out of the hook so the dedup-by-(familyId,
// restriction) invariant can be tested without a React renderer.
// The caller supplies id + now generators so tests can pin them.
export interface WantsAddDeps {
  newId: () => string;
  now: () => number;
}

export function wantsAddReducer(
  items: readonly WantsItem[],
  input: WantsInput,
  deps: WantsAddDeps,
): { items: WantsItem[]; created: WantsItem } {
  const qty = Math.min(99, Math.max(1, input.qty ?? 1));
  const inputRestriction = input.restriction ?? { mode: 'any' as const };
  const inputKey = restrictionKey(inputRestriction);

  const existing = items.find(
    i => i.familyId === input.familyId && restrictionKey(i.restriction) === inputKey,
  );

  if (existing) {
    const bumped: WantsItem = {
      ...existing,
      qty: Math.min(99, existing.qty + qty),
      ...(input.isPriority !== undefined ? { isPriority: input.isPriority } : {}),
      ...(input.maxUnitPrice !== undefined ? { maxUnitPrice: input.maxUnitPrice } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    return {
      items: items.map(i => (i.id === existing.id ? bumped : i)),
      created: bumped,
    };
  }

  const fresh: WantsItem = {
    id: deps.newId(),
    familyId: input.familyId,
    qty,
    restriction: inputRestriction,
    maxUnitPrice: input.maxUnitPrice,
    note: input.note,
    isPriority: input.isPriority || undefined,
    addedAt: deps.now(),
  };
  return {
    items: [...items, fresh],
    created: fresh,
  };
}

export interface WantsInput {
  familyId: string;
  qty?: number;
  restriction?: VariantRestriction;
  maxUnitPrice?: number;
  note?: string;
  isPriority?: boolean;
}

export interface WantsApi {
  items: WantsItem[];
  /** Add a wants item. If the same familyId is already saved, bumps qty
   *  instead of creating a duplicate row. */
  add: (input: WantsInput) => WantsItem;
  update: (id: string, patch: Partial<Omit<WantsItem, 'id'>>) => void;
  remove: (id: string) => void;
  togglePriority: (id: string) => void;
  clear: () => void;
  /** Replace the entire list (used by server sync writeback). */
  setAll: (items: WantsItem[]) => void;
}

export function useWants(): WantsApi {
  const [items, setItems] = useState<WantsItem[]>(
    () => {
      const raw = readPersisted(PERSIST_KEYS.wants, WantsListSchema, DEFAULTS.wants);
      const normalized = raw.map(item => {
        const nr = normalizeRestriction(item.restriction);
        return nr === item.restriction ? item : { ...item, restriction: nr };
      });
      if (normalized.some((item, i) => item !== raw[i])) {
        writePersisted(PERSIST_KEYS.wants, normalized);
      }
      return normalized;
    },
  );

  const persist = useCallback((next: WantsItem[]) => {
    setItems(next);
    writePersisted(PERSIST_KEYS.wants, next);
  }, []);

  const add = useCallback((input: WantsInput): WantsItem => {
    let created: WantsItem | null = null;
    setItems(prev => {
      const result = wantsAddReducer(prev, input, { newId, now: Date.now });
      created = result.created;
      writePersisted(PERSIST_KEYS.wants, result.items);
      return result.items;
    });
    // setState callback is synchronous with React 19's useState — `created`
    // is populated before we return.
    return created as unknown as WantsItem;
  }, []);

  const update = useCallback((id: string, patch: Partial<Omit<WantsItem, 'id'>>) => {
    setItems(prev => {
      const next = prev.map(i => (i.id === id ? { ...i, ...patch } : i));
      writePersisted(PERSIST_KEYS.wants, next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setItems(prev => {
      const next = prev.filter(i => i.id !== id);
      writePersisted(PERSIST_KEYS.wants, next);
      return next;
    });
  }, []);

  const togglePriority = useCallback((id: string) => {
    setItems(prev => {
      const next = prev.map(i =>
        i.id === id ? { ...i, isPriority: !i.isPriority } : i,
      );
      writePersisted(PERSIST_KEYS.wants, next);
      return next;
    });
  }, []);

  const clear = useCallback(() => persist([]), [persist]);

  const setAll = useCallback((next: WantsItem[]) => persist(next), [persist]);

  return { items, add, update, remove, togglePriority, clear, setAll };
}
