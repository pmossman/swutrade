import { describeWithDb, } from './helpers.js';
import { it, expect } from 'vitest';
import handler from '../../api/auth/me.js';
import { mockRequest, mockResponse, sealTestCookie, createTestUser } from './helpers.js';

describeWithDb('GET /api/auth/me', () => {
  it('returns { user: null } when no session cookie is present', async () => {
    const req = mockRequest();
    const res = mockResponse();
    await handler(req, res);
    expect(res._json).toEqual({ user: null });
  });

  it('returns user data when a valid session cookie is present', async () => {
    const fixture = await createTestUser();
    try {
      const cookie = await sealTestCookie(fixture.id);
      const req = mockRequest({ cookies: { swu_session: cookie } });
      const res = mockResponse();
      await handler(req, res);
      expect(res._json).toMatchObject({
        user: { id: fixture.id, username: 'Test', handle: 'test' },
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
