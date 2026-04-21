import { createContext, useContext, type ReactNode } from 'react';
import type { TutorialApi } from '../hooks/useTutorial';

/**
 * Exposes the first-run tutorial API to components that need to
 * trigger Replay (AccountMenu) without prop-drilling. The provider
 * lives in App alongside `useTutorial()` so the state is a singleton
 * across the tree. Consumers outside the provider throw at render
 * time rather than silently no-op'ing.
 */
const TutorialContext = createContext<TutorialApi | null>(null);

export function TutorialProvider({
  value,
  children,
}: {
  value: TutorialApi;
  children: ReactNode;
}) {
  return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>;
}

export function useTutorialContext(): TutorialApi {
  const ctx = useContext(TutorialContext);
  if (!ctx) {
    throw new Error('useTutorialContext must be used inside <TutorialProvider>');
  }
  return ctx;
}
