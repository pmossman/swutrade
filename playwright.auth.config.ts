import { config } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

config({ path: '.env.local' });

const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

/**
 * Authenticated e2e tests.
 *
 * Locally: runs against `vercel dev` (port 3000).
 * CI: runs against the Vercel preview URL (set via PLAYWRIGHT_BASE_URL),
 *     with VERCEL_AUTOMATION_BYPASS_SECRET to get past deployment protection.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.auth.spec.ts',
  // Auth e2e is serialized on a single worker, intentionally. Every
  // test writes to the shared Neon DB and hits one `vercel dev`
  // process. Parallel workers just queue at the server side anyway,
  // and the queueing under React-StrictMode's double-mount (each
  // hook issues two `fetch` calls in dev) made the second fetch miss
  // its timeout. Trading throughput for determinism here is a good
  // deal — the auth suite is ~25 tests, serial runs in ~1 minute.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    // Bypass Vercel Deployment Protection on preview URLs.
    ...(bypassSecret ? {
      extraHTTPHeaders: {
        'x-vercel-protection-bypass': bypassSecret,
      },
    } : {}),
  },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'vercel dev --listen 3000',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
