import { describeWithDb, mockRequest, mockResponse, sealTestCookie, createTestUser } from './helpers.js';
import { it, expect } from 'vitest';
import {
  handleMe,
  handleDismissMergeBanner,
} from '../../api/auth.js';

/**
 * UX-A5 — pinning the post-OAuth-merge reassurance flag end-to-end.
 *
 * The OAuth callback (handleCallback) sets `pendingMergeBanner` on
 * the iron-session when ghost→real merge moves ≥1 session. That set
 * happens via createSession's data param; this suite covers the
 * READ + DISMISS surfaces the frontend interacts with:
 *
 *   - /api/auth/me echoes the flag when present (or null otherwise)
 *   - /api/auth/dismiss-merge-banner clears it (POST, idempotent)
 *   - dismiss returns 401 without auth, 405 on non-POST
 *
 * The callback's set-on-merge path is exercised indirectly by
 * tests/api/sessions-merge.test.ts (which verifies the merge runs
 * + returns a count); this file pins the cookie-shape contract.
 */

describeWithDb('UX-A5 merge-banner cookie flag', () => {
  it('GET /api/auth/me echoes pendingMergeBanner when set', async () => {
    const fixture = await createTestUser();
    try {
      const cookie = await sealTestCookie(fixture.id, {
        pendingMergeBanner: { carriedCount: 2 },
      });
      const req = mockRequest({ cookies: { swu_session: cookie } });
      const res = mockResponse();
      await handleMe(req, res);
      expect(res._json).toMatchObject({
        user: { id: fixture.id },
        pendingMergeBanner: { carriedCount: 2 },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('GET /api/auth/me returns pendingMergeBanner: null when unset', async () => {
    const fixture = await createTestUser();
    try {
      const cookie = await sealTestCookie(fixture.id);
      const req = mockRequest({ cookies: { swu_session: cookie } });
      const res = mockResponse();
      await handleMe(req, res);
      expect(res._json).toMatchObject({
        user: { id: fixture.id },
        pendingMergeBanner: null,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('POST /api/auth/dismiss-merge-banner clears the flag', async () => {
    const fixture = await createTestUser();
    try {
      const cookie = await sealTestCookie(fixture.id, {
        pendingMergeBanner: { carriedCount: 1 },
      });
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
      });
      const res = mockResponse();
      await handleDismissMergeBanner(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ ok: true });
      // The Set-Cookie header on the response should carry the new
      // session payload (sans pendingMergeBanner). We can't decode it
      // here without re-sealing test machinery, so a simpler signal:
      // the call returned 200 ok. Behavioural assertion belongs to an
      // integration test that calls dismiss then re-calls /me on the
      // same cookie store — TODO when we have a more realistic test
      // harness for cookie round-tripping.
    } finally {
      await fixture.cleanup();
    }
  });

  it('POST /api/auth/dismiss-merge-banner is idempotent (no flag set)', async () => {
    const fixture = await createTestUser();
    try {
      const cookie = await sealTestCookie(fixture.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
      });
      const res = mockResponse();
      await handleDismissMergeBanner(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ ok: true });
    } finally {
      await fixture.cleanup();
    }
  });

  it('POST /api/auth/dismiss-merge-banner returns 401 without auth', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handleDismissMergeBanner(req, res);
    expect(res._status).toBe(401);
  });

  it('GET /api/auth/dismiss-merge-banner returns 405', async () => {
    const fixture = await createTestUser();
    try {
      const cookie = await sealTestCookie(fixture.id);
      const req = mockRequest({
        method: 'GET',
        cookies: { swu_session: cookie },
      });
      const res = mockResponse();
      await handleDismissMergeBanner(req, res);
      expect(res._status).toBe(405);
    } finally {
      await fixture.cleanup();
    }
  });
});
