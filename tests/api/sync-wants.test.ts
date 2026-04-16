import { describeWithDb, } from './helpers.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { handleWants as handler } from '../../api/sync.js';
import { mockRequest, mockResponse, sealTestCookie, createTestUser, insertWant } from './helpers.js';

describeWithDb('/api/sync/wants', () => {
  let fixture: Awaited<ReturnType<typeof createTestUser>>;
  let cookie: string;

  beforeEach(async () => {
    fixture = await createTestUser();
    cookie = await sealTestCookie(fixture.id);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('GET returns empty array for new user', async () => {
    const req = mockRequest({ cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual([]);
  });

  it('GET returns existing wants', async () => {
    await insertWant(fixture.id, 'jtl::luke', { qty: 3, isPriority: true });
    const req = mockRequest({ cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handler(req, res);
    const wants = res._json as Array<{ familyId: string; qty: number; isPriority?: boolean }>;
    expect(wants).toHaveLength(1);
    expect(wants[0]).toMatchObject({ familyId: 'jtl::luke', qty: 3 });
  });

  it('PUT upserts items and returns canonical state', async () => {
    const req = mockRequest({
      method: 'PUT',
      cookies: { swu_session: cookie },
      body: [
        { id: 'w1', familyId: 'jtl::luke', qty: 2, restriction: { mode: 'any' }, addedAt: Date.now() },
        { id: 'w2', familyId: 'law::cad-bane', qty: 1, restriction: { mode: 'restricted', variants: ['Hyperspace'] }, addedAt: Date.now() },
      ],
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const wants = res._json as Array<{ familyId: string }>;
    expect(wants).toHaveLength(2);
  });

  it('PUT deletes server items not in the client payload', async () => {
    // First PUT two items to establish server state.
    const setupReq = mockRequest({
      method: 'PUT',
      cookies: { swu_session: cookie },
      body: [
        { id: 'keep-w1', familyId: 'jtl::luke', qty: 1, restriction: { mode: 'any' }, addedAt: Date.now() },
        { id: 'drop-w2', familyId: 'law::cad-bane', qty: 1, restriction: { mode: 'any' }, addedAt: Date.now() },
      ],
    });
    await handler(setupReq, mockResponse());

    // Client sends only one back (same id) → the other should be deleted.
    const req = mockRequest({
      method: 'PUT',
      cookies: { swu_session: cookie },
      body: [
        { id: 'keep-w1', familyId: 'jtl::luke', qty: 1, restriction: { mode: 'any' }, addedAt: Date.now() },
      ],
    });
    const res = mockResponse();
    await handler(req, res);
    const wants = res._json as Array<{ familyId: string }>;
    expect(wants).toHaveLength(1);
    expect(wants[0].familyId).toBe('jtl::luke');
  });

  it('returns 401 without auth', async () => {
    const req = mockRequest();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });
});
