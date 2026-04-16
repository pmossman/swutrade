import { config } from 'dotenv';
config({ path: '.env.local' });

import { ensureTestUser, TEST_USER } from './auth.js';

/**
 * Optional global setup — seeds the default TEST_USER for specs that
 * use it. Specs that need parallel isolation should call
 * createIsolatedUser() + ensureTestUser() in their own beforeEach.
 */
export default async function globalSetup() {
  if (process.env.POSTGRES_URL) {
    await ensureTestUser(TEST_USER);
  }
}
