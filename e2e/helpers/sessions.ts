import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { signIn, type TestUser } from './auth';

/**
 * Shared helpers for trade-session e2e specs.
 *
 * Every spec under `session-*.auth.spec.ts` shares the same setup
 * primitives — open browser context(s), maybe sign in, suppress the
 * first-run tutorial, navigate, claim, add cards. Inlining those in
 * each spec produced selector drift and parallel copies of the same
 * helper (see git history of session-lifecycle vs session-collaboration).
 *
 * Design notes:
 * - Console errors are always collected. Specs that don't care can
 *   ignore the `errors[]` field; specs that do call
 *   `filterConsoleErrors(p.errors)` from `_fixtures.ts`.
 * - Identity is opt-in: pass `signedInAs` to mint a sealed Discord
 *   cookie via `signIn()`. Omit for ghost (anonymous) participants.
 * - The tutorial overlay is suppressed by default — every spec needs
 *   it suppressed, none want it.
 */

export interface SessionParticipant {
  context: BrowserContext;
  page: Page;
  errors: string[];
}

export interface OpenParticipantOptions {
  /** Initial URL to navigate to. Default `/`. */
  url?: string;
  /** When set, signs in as this Discord user before the first goto. */
  signedInAs?: TestUser;
  /** Suppress the first-run tutorial overlay. Default true. */
  suppressTour?: boolean;
}

export async function openSessionParticipant(
  browser: Browser,
  options: OpenParticipantOptions = {},
): Promise<SessionParticipant> {
  // Discord-signed-in users land on HomeView at `/`, which doesn't
  // expose "Invite someone" — that affordance lives in the trade
  // builder's action strip. Default signed-in participants to
  // `/?view=trade` so the rest of the helpers (createAndClaim, etc.)
  // can find the button without each spec having to know.
  const defaultUrl = options.signedInAs ? '/?view=trade' : '/';
  const { url = defaultUrl, signedInAs, suppressTour = true } = options;
  const context = await browser.newContext();
  if (signedInAs) {
    await signIn(context, signedInAs);
  }
  const page = await context.newPage();
  if (suppressTour) {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('swu.tour.dismissedAt', 'suppressed-by-e2e');
      } catch {}
    });
  }
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(url);
  return { context, page, errors };
}

export async function closeAllParticipants(
  participants: readonly SessionParticipant[],
): Promise<void> {
  for (const p of participants) {
    await p.context.close().catch(() => {});
  }
}

export interface AddOneCardOptions {
  /** Search query typed into the picker. Default 'luke jtl'. */
  query?: string;
  /** Regex matching the card tile to click. Default Luke (Standard). */
  cardName?: RegExp;
}

/**
 * Drive the "Add cards to Your side" picker and add a single card.
 * Defaults to Luke Skywalker - Hero of Yavin (Standard) since it's the
 * stable seed cross-referenced across other session specs.
 */
export async function addOneCardToSide(
  page: Page,
  options: AddOneCardOptions = {},
): Promise<void> {
  const {
    query = 'luke jtl',
    cardName = /Luke Skywalker - Hero of Yavin \(Standard\)/i,
  } = options;
  await page.getByRole('button', { name: /Add cards to Your side/i }).first().click();
  const input = page.getByRole('textbox', { name: /Search cards/i }).first();
  await input.fill(query);
  const tile = page.getByRole('button', { name: cardName }).first();
  await expect(tile).toBeVisible({ timeout: 10_000 });
  await tile.click();
  await page.getByRole('button', { name: 'Close search' }).first().click();
}

export interface CreateAndClaimResult {
  a: SessionParticipant;
  b: SessionParticipant;
  sessionUrl: string;
}

export interface CreateAndClaimOptions {
  /** Sign in side A as this Discord user. Default: ghost. */
  aAs?: TestUser;
  /** Sign in side B as this Discord user. Default: ghost. */
  bAs?: TestUser;
}

/**
 * Create an open-slot session as A, navigate B to the URL, claim. Both
 * participants land on the shared canvas. Returns both participants and
 * the session URL. Either side can be promoted to a Discord identity by
 * passing `aAs` / `bAs`.
 */
/**
 * Click an edit-emitting button (qty stepper, remove ×) and wait
 * for the resulting `PUT /api/sessions/<id>/edit` response. Rapid
 * successive clicks in the qty stepper race because each click
 * fires its own PUT — the second optimistic update can be
 * overwritten by the first PUT's response. Serializing on the
 * response makes the test deterministic.
 */
export async function clickAndWaitForEdit(
  page: Page,
  buttonName: string | RegExp,
): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      resp => /\/api\/sessions\/[A-Z0-9]{8}\/edit/.test(resp.url())
        && resp.request().method() === 'PUT',
      { timeout: 10_000 },
    ),
    page.getByRole('button', { name: buttonName }).first().click(),
  ]);
}

export async function createAndClaimSession(
  browser: Browser,
  options: CreateAndClaimOptions = {},
): Promise<CreateAndClaimResult> {
  const a = await openSessionParticipant(browser, { signedInAs: options.aAs });
  await a.page.getByRole('button', { name: /Invite someone/i }).first().click();
  await expect(a.page).toHaveURL(/\/s\/[A-Z0-9]{8}$/, { timeout: 10_000 });
  const sessionUrl = a.page.url();

  const b = await openSessionParticipant(browser, {
    url: sessionUrl,
    signedInAs: options.bAs,
  });
  const joinBtn = b.page.getByRole('button', { name: /Join this trade/i });
  await expect(joinBtn).toBeVisible({ timeout: 10_000 });
  await joinBtn.click();
  await expect(b.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

  await a.page.reload();
  await expect(a.page.getByText(/Shared · both editing/i)).toBeVisible({ timeout: 10_000 });

  return { a, b, sessionUrl };
}
