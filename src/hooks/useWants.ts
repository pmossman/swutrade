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

function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface WantsInput {
  baseCardId: string;
  qty?: number;
  restriction?: VariantRestriction;
  maxUnitPrice?: number;
  note?: string;
  isPriority?: boolean;
}

export interface WantsApi {
  items: WantsItem[];
  /** Add a wants item. If the same baseCardId is already saved, bumps qty
   *  instead of creating a duplicate row. */
  add: (input: WantsInput) => WantsItem;
  update: (id: string, patch: Partial<Omit<WantsItem, 'id'>>) => void;
  remove: (id: string) => void;
  togglePriority: (id: string) => void;
  clear: () => void;
}

export function useWants(): WantsApi {
  const [items, setItems] = useState<WantsItem[]>(
    () => readPersisted(PERSIST_KEYS.wants, WantsListSchema, DEFAULTS.wants),
  );

  const persist = useCallback((next: WantsItem[]) => {
    setItems(next);
    writePersisted(PERSIST_KEYS.wants, next);
  }, []);

  const add = useCallback((input: WantsInput): WantsItem => {
    const qty = Math.min(99, Math.max(1, input.qty ?? 1));
    let created: WantsItem | null = null;

    setItems(prev => {
      const existing = prev.find(i => i.baseCardId === input.baseCardId);
      let next: WantsItem[];
      if (existing) {
        const bumped: WantsItem = {
          ...existing,
          qty: Math.min(99, existing.qty + qty),
          // Allow the caller to upgrade restriction / priority on re-add.
          ...(input.restriction ? { restriction: input.restriction } : {}),
          ...(input.isPriority !== undefined ? { isPriority: input.isPriority } : {}),
          ...(input.maxUnitPrice !== undefined ? { maxUnitPrice: input.maxUnitPrice } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        };
        created = bumped;
        next = prev.map(i => (i.id === existing.id ? bumped : i));
      } else {
        const fresh: WantsItem = {
          id: newId(),
          baseCardId: input.baseCardId,
          qty,
          restriction: input.restriction ?? { mode: 'any' },
          maxUnitPrice: input.maxUnitPrice,
          note: input.note,
          isPriority: input.isPriority || undefined,
          addedAt: Date.now(),
        };
        created = fresh;
        next = [...prev, fresh];
      }
      writePersisted(PERSIST_KEYS.wants, next);
      return next;
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

  return { items, add, update, remove, togglePriority, clear };
}
