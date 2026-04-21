import { defineConfig, devices } from '@playwright/test';

/**
 * Headless e2e tests against the Vite dev server.
 *
 * Local: `npm run e2e` runs chromium only for speed.
 * CI: runs chromium + firefox + mobile-chrome for cross-browser coverage.
 * Add `--project chromium` locally to skip other browsers.
 */
export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/*.auth.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: undefined,
  reporter: process.env.CI ? 'github' : 'list',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    // Pre-dismiss the first-run tutorial for every anonymous spec so
    // it doesn't overlay the page and intercept locator clicks. The
    // tour's own spec (`tutorial.spec.ts`) explicitly clears this
    // via `addInitScript` before navigation.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:5173',
          localStorage: [
            { name: 'swu.tour.dismissedAt', value: 'suppressed-by-e2e' },
          ],
        },
      ],
    },
  },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
    ...(process.env.CI ? [
      { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    ] : []),
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
