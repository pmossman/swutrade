import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Single shared open/closed state for the Lists drawer. Before this,
 * each view that wanted the drawer held its own `listsDrawerOpen`
 * boolean + rendered its own `<ListsDrawer>` instance; the drawer's
 * inner state (active tab, picker mode) reset every navigation.
 *
 * With this context, the drawer renders exactly once at App root and
 * any view can toggle it via `openLists()` / `closeLists()`.
 */
export interface DrawerContextValue {
  listsDrawerOpen: boolean;
  openLists: () => void;
  closeLists: () => void;
  /** Raw setter for components that need to hand a controlled-open
   *  prop through to a Radix dialog — the open/close helpers aren't
   *  granular enough there. */
  setListsDrawerOpen: (next: boolean) => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [listsDrawerOpen, setListsDrawerOpen] = useState(false);
  const openLists = useCallback(() => setListsDrawerOpen(true), []);
  const closeLists = useCallback(() => setListsDrawerOpen(false), []);
  const value = useMemo<DrawerContextValue>(
    () => ({ listsDrawerOpen, openLists, closeLists, setListsDrawerOpen }),
    [listsDrawerOpen, openLists, closeLists],
  );
  return <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>;
}

export function useDrawerContext(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error('useDrawerContext must be used inside DrawerProvider');
  return ctx;
}
