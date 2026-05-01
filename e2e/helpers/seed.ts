import { config } from 'dotenv';
config({ path: '.env.local' });

import { getDb } from '../../lib/db.js';
import { users, wantsItems, availableItems } from '../../lib/schema.js';
import { eq } from 'drizzle-orm';
import { TEST_USER } from './auth.js';

/**
 * Ensure the e2e test user exists in the database and has a clean
 * slate (no wants/available items). Idempotent — safe to run before
 * every test suite.
 */
export async function seedTestUser() {
  const db = getDb();

  await db.delete(wantsItems).where(eq(wantsItems.userId, TEST_USER.userId));
  await db.delete(availableItems).where(eq(availableItems.userId, TEST_USER.userId));

  // onConflictDoNothing makes this concurrency-safe for the upcoming
  // 4-way sharded auth-e2e job: every shard runs `npx tsx seed.ts`
  // before its specs, and a select-then-insert pattern would race
  // (UNIQUE_VIOLATION on whichever shard inserts second).
  await db.insert(users).values({
    id: TEST_USER.userId,
    discordId: TEST_USER.userId,
    username: TEST_USER.username,
    handle: TEST_USER.handle,
    avatarUrl: TEST_USER.avatarUrl,
  }).onConflictDoNothing();
}

// Allow direct execution: `npx tsx e2e/helpers/seed.ts`
if (process.argv[1]?.endsWith('seed.ts')) {
  seedTestUser()
    .then(() => console.log('✓ Test user seeded'))
    .catch(e => { console.error('✗', e.message); process.exit(1); });
}
