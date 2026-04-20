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
export type ListsDrawerTab = 'wants' | 'available';

export interface DrawerContextValue {
  listsDrawerOpen: boolean;
  /** Open the drawer. Optional `tab` hint — when set, the drawer will
   *  switch to that tab on next mount/open. Home's per-list modules
   *  use this so tapping "Edit wishlist" lands on the wants tab and
   *  "Edit binder" lands on the available tab. Undefined preserves
   *  whatever tab the drawer was last on. */
  openLists: (tab?: ListsDrawerTab) => void;
  closeLists: () => void;
  /** Raw setter for components that need to hand a controlled-open
   *  prop through to a Radix dialog — the open/close helpers aren't
   *  granular enough there. */
  setListsDrawerOpen: (next: boolean) => void;
  /** Tab the drawer should render on next open. Consumed + cleared by
   *  ListsDrawer on mount. Stays null unless a caller explicitly
   *  passed one to `openLists(tab)`. */
  requestedTab: ListsDrawerTab | null;
  clearRequestedTab: () => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [listsDrawerOpen, setListsDrawerOpen] = useState(false);
  const [requestedTab, setRequestedTab] = useState<ListsDrawerTab | null>(null);
  const openLists = useCallback((tab?: ListsDrawerTab) => {
    if (tab) setRequestedTab(tab);
    setListsDrawerOpen(true);
  }, []);
  const closeLists = useCallback(() => setListsDrawerOpen(false), []);
  const clearRequestedTab = useCallback(() => setRequestedTab(null), []);
  const value = useMemo<DrawerContextValue>(
    () => ({
      listsDrawerOpen,
      openLists,
      closeLists,
      setListsDrawerOpen,
      requestedTab,
      clearRequestedTab,
    }),
    [listsDrawerOpen, openLists, closeLists, requestedTab, clearRequestedTab],
  );
  return <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>;
}

export function useDrawerContext(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error('useDrawerContext must be used inside DrawerProvider');
  return ctx;
}
