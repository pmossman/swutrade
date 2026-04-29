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

import { and, eq, sql } from 'drizzle-orm';
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
 * Autocomplete candidates for the slash `card:` arg. Returns up to
 * `limit` cards whose name (or its variant suffix) contains the
 * query, ordered by simple "name starts with query" first, then
 * substring matches. Results carry the productId for the slash
 * submission.
 *
 * Discord caps autocomplete at 25 entries.
 */
export function autocompleteSignalCards(query: string, limit = 25): SignalCard[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const startsWith: SignalCard[] = [];
  const contains: SignalCard[] = [];
  for (const [familyId, entries] of Object.entries(FAMS)) {
    for (const e of entries) {
      const lower = e.n.toLowerCase();
      const card: SignalCard = { familyId, productId: e.p, variant: e.v, name: e.n };
      if (lower.startsWith(q)) startsWith.push(card);
      else if (lower.includes(q)) contains.push(card);
      if (startsWith.length + contains.length >= limit * 4) break;
    }
    if (startsWith.length + contains.length >= limit * 4) break;
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
 * Find users in `guildId` whose inventory matches the given signal.
 *
 *   kind='wanted'   → who has `productId` listed as available?
 *   kind='offering' → who lists this card's family in their wants
 *                     with a restriction that accepts this variant?
 *
 * Filters out the signaler + non-enrolled / non-query-visible
 * members. Returns up to `limit` matches (default 25 — the bot
 * shouldn't blast hundreds of DMs from one signal).
 */
export async function findMatches(
  db: Db,
  opts: {
    kind: typeof cardSignalKinds[number];
    card: SignalCard;
    guildId: string;
    requesterUserId: string;
    eventId?: string | null;
    limit?: number;
  },
): Promise<MatchedUser[]> {
  const limit = opts.limit ?? 25;

  if (opts.kind === 'wanted') {
    // Other users in this guild who have THIS specific product listed
    // as available. Exact product_id match — no family-fanout, since
    // the slash explicitly picked one variant.
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
        eq(availableItems.productId, opts.card.productId),
        sql`${availableItems.userId} != ${opts.requesterUserId}`,
        // We need to DM matches; ghosts (null discord_id) can't
        // receive DMs. Filter at the SQL layer so the row count
        // reported back to the slash matches what we actually
        // pinged.
        sql`${users.discordId} IS NOT NULL`,
      ))
      .limit(limit);
    return rows.map(r => ({ ...r, discordId: r.discordId! }));
  }

  // kind === 'offering': find users in this guild whose wants_items
  // contain THIS family with a restriction that accepts the offered
  // variant. The restriction model:
  //   - mode='any'        → accept all variants
  //   - mode='restricted' → only accept variants in restriction_variants[]
  // We translate to SQL by either matching all rows for the family
  // (when mode='any') or a row whose variants array contains the
  // signal's variant label.
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
      eq(wantsItems.familyId, opts.card.familyId),
      sql`${wantsItems.userId} != ${opts.requesterUserId}`,
      sql`${users.discordId} IS NOT NULL`,
      sql`(
        ${wantsItems.restrictionMode} = 'any'
        OR ${opts.card.variant} = ANY(${wantsItems.restrictionVariants})
      )`,
    ))
    .limit(limit);
  return rows.map(r => ({ ...r, discordId: r.discordId! }));
}

