import { defineConfig, devices } from '@playwright/test';

/*
 * Mobile-first e2e config. Design §7.8 names Pixel 7 (393×851) as
 * the CI default and desktop (1280×800) as a secondary smoke. For
 * now only mobile runs; desktop spec lands when a desktop-specific
 * regression actually needs coverage.
 *
 * webServer boots Vite's dev server on :5173. /api/* routes are not
 * served under `vite dev` — specs that need auth / sessions will
 * boot via `vercel dev` in CI instead.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
