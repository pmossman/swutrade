import { test as base, expect } from '@playwright/test';

/**
 * Playwright test fixtures shared across specs.
 *
 * `consoleErrors` attaches a per-test collector of every `console.error`
 * message emitted during the page's lifecycle. Tests can:
 *
 *   - Assert empty with `expectNoConsoleErrors(consoleErrors)` at the
 *     end (the common case — catches the CJS-interop / React render
 *     error class that CI missed when shipping Live trade).
 *   - Filter out expected-noise patterns via `filterConsoleErrors`
 *     (e.g. an expected API 404 on a fake session id).
 *
 * The fixture is opt-in via this custom `test` export so existing
 * specs keep working — migrate on touch.
 */
export interface ConsoleErrorsFixture {
  consoleErrors: string[];
}

export const test = base.extend<ConsoleErrorsFixture>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    // Uncaught exceptions that never reach console.error still
    // surface via the `pageerror` event. Roll them in so the fixture
    // is one inclusive source of "did anything blow up."
    page.on('pageerror', err => {
      errors.push(err.message);
    });
    await use(errors);
  },
});

export { expect };

/**
 * Filter out expected-noise console messages. Current patterns:
 *
 *   - "Failed to load resource … 401 | 404 | 429" — browser warning
 *     for API fetches returning those statuses. Tests hitting
 *     not-found ids, anonymous viewers hitting auth-gated endpoints,
 *     or rate-limited endpoints (chat hits 10/min cap) log these as
 *     part of normal flows. Real regressions surface as 5xx, not
 *     these explicit-API-decision codes.
 *   - CORS preflight failures on third-party hosts (gstatic font
 *     CDN specifically). Emitted when running against Vercel preview
 *     URLs with deployment-protection-bypass headers — Playwright's
 *     `extraHTTPHeaders` applies the header to every request
 *     including CDN fetches, which triggers browser CORS blocks on
 *     anything not in the preview origin's allow-list. Not a real
 *     runtime bug; the app has no hard dep on these fonts.
 *   - "net::ERR_FAILED" — generic companion to the CORS block.
 *
 * Add more as specs surface legitimately noisy patterns. Keep the
 * whitelist narrow — broad filters mask real regressions.
 */
export function filterConsoleErrors(errors: readonly string[]): string[] {
  return errors.filter(msg =>
    !/Failed to load resource.*(?:401|404|429)/i.test(msg)
    && !/blocked by CORS policy/i.test(msg)
    && !/Failed to load resource:\s*net::ERR_FAILED/i.test(msg)
    && !/fonts\.gstatic\.com/i.test(msg),
  );
}

/**
 * Shorthand for the common "assert zero console errors" check at the
 * end of a test. Applies the standard filter before asserting.
 */
export function expectNoConsoleErrors(errors: readonly string[]): void {
  expect(filterConsoleErrors(errors)).toEqual([]);
}
