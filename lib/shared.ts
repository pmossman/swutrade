/**
 * Shared client/server domain helpers. Anything imported by both
 * `api/` (Vercel functions, Node) AND `src/` (the React SPA) lives
 * here.
 */

/**
 * Stable signature for a variant restriction. Two wants items with
 * the same `(familyId, restrictionKey)` are treated as the same
 * item — adding bumps qty rather than creating a duplicate. Different
 * keys (e.g., Hyperspace vs Hyperspace Foil restrictions on the
 * same card) are tracked as separate items.
 *
 * Canonical implementation — was duplicated in 5 places before the
 * 2026-05-01 audit (see `docs/audit-2026-05-01/06-lists.md` #3).
 *
 * Two call shapes:
 *   - `restrictionKey({ mode, variants })` — for code that holds a
 *     full `VariantRestriction` object (useWants, persistence, etc.)
 *   - `restrictionKeyFromVariants(variants)` — for filter-chip
 *     contexts that only have a variants array (ListCardPicker,
 *     SignalBuilderView). Empty/null → 'any'.
 */
export function restrictionKey(r: { mode: string; variants?: readonly string[] }): string {
  if (r.mode === 'any') return 'any';
  return [...(r.variants ?? [])].sort().join('|');
}

export function restrictionKeyFromVariants(
  variants: readonly string[] | null | undefined,
): string {
  if (!variants || variants.length === 0) return 'any';
  return [...variants].sort().join('|');
}
