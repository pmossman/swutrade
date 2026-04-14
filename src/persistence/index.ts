import type { z } from 'zod';

export * from './schemas';

// Read a persisted value, validating against a Zod schema. Falls back to the
// provided default on: missing key, parse failure, schema-mismatch, or any
// environment where localStorage is unavailable (SSR, private-mode Safari).
//
// The reader tries JSON.parse first then falls back to the raw string. That
// keeps us compatible with historical values written by `String(v)` (used for
// primitive keys before this module existed) while new writes always go
// through `writePersisted`, which stores JSON.
export function readPersisted<T>(key: string, schema: z.ZodSchema<T>, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    const result = schema.safeParse(parsed);
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

export function writePersisted<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort.
  }
}

export function clearPersisted(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
