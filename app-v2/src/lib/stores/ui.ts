import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/*
 * Global UI-only singletons. Kept tiny; every slot listed here has
 * a real consumer somewhere in the app. Server state is NOT kept here
 * — React Query owns that.
 */

interface UiStore {
  /** Banners the user has dismissed (keyed by stable id). Persisted. */
  dismissedBanners: Record<string, number>;
  dismissBanner: (id: string) => void;

  /** Onboarding hints the user has seen (gesture discoverability, etc.). */
  seenHints: Record<string, number>;
  markHintSeen: (id: string) => void;
}

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      dismissedBanners: {},
      dismissBanner: (id) =>
        set((state) => ({
          dismissedBanners: { ...state.dismissedBanners, [id]: Date.now() },
        })),

      seenHints: {},
      markHintSeen: (id) =>
        set((state) => ({
          seenHints: { ...state.seenHints, [id]: Date.now() },
        })),
    }),
    {
      name: 'swu-v2-ui',
      partialize: (state) => ({
        dismissedBanners: state.dismissedBanners,
        seenHints: state.seenHints,
      }),
    },
  ),
);
