import { describeWithDb, mockRequest, mockResponse, createTestUser, sealTestCookie } from './helpers.js';
import { it, expect } from 'vitest';
import { handleLogout } from '../../api/auth.js';

/**
 * Coverage for the POST-only method gate on `/api/auth/logout`.
 * Without the gate any same-site GET (e.g. an `<img src="...">` tag)
 * could clear a user's session. SameSite=Lax narrows the surface
 * but doesn't fully close it for top-level navigations; the method
 * gate does.
 *
 * Same shape as `auth-merge-banner.test.ts`'s GET-405 + POST-OK
 * coverage of `handleDismissMergeBanner`.
 */

describeWithDb('POST /api/auth/logout — method gate', () => {
  it('GET returns 405 with Allow: POST', async () => {
    const fixture = await createTestUser();
    try {
      const cookie = await sealTestCookie(fixture.id);
      const req = mockRequest({
        method: 'GET',
        cookies: { swu_session: cookie },
      });
      const res = mockResponse();
      await handleLogout(req, res);
      expect(res._status).toBe(405);
      expect(res._headers['allow']).toBe('POST');
    } finally {
      await fixture.cleanup();
    }
  });

  it('POST clears the session and returns ok', async () => {
    const fixture = await createTestUser();
    try {
      const cookie = await sealTestCookie(fixture.id);
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
      });
      const res = mockResponse();
      await handleLogout(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ ok: true });
      // destroySession sets the session cookie to an empty/expired value;
      // not asserting cookie shape here (that's iron-session's contract).
    } finally {
      await fixture.cleanup();
    }
  });

  it('PUT / DELETE / PATCH all return 405', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH'] as const) {
      const req = mockRequest({ method });
      const res = mockResponse();
      await handleLogout(req, res);
      expect(res._status).toBe(405);
    }
  });
});
