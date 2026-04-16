/**
 * Shared test fixtures for both vitest API tests and Playwright e2e helpers.
 * Consolidates the user/item creation patterns so new tests can just:
 *
 *   const user = await createTestUser(db);
 *   await insertWant(db, user.id, 'jtl::luke');
 *   // ... test ...
 *   await user.cleanup();
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { getDb, type Db } from '../lib/db.js';
import { users, wantsItems, availableItems, trades } from '../lib/schema.js';
import { eq } from 'drizzle-orm';
import { restrictionKey } from '../lib/shared.js';

export function db(): Db {
  return getDb();
}

export async function createUser(overrides: Partial<{
  id: string;
  handle: string;
  username: string;
  wantsPublic: boolean;
  availablePublic: boolean;
}> = {}) {
  const d = db();
  const suffix = crypto.randomUUID().slice(0, 12);
  const id = overrides.id ?? `fix-${suffix}`;
  const handle = overrides.handle ?? `fix-${suffix}`;

  await d.insert(users).values({
    id,
    discordId: id,
    username: overrides.username ?? `Fixture ${suffix}`,
    handle,
    avatarUrl: null,
    wantsPublic: overrides.wantsPublic ?? true,
    availablePublic: overrides.availablePublic ?? false,
  });

  return {
    id,
    handle,
    username: overrides.username ?? `Fixture ${suffix}`,
    async cleanup() {
      await d.delete(trades).where(eq(trades.userId, id)).catch(() => {});
      await d.delete(wantsItems).where(eq(wantsItems.userId, id)).catch(() => {});
      await d.delete(availableItems).where(eq(availableItems.userId, id)).catch(() => {});
      await d.delete(users).where(eq(users.id, id)).catch(() => {});
    },
  };
}

export async function insertWant(userId: string, familyId: string, opts: {
  qty?: number;
  restriction?: { mode: string; variants?: string[] };
  isPriority?: boolean;
} = {}) {
  const d = db();
  const restriction = opts.restriction ?? { mode: 'any' };
  await d.insert(wantsItems).values({
    id: `w-${crypto.randomUUID().slice(0, 12)}`,
    userId,
    familyId,
    qty: opts.qty ?? 1,
    restrictionMode: restriction.mode,
    restrictionVariants: restriction.mode === 'restricted' ? restriction.variants ?? [] : null,
    restrictionKey: restrictionKey(restriction),
    isPriority: opts.isPriority ?? false,
    addedAt: Date.now(),
  });
}

export async function insertAvailable(userId: string, productId: string, qty = 1) {
  const d = db();
  await d.insert(availableItems).values({
    id: `a-${crypto.randomUUID().slice(0, 12)}`,
    userId,
    productId,
    qty,
    addedAt: Date.now(),
  });
}
