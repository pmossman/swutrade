import { defineConfig, devices } from '@playwright/test';

/**
 * Headless e2e tests against the Vite dev server. Kept narrow on purpose —
 * unit tests cover pure logic; these exercise interaction flows that
 * cross hook + render + URL boundaries (the surface where the
 * parseQuery slug-alias bug hid for months).
 *
 * Spawns its own dev server when none is running. CI relies on this
 * — local devs can also point at an already-running `npm run dev` to
 * iterate faster (Playwright detects the existing port).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
