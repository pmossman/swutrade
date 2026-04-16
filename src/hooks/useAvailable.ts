import { useCallback, useState } from 'react';
import {
  PERSIST_KEYS,
  AvailableListSchema,
  DEFAULTS,
  readPersisted,
  writePersisted,
  type AvailableItem,
} from '../persistence';

function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `a_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Pure reducer factored out of the hook so the dedup-by-productId
// invariant can be tested without a React renderer.
export interface AvailableAddDeps {
  newId: () => string;
  now: () => number;
}

export function availableAddReducer(
  items: readonly AvailableItem[],
  input: AvailableInput,
  deps: AvailableAddDeps,
): { items: AvailableItem[]; created: AvailableItem } {
  const qty = Math.min(99, Math.max(1, input.qty ?? 1));
  const existing = items.find(i => i.productId === input.productId);

  if (existing) {
    const bumped: AvailableItem = {
      ...existing,
      qty: Math.min(99, existing.qty + qty),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    return {
      items: items.map(i => (i.id === existing.id ? bumped : i)),
      created: bumped,
    };
  }

  const fresh: AvailableItem = {
    id: deps.newId(),
    productId: input.productId,
    qty,
    note: input.note,
    addedAt: deps.now(),
  };
  return {
    items: [...items, fresh],
    created: fresh,
  };
}

export interface AvailableInput {
  productId: string;
  qty?: number;
  note?: string;
}

export interface AvailableApi {
  items: AvailableItem[];
  /** Add an available item. If the same productId is already saved, bumps
   *  qty instead of creating a duplicate row. */
  add: (input: AvailableInput) => AvailableItem;
  update: (id: string, patch: Partial<Omit<AvailableItem, 'id'>>) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Replace the entire list (used by server sync writeback). */
  setAll: (items: AvailableItem[]) => void;
}

export function useAvailable(): AvailableApi {
  const [items, setItems] = useState<AvailableItem[]>(
    () => readPersisted(PERSIST_KEYS.available, AvailableListSchema, DEFAULTS.available),
  );

  const persist = useCallback((next: AvailableItem[]) => {
    setItems(next);
    writePersisted(PERSIST_KEYS.available, next);
  }, []);

  const add = useCallback((input: AvailableInput): AvailableItem => {
    let created: AvailableItem | null = null;
    setItems(prev => {
      const result = availableAddReducer(prev, input, { newId, now: Date.now });
      created = result.created;
      writePersisted(PERSIST_KEYS.available, result.items);
      return result.items;
    });
    return created as unknown as AvailableItem;
  }, []);

  const update = useCallback((id: string, patch: Partial<Omit<AvailableItem, 'id'>>) => {
    setItems(prev => {
      const next = prev.map(i => (i.id === id ? { ...i, ...patch } : i));
      writePersisted(PERSIST_KEYS.available, next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setItems(prev => {
      const next = prev.filter(i => i.id !== id);
      writePersisted(PERSIST_KEYS.available, next);
      return next;
    });
  }, []);

  const clear = useCallback(() => persist([]), [persist]);

  const setAll = useCallback((next: AvailableItem[]) => persist(next), [persist]);

  return { items, add, update, remove, clear, setAll };
}
