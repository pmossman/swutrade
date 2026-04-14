import { useCallback, useState } from 'react';
import type { z } from 'zod';
import { readPersisted, writePersisted } from '../persistence';

/**
 * useState that mirrors its value into localStorage, validated against a Zod
 * schema on read. Returns the value, a *persisting* setter (for UI
 * interactions the user wants remembered), and a *raw* setter (for
 * programmatic updates like URL sync that should NOT overwrite the saved
 * preference).
 *
 * Precedence on mount: localStorage → initial. The caller is responsible for
 * any higher-priority source (e.g. URL params) overriding via the raw setter.
 */
export function usePersistedState<T>(
  key: string,
  schema: z.ZodSchema<T>,
  initial: T,
): readonly [T, (v: T) => void, (v: T) => void] {
  const [value, setRaw] = useState<T>(() => readPersisted(key, schema, initial));

  const setPersisted = useCallback((v: T) => {
    setRaw(v);
    writePersisted(key, v);
  }, [key]);

  return [value, setPersisted, setRaw] as const;
}
