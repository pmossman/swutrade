import { config } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

// Load .env.local so SESSION_SECRET is available for cookie sealing.
config({ path: '.env.local' });

/**
 * Authenticated e2e tests — run against `vercel dev` (port 3000)
 * which serves both the Vite frontend AND the API functions. The
 * anonymous tests in playwright.config.ts use plain `vite` (port
 * 5173) and don't need API endpoints.
 *
 * Run: npm run e2e:auth
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.auth.spec.ts',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
  ],
  webServer: {
    command: 'vercel dev --listen 3000',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  // Seed the test user before any spec runs.
  globalSetup: './e2e/helpers/global-setup.ts',
});
