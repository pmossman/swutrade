import { sealData } from 'iron-session';
import type { BrowserContext } from '@playwright/test';

export interface TestUser {
  userId: string;
  username: string;
  handle: string;
  avatarUrl: string | null;
}

export const TEST_USER: TestUser = {
  userId: 'test-e2e-000000000000',
  username: 'E2E Test User',
  handle: 'e2e-test',
  avatarUrl: null,
};

/**
 * Seal a session cookie and inject it into the browser context so the
 * app sees a signed-in user without going through Discord OAuth.
 *
 * Requires SESSION_SECRET in the environment (loaded from .env.local
 * via playwright.config.ts's webServer, or set in CI).
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

  // Use `url` instead of `domain` — browsers are strict about
  // localhost cookie domain matching and Playwright inherits that.
  await context.addCookies([
    {
      name: 'swu_session',
      value: sealed,
      url: 'http://localhost:3000',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
