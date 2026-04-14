import { useCallback, useState } from 'react';

/**
 * useState that mirrors its value into localStorage, with graceful fallback
 * (SSR, private-mode Safari, etc.). Returns the value, a *persisting* setter
 * (for UI interactions the user wants remembered), and a *raw* setter (for
 * programmatic updates like URL sync that should NOT overwrite the saved
 * preference).
 *
 * Precedence on mount: localStorage → initial. The caller is responsible for
 * any higher-priority source (e.g. URL params) overriding via the raw setter.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
  deserialize: (raw: string) => T | null,
): readonly [T, (v: T) => void, (v: T) => void] {
  const [value, setRaw] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed = deserialize(raw);
      return parsed ?? initial;
    } catch {
      return initial;
    }
  });

  const setPersisted = useCallback((v: T) => {
    setRaw(v);
    try {
      window.localStorage.setItem(key, String(v));
    } catch {
      // Ignore — persistence is best-effort.
    }
  }, [key]);

  return [value, setPersisted, setRaw] as const;
}
