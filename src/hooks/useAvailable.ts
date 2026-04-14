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
    const qty = Math.min(99, Math.max(1, input.qty ?? 1));
    let created: AvailableItem | null = null;

    setItems(prev => {
      const existing = prev.find(i => i.productId === input.productId);
      let next: AvailableItem[];
      if (existing) {
        const bumped: AvailableItem = {
          ...existing,
          qty: Math.min(99, existing.qty + qty),
          ...(input.note !== undefined ? { note: input.note } : {}),
        };
        created = bumped;
        next = prev.map(i => (i.id === existing.id ? bumped : i));
      } else {
        const fresh: AvailableItem = {
          id: newId(),
          productId: input.productId,
          qty,
          note: input.note,
          addedAt: Date.now(),
        };
        created = fresh;
        next = [...prev, fresh];
      }
      writePersisted(PERSIST_KEYS.available, next);
      return next;
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

  return { items, add, update, remove, clear };
}
