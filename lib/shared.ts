/**
 * Shared client/server domain helpers. Anything imported by both
 * `api/` (Vercel functions, Node) AND `src/` (the React SPA) lives
 * here.
 */

/**
 * Wire shape of `GET /api/auth/me`. Server constructs the response
 * via this type; client `apiGet<MeResponse>` picks it up. Single
 * source of truth — adding a field touches one place. Pre-S2.3 the
 * shape was hand-rolled in three sites (`lib/auth.ts` SessionData,
 * `api/auth.ts` handleMe response, `src/hooks/useAuth.ts` User);
 * audit 04-auth #5 flagged the drift class.
 */
export interface MeResponseUser {
  id: string;
  username: string;
  handle: string;
  avatarUrl: string | null;
  /** True when the signed-in user is a ghost minted for an
   *  anonymous session claim. Used to gate "sign in to save"
   *  CTAs and hide community-feature surfaces. */
  isAnonymous?: boolean;
}

export interface MeResponse {
  user: MeResponseUser | null;
  botInstallUrl: string | null;
  /** UX-A5: when the just-completed OAuth callback merged ghost
   *  sessions into this real-user account, the server flags how
   *  many rows moved over. Null in steady state; set for one
   *  /api/auth/me read after sign-in until dismissed. */
  pendingMergeBanner: { carriedCount: number } | null;
}

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
