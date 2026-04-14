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

/**
 * Stable signature for a restriction. Two wants items with the same
 * (familyId, restrictionKey) are treated as the same item — adding
 * bumps qty rather than creating a duplicate row. Different keys
 * (e.g., Hyperspace vs Hyperspace Foil restrictions on the same
 * card) are tracked as separate items.
 */
function restrictionKey(r: VariantRestriction): string {
  if (r.mode === 'any') return 'any';
  return [...r.variants].sort().join('|');
}

function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

    const inputRestriction = input.restriction ?? { mode: 'any' as const };
    const inputKey = restrictionKey(inputRestriction);

    setItems(prev => {
      // Dedupe by (familyId + restriction signature) so tapping the
      // Hyperspace tile and the Standard tile of the same card produce
      // separate items rather than collapsing into one bumped qty with
      // the wrong restriction.
      const existing = prev.find(
        i => i.familyId === input.familyId && restrictionKey(i.restriction) === inputKey,
      );
      let next: WantsItem[];
      if (existing) {
        const bumped: WantsItem = {
          ...existing,
          qty: Math.min(99, existing.qty + qty),
          ...(input.isPriority !== undefined ? { isPriority: input.isPriority } : {}),
          ...(input.maxUnitPrice !== undefined ? { maxUnitPrice: input.maxUnitPrice } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        };
        created = bumped;
        next = prev.map(i => (i.id === existing.id ? bumped : i));
      } else {
        const fresh: WantsItem = {
          id: newId(),
          familyId: input.familyId,
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
