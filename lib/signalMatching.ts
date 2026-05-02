/**
 * Server-side matching for `/looking-for` + `/offering` signals.
 *
 * A signal is the public broadcast of an inventory row. Matching
 * means "find users in this guild whose inverse inventory satisfies
 * the signal" — i.e.:
 *
 *   `/looking-for` (kind='wanted')   → find users whose `available_items`
 *      contain a product in the signal's family that matches the
 *      wants_items restriction the signaler attached to it.
 *
 *   `/offering`    (kind='offering') → find users whose `wants_items`
 *      list this product's family with a restriction that allows
 *      this specific product's variant.
 *
 * Both directions filter through `user_guild_memberships`
 * (recipient must share the guild and have `appearInQueries=true`)
 * and exclude the signaler.
 *
 * Forward-compat for LGS: `eventId` boost is reserved for when
 * an `event_attendances` table exists. Today the rank is just
 * `last-updated DESC`; the helper interface accepts the option so
 * call sites don't need to change when LGS lands.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  availableItems,
  cardSignalKinds,
  cardSignals,
  userGuildMemberships,
  users,
  wantsItems,
} from './schema.js';
import type { Db } from './db.js';
// Build-time JSON inlining — same pattern api/og.ts uses to avoid a
// runtime self-fetch for the card index. Bumps the function bundle
// but the index is already inlined elsewhere so the cost is amortized.
import familyIndex from '../public/data/family-index.json' with { type: 'json' };
import { SETS } from '../src/types/index.js';

type FamilyEntry = {
  p: string;
  v: string;
  m: number | null;
  l: number | null;
  n: string;
  /** cardType — populated when enrichment matched the swuapi
   *  metadata. Used to surface "(Leader)" hints in autocomplete. */
  t?: string;
};
type FamilyIndex = Record<string, FamilyEntry[]>;

const FAMS = familyIndex as FamilyIndex;

/** Map from a family_id's set-prefix (e.g. `spark-of-rebellion`)
 *  to the canonical set code (e.g. `SOR`). Built once at module
 *  load from the same SETS table the rest of the app uses. */
const SLUG_TO_CODE: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const s of SETS) m[s.slug] = s.code;
  return m;
})();

/** Derive the set code from a family_id. Returns the slug itself
 *  as a fallback when the prefix isn't in the SETS table — e.g.
 *  for promo sets we haven't catalogued. */
function setCodeForFamily(familyId: string): string {
  const slug = familyId.split('::')[0] ?? '';
  return SLUG_TO_CODE[slug] ?? slug;
}

/**
 * Reverse mapping built once at module load: productId → familyId +
 * variant label. Lets `/offering` resolve a product to its family
 * (so we can match against `wants_items.family_id`) without scanning
 * the whole family index per call.
 */
const PRODUCT_TO_FAMILY = (() => {
  const m = new Map<string, { familyId: string; variant: string; name: string }>();
  for (const [familyId, entries] of Object.entries(FAMS)) {
    for (const e of entries) {
      m.set(e.p, { familyId, variant: e.v, name: e.n });
    }
  }
  return m;
})();

export interface SignalCard {
  /** Family id, e.g. `jump-to-lightspeed::luke-skywalker-hero-of-yavin`. */
  familyId: string;
  /** Specific TCGPlayer product id picked from autocomplete. Used as
   *  the `available_items.product_id` for offering signals + as the
   *  variant filter for wanted-signal restriction matches. */
  productId: string;
  /** Human-friendly variant label from the card name (e.g. "Standard",
   *  "Hyperspace", "Showcase"). */
  variant: string;
  /** Display name without the variant suffix. */
  name: string;
}

export interface SignalFamily {
  familyId: string;
  /** Display name shared across variants. */
  name: string;
  /** Set code derived from the family_id prefix (e.g. "SOR"). */
  setCode: string;
  /** Card type — Leader / Unit / Event / Upgrade / Base etc.
   *  Optional because some promo sets don't have enriched metadata. */
  cardType?: string;
  /** All variants for this family, sorted by cheapest market price
   *  first (so the autocomplete "default" thumbnail is the cheapest
   *  available printing). */
  variants: Array<{ productId: string; variant: string; market: number | null }>;
}

export interface SignalFamilySearchResult extends SignalFamily {
  /** When the same display name spans multiple families (the
   *  primary set + 0..N promo / exclusive reprints), this carries
   *  the count of alternates. The autocomplete uses this to surface
   *  a "+N printings" hint so users know reprints exist behind the
   *  collapsed entry. */
  alternateCount: number;
}

/**
 * Resolve a productId to its full SignalCard. Returns null if the
 * id isn't in the family index — caller should treat as an unknown
 * card and reject the signal. Pure / no I/O.
 */
export function lookupSignalCard(productId: string): SignalCard | null {
  const entry = PRODUCT_TO_FAMILY.get(productId);
  if (!entry) return null;
  return {
    familyId: entry.familyId,
    productId,
    variant: entry.variant,
    name: entry.name,
  };
}

/**
 * Resolve a familyId to its display name + variants. Returns null
 * when the family doesn't exist. Caller picks `variants[0]` as the
 * representative thumbnail (cheapest), or filters by a specific
 * variant label when the user supplied one.
 */
export function lookupSignalFamily(familyId: string): SignalFamily | null {
  const entries = FAMS[familyId];
  if (!entries || entries.length === 0) return null;
  const variants = entries
    .map(e => ({ productId: e.p, variant: e.v, market: e.m }))
    // Cheapest first; nulls sink to the end.
    .sort((a, b) => (a.market ?? Infinity) - (b.market ?? Infinity));
  // All variants in a family share a card type — pick the first
  // entry's `t` (the post-enrichment field) as the family's type.
  // Falls back to undefined when this set wasn't enriched.
  const cardType = entries.find(e => e.t)?.t;
  return {
    familyId,
    name: entries[0].n,
    setCode: setCodeForFamily(familyId),
    cardType,
    variants,
  };
}

/**
 * Set prefixes that mint a "secondary" family — promo printings,
 * convention exclusives, judge / OP / gift-box / weekly-play
 * promos. Most cards have a primary family in a main set plus 0-3
 * of these as alternate printings. We prefer the main-set family
 * in autocomplete + when collapsing duplicates; users who actually
 * want the promo printing can refine via the "Specify variant"
 * button (variants within the primary family) or pick a more
 * specific autocomplete entry once we surface set context.
 */
const SECONDARY_SET_PATTERNS = [
  'promo', 'exclusive', 'intro-battle', 'gift-box', 'weekly-play',
];

function isSecondaryFamily(familyId: string): boolean {
  return SECONDARY_SET_PATTERNS.some(p => familyId.includes(p));
}

/**
 * Pick the canonical family from a list with the same display name.
 * Heuristic: prefer non-secondary (main set) families; if multiple
 * main-set families share a name (rare — e.g., a card reprinted
 * across two main sets), the alphabetically-first wins for stable
 * ordering. Returns the primary family's full SignalFamily plus
 * the count of total families that share this name (for "+N
 * printings" hints in the picker).
 */
function pickPrimaryFamily(familyIds: string[]): { familyId: string; alternateCount: number } {
  const sorted = [...familyIds].sort();
  const primary = sorted.find(id => !isSecondaryFamily(id)) ?? sorted[0];
  return { familyId: primary, alternateCount: familyIds.length - 1 };
}

/**
 * Cached map: card display name → list of family ids sharing that
 * name. Built once at module load. Used by the autocomplete to
 * collapse reprints into a single entry.
 */
const NAME_TO_FAMILIES = (() => {
  const m = new Map<string, string[]>();
  for (const [familyId, entries] of Object.entries(FAMS)) {
    if (entries.length === 0) continue;
    const name = entries[0].n;
    const list = m.get(name) ?? [];
    list.push(familyId);
    m.set(name, list);
  }
  return m;
})();

/**
 * Card-name-level autocomplete for the slash `card:` arg. One
 * entry per unique display name — collapses BOTH the per-variant
 * fan-out (5 variants of one family) AND the cross-set fan-out
 * (5 promo reprints of the same card) into a single autocomplete
 * row. The value is the primary family's id; when there are
 * alternate printings the entry's display name appends "(+N
 * printings)" so users know reprints exist.
 *
 * The slash submit handler treats the `value` as a familyId.
 * Users who specifically want a promo printing can either type
 * the set name into the autocomplete query (e.g., "luke promo")
 * to surface the secondary entry, or pick the primary and refine
 * via the variant picker.
 */
export function autocompleteSignalFamilies(query: string, limit = 25): SignalFamilySearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  // Two-pass: collapse by name first, then rank.
  const startsWith: SignalFamilySearchResult[] = [];
  const contains: SignalFamilySearchResult[] = [];
  for (const [name, familyIds] of NAME_TO_FAMILIES) {
    const lower = name.toLowerCase();
    if (!lower.includes(q)) continue;
    const { familyId, alternateCount } = pickPrimaryFamily(familyIds);
    const family = lookupSignalFamily(familyId);
    if (!family) continue;
    const result: SignalFamilySearchResult = { ...family, alternateCount };
    if (lower.startsWith(q)) startsWith.push(result);
    else contains.push(result);
    if (startsWith.length + contains.length >= limit * 2) break;
  }
  return [...startsWith, ...contains].slice(0, limit);
}

export interface MatchedUser {
  userId: string;
  discordId: string;
  handle: string;
  username: string;
}

/**
 * Variant scope for a signal at match time. `any` means the
 * signaler hasn't pinned a printing — match all variants of the
 * family. `restricted` carries the specific variant label(s) the
 * signaler accepts (or, for offering signals, the variant they
 * actually have on hand).
 */
export type VariantSpec =
  | { mode: 'any' }
  | { mode: 'restricted'; variants: string[] };

/**
 * Find users in `guildId` whose inventory matches the given signal.
 *
 *   kind='wanted'   → who has any variant of this family listed as
 *                     available, filtered to the variants the
 *                     signaler accepts?
 *   kind='offering' → who lists this family in their wants with a
 *                     restriction that accepts the signaler's
 *                     offered variant(s)?
 *
 * Filters out the signaler + non-enrolled / non-query-visible
 * members + ghost users (null discord_id; they can't receive the
 * DM ping). Returns up to `limit` matches (default 25 — the bot
 * shouldn't blast hundreds of DMs from one signal).
 */
export async function findMatches(
  db: Db,
  opts: {
    kind: typeof cardSignalKinds[number];
    family: SignalFamily;
    variant: VariantSpec;
    guildId: string;
    requesterUserId: string;
    eventId?: string | null;
    limit?: number;
  },
): Promise<MatchedUser[]> {
  const limit = opts.limit ?? 25;

  if (opts.kind === 'wanted') {
    // Compute the set of productIds matching the variant restriction.
    // `any` → every variant in the family. `restricted` → just the
    // variants the signaler accepts. We do the fan-out here because
    // available_items is keyed by productId only (no family/variant
    // columns), so SQL has to ask "is this productId in the allowed
    // set?" rather than join through a card-index table.
    const allowedProducts = opts.variant.mode === 'any'
      ? opts.family.variants.map(v => v.productId)
      : opts.family.variants
          .filter(v => opts.variant.mode === 'restricted'
            && opts.variant.variants.includes(v.variant))
          .map(v => v.productId);
    if (allowedProducts.length === 0) return [];

    const rows = await db
      .select({
        userId: users.id,
        discordId: users.discordId,
        handle: users.handle,
        username: users.username,
      })
      .from(availableItems)
      .innerJoin(users, eq(users.id, availableItems.userId))
      .innerJoin(
        userGuildMemberships,
        and(
          eq(userGuildMemberships.userId, availableItems.userId),
          eq(userGuildMemberships.guildId, opts.guildId),
          eq(userGuildMemberships.appearInQueries, true),
        ),
      )
      .where(and(
        inArray(availableItems.productId, allowedProducts),
        sql`${availableItems.userId} != ${opts.requesterUserId}`,
        sql`${users.discordId} IS NOT NULL`,
      ))
      .limit(limit);
    return rows.map(r => ({ ...r, discordId: r.discordId! }));
  }

  // kind === 'offering': match wants_items where the family lines up
  // and the wants' own restriction accepts at least one of the
  // variants the signaler is offering.
  //   - signal variant=any              → match wants with restriction='any'
  //                                        only (over-restrictive
  //                                        folks won't ping; we'd
  //                                        rather under-ping than
  //                                        spam wishes the offer
  //                                        can't fulfill).
  //   - signal variant=['Hyperspace']   → match wants with
  //                                        restriction='any' OR a
  //                                        restriction that includes
  //                                        Hyperspace.
  let restrictionPredicate;
  if (opts.variant.mode === 'any') {
    restrictionPredicate = sql`${wantsItems.restrictionMode} = 'any'`;
  } else {
    const offered = opts.variant.variants;
    restrictionPredicate = sql`(
      ${wantsItems.restrictionMode} = 'any'
      OR ${wantsItems.restrictionVariants} && ARRAY[${sql.join(offered.map(v => sql`${v}`), sql`, `)}]::text[]
    )`;
  }

  const rows = await db
    .select({
      userId: users.id,
      discordId: users.discordId,
      handle: users.handle,
      username: users.username,
    })
    .from(wantsItems)
    .innerJoin(users, eq(users.id, wantsItems.userId))
    .innerJoin(
      userGuildMemberships,
      and(
        eq(userGuildMemberships.userId, wantsItems.userId),
        eq(userGuildMemberships.guildId, opts.guildId),
        eq(userGuildMemberships.appearInQueries, true),
      ),
    )
    .where(and(
      eq(wantsItems.familyId, opts.family.familyId),
      sql`${wantsItems.userId} != ${opts.requesterUserId}`,
      sql`${users.discordId} IS NOT NULL`,
      restrictionPredicate,
    ))
    .limit(limit);
  return rows.map(r => ({ ...r, discordId: r.discordId! }));
}

// -- signal-row → family/variantSpec resolvers ------------------------------

/**
 * `card_signals` rows reference either a `wants_items` row (kind='wanted')
 * or an `available_items` row (kind='offering'); both helpers below
 * walk the foreign key to recover the family + variant the signal
 * embed needs to render.
 *
 * Previously duplicated colocated in api/signals.ts (lines 577-629)
 * and api/bot.ts (lines 749-805). The "duplication beats circular
 * import" comment was spurious — both files already statically
 * imported lookupSignalFamily / lookupSignalCard from this module.
 * Audit 03-discord #2.
 */

export interface ResolvedSignalCard {
  family: SignalFamily;
  variantSpec: VariantSpec;
}

/** Single-row family lookup for signal-flow handlers. Use for
 *  single-shot interaction sites (variant-open / variant-pick) where
 *  batching offers no benefit; loops should call
 *  `resolveSignalCardsBatch` instead. */
export async function resolveSignalFamily(
  db: Db,
  signal: typeof cardSignals.$inferSelect,
): Promise<SignalFamily | null> {
  if (signal.kind === 'wanted' && signal.wantsItemId) {
    const [row] = await db
      .select({ familyId: wantsItems.familyId })
      .from(wantsItems)
      .where(eq(wantsItems.id, signal.wantsItemId))
      .limit(1);
    return row ? lookupSignalFamily(row.familyId) : null;
  }
  if (signal.kind === 'offering' && signal.availableItemId) {
    const [row] = await db
      .select({ productId: availableItems.productId })
      .from(availableItems)
      .where(eq(availableItems.id, signal.availableItemId))
      .limit(1);
    if (!row) return null;
    const card = lookupSignalCard(row.productId);
    return card ? lookupSignalFamily(card.familyId) : null;
  }
  return null;
}

/** Single-row variantSpec resolver. For wanted: read
 *  wants_items.restriction_mode + variants. For offering: always
 *  'restricted' to the chosen product's variant. */
export async function resolveSignalVariantSpec(
  db: Db,
  signal: typeof cardSignals.$inferSelect,
): Promise<VariantSpec> {
  if (signal.kind === 'wanted' && signal.wantsItemId) {
    const [row] = await db
      .select({
        restrictionMode: wantsItems.restrictionMode,
        restrictionVariants: wantsItems.restrictionVariants,
      })
      .from(wantsItems)
      .where(eq(wantsItems.id, signal.wantsItemId))
      .limit(1);
    if (!row || row.restrictionMode === 'any') return { mode: 'any' };
    return { mode: 'restricted', variants: row.restrictionVariants ?? [] };
  }
  if (signal.kind === 'offering' && signal.availableItemId) {
    const [row] = await db
      .select({ productId: availableItems.productId })
      .from(availableItems)
      .where(eq(availableItems.id, signal.availableItemId))
      .limit(1);
    if (!row) return { mode: 'any' };
    const card = lookupSignalCard(row.productId);
    return card ? { mode: 'restricted', variants: [card.variant] } : { mode: 'any' };
  }
  return { mode: 'any' };
}

/**
 * Batch-resolve a set of signal rows to their family + variantSpec
 * in a fixed two-query budget (one inArray for wants_items, one for
 * available_items), regardless of how many rows are passed. Loop
 * call sites (`handleListMine`, `handleSignalCancel`,
 * `cron-signals` embed-refresh) collapse from 2 SELECTs per row to
 * 2 SELECTs total. Audit 07-performance #2.
 */
export async function resolveSignalCardsBatch(
  db: Db,
  rows: ReadonlyArray<typeof cardSignals.$inferSelect>,
): Promise<Map<string, ResolvedSignalCard>> {
  const wantsIds: string[] = [];
  const availableIds: string[] = [];
  for (const row of rows) {
    if (row.kind === 'wanted' && row.wantsItemId) wantsIds.push(row.wantsItemId);
    if (row.kind === 'offering' && row.availableItemId) availableIds.push(row.availableItemId);
  }
  const [wantsRows, availableRows] = await Promise.all([
    wantsIds.length > 0
      ? db.select({
          id: wantsItems.id,
          familyId: wantsItems.familyId,
          restrictionMode: wantsItems.restrictionMode,
          restrictionVariants: wantsItems.restrictionVariants,
        }).from(wantsItems).where(inArray(wantsItems.id, wantsIds))
      : Promise.resolve([] as Array<{
          id: string;
          familyId: string;
          restrictionMode: string;
          restrictionVariants: string[] | null;
        }>),
    availableIds.length > 0
      ? db.select({
          id: availableItems.id,
          productId: availableItems.productId,
        }).from(availableItems).where(inArray(availableItems.id, availableIds))
      : Promise.resolve([] as Array<{ id: string; productId: string }>),
  ]);
  const wantsMap = new Map(wantsRows.map(r => [r.id, r] as const));
  const availableMap = new Map(availableRows.map(r => [r.id, r] as const));

  const result = new Map<string, ResolvedSignalCard>();
  for (const row of rows) {
    if (row.kind === 'wanted' && row.wantsItemId) {
      const w = wantsMap.get(row.wantsItemId);
      if (!w) continue;
      const family = lookupSignalFamily(w.familyId);
      if (!family) continue;
      const variantSpec: VariantSpec = w.restrictionMode === 'any'
        ? { mode: 'any' }
        : { mode: 'restricted', variants: w.restrictionVariants ?? [] };
      result.set(row.id, { family, variantSpec });
    } else if (row.kind === 'offering' && row.availableItemId) {
      const a = availableMap.get(row.availableItemId);
      if (!a) continue;
      const card = lookupSignalCard(a.productId);
      if (!card) continue;
      const family = lookupSignalFamily(card.familyId);
      if (!family) continue;
      const variantSpec: VariantSpec = { mode: 'restricted', variants: [card.variant] };
      result.set(row.id, { family, variantSpec });
    }
  }
  return result;
}
