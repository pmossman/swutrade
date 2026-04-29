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
  userGuildMemberships,
  users,
  wantsItems,
} from './schema.js';
import type { Db } from './db.js';
// Build-time JSON inlining — same pattern api/og.ts uses to avoid a
// runtime self-fetch for the card index. Bumps the function bundle
// but the index is already inlined elsewhere so the cost is amortized.
import familyIndex from '../public/data/family-index.json' with { type: 'json' };

type FamilyEntry = { p: string; v: string; m: number | null; l: number | null; n: string };
type FamilyIndex = Record<string, FamilyEntry[]>;

const FAMS = familyIndex as FamilyIndex;

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
  /** All variants for this family, sorted by cheapest market price
   *  first (so the autocomplete "default" thumbnail is the cheapest
   *  available printing). */
  variants: Array<{ productId: string; variant: string; market: number | null }>;
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
  return { familyId, name: entries[0].n, variants };
}

/**
 * Family-level autocomplete for the slash `card:` arg. One entry
 * per family — collapses the variant fan-out so "luke" returns ~5
 * unique cards instead of 25 noise-y variant rows. Returns up to
 * `limit` matches, starts-with priority before substring matches.
 *
 * The slash submit handler treats the `value` as a familyId and
 * pairs it with a separate (optional) `variant:` option for users
 * who want to pin the printing.
 */
export function autocompleteSignalFamilies(query: string, limit = 25): SignalFamily[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const startsWith: SignalFamily[] = [];
  const contains: SignalFamily[] = [];
  for (const [familyId, entries] of Object.entries(FAMS)) {
    if (entries.length === 0) continue;
    const name = entries[0].n;
    const lower = name.toLowerCase();
    if (!lower.includes(q)) continue;
    const variants = entries
      .map(e => ({ productId: e.p, variant: e.v, market: e.m }))
      .sort((a, b) => (a.market ?? Infinity) - (b.market ?? Infinity));
    const fam: SignalFamily = { familyId, name, variants };
    if (lower.startsWith(q)) startsWith.push(fam);
    else contains.push(fam);
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

