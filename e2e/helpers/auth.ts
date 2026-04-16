import { sealData } from 'iron-session';
import type { BrowserContext } from '@playwright/test';
import { config } from 'dotenv';

config({ path: '.env.local' });

export interface TestUser {
  userId: string;
  username: string;
  handle: string;
  avatarUrl: string | null;
}

/**
 * Default test user — used when specs don't need isolation.
 * For parallel-safe specs, call `createIsolatedUser()` instead.
 */
export const TEST_USER: TestUser = {
  userId: 'test-e2e-000000000000',
  username: 'E2E Test User',
  handle: 'e2e-test',
  avatarUrl: null,
};

let isolatedCounter = 0;

/**
 * Create a unique test user identity for specs that need parallel
 * isolation. Does NOT seed the DB — call `ensureTestUser()` after
 * if the spec hits sync/profile/trades endpoints.
 */
export function createIsolatedUser(): TestUser {
  const suffix = `${Date.now()}-${++isolatedCounter}`;
  return {
    userId: `test-iso-${suffix}`,
    username: `ISO Test ${suffix}`,
    handle: `iso-${suffix}`,
    avatarUrl: null,
  };
}

/**
 * Seal a session cookie and inject it into the browser context so the
 * app sees a signed-in user without going through Discord OAuth.
 */
export async function signIn(context: BrowserContext, user: TestUser = TEST_USER) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET not set — run `vercel env pull .env.local` or set it in CI');
  }

  const sealed = await sealData(
    {
      userId: user.userId,
      username: user.username,
      handle: user.handle,
      avatarUrl: user.avatarUrl,
    },
    { password: secret, ttl: 60 * 60 * 24 },
  );

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
  await context.addCookies([
    {
      name: 'swu_session',
      value: sealed,
      url: baseURL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

/**
 * Ensure a test user exists in the database with a clean slate.
 * Call from specs that hit server endpoints (sync, profile, trades).
 */
export async function ensureTestUser(user: TestUser): Promise<void> {
  // Dynamic import so this module works even when DB env vars
  // aren't available (e.g., anonymous e2e tests).
  const { getDb } = await import('../../lib/db.js');
  const { users, wantsItems, availableItems, trades } = await import('../../lib/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();

  // Clean up any leftover data.
  await db.delete(trades).where(eq(trades.userId, user.userId)).catch(() => {});
  await db.delete(wantsItems).where(eq(wantsItems.userId, user.userId)).catch(() => {});
  await db.delete(availableItems).where(eq(availableItems.userId, user.userId)).catch(() => {});

  // Upsert the user.
  const existing = await db.select().from(users).where(eq(users.id, user.userId)).limit(1);
  if (existing.length === 0) {
    await db.insert(users).values({
      id: user.userId,
      discordId: user.userId,
      username: user.username,
      handle: user.handle,
      avatarUrl: user.avatarUrl,
    });
  }
}

/**
 * Remove a test user and all their data from the database.
 */
export async function cleanupTestUser(user: TestUser): Promise<void> {
  const { getDb } = await import('../../lib/db.js');
  const { users } = await import('../../lib/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();
  await db.delete(users).where(eq(users.id, user.userId)).catch(() => {});
}
