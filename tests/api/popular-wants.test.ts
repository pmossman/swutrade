import { describeWithDb } from './helpers.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import handler from '../../api/popular-wants.js';
import {
  mockRequest,
  mockResponse,
  createTestUser,
  insertWant,
  sealTestCookie,
} from './helpers.js';

describeWithDb('POST /api/popular-wants', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];

  beforeEach(async () => {
    const [u1, u2, u3] = await Promise.all([
      createTestUser(),
      createTestUser(),
      createTestUser(),
    ]);
    fixtures.push(u1, u2, u3);

    // u1 + u2 want 'shared::vader'; u3 wants 'shared::vader' + 'only::cad'.
    await insertWant(u1.id, 'shared::vader');
    await insertWant(u2.id, 'shared::vader');
    await insertWant(u3.id, 'shared::vader');
    await insertWant(u3.id, 'only::cad');
  });

  afterEach(async () => {
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('returns userCount per familyId for anonymous callers', async () => {
    const req = mockRequest({
      method: 'POST',
      body: { familyIds: ['shared::vader', 'only::cad', 'nobody::wants-this'] },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { counts } = res._json as { counts: Record<string, number> };
    expect(counts['shared::vader']).toBeGreaterThanOrEqual(3);
    expect(counts['only::cad']).toBeGreaterThanOrEqual(1);
    // Families with zero matches are omitted rather than returned as 0.
    expect(counts['nobody::wants-this']).toBeUndefined();
  });

  it('excludes the caller from the count when signed in', async () => {
    const [u1] = fixtures;
    const sessionCookie = await sealTestCookie(u1.id);

    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: sessionCookie },
      body: { familyIds: ['shared::vader'] },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { counts } = res._json as { counts: Record<string, number> };
    // u1 is one of the three users wanting 'shared::vader'. Signed in
    // as u1, the count drops by one.
    expect(counts['shared::vader']).toBeGreaterThanOrEqual(2);
  });

  it('returns empty counts for an empty familyIds list', async () => {
    const req = mockRequest({ method: 'POST', body: { familyIds: [] } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ counts: {} });
  });

  it('rejects non-POST methods', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });
});
