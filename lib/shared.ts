/**
 * Stable dedup key for a variant restriction. Must match the
 * implementation in src/hooks/useWants.ts::restrictionKey so the
 * client and API enforce the same uniqueness invariant.
 */
export function restrictionKey(r: { mode: string; variants?: string[] }): string {
  if (r.mode === 'any') return 'any';
  return [...(r.variants ?? [])].sort().join('|');
}
