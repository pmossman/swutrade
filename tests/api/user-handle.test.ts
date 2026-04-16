import { describeWithDb, } from './helpers.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import handler from '../../api/user/[handle].js';
import { mockRequest, mockResponse, createTestUser, insertWant, insertAvailable } from './helpers.js';

describeWithDb('GET /api/user/[handle]', () => {
  let fixture: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    fixture = await createTestUser({ wantsPublic: true, availablePublic: false });
    await insertWant(fixture.id, 'jtl::luke', { qty: 2 });
    await insertAvailable(fixture.id, '622133', 1);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('returns user profile + public wants', async () => {
    const req = mockRequest({ query: { handle: fixture.handle } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as { user: { handle: string }; wants: unknown[] | null; available: unknown[] | null };
    expect(body.user.handle).toBe(fixture.handle);
    expect(body.wants).toHaveLength(1);
    expect(body.wants![0]).toMatchObject({ familyId: 'jtl::luke', qty: 2 });
  });

  it('hides available when available_public is false', async () => {
    const req = mockRequest({ query: { handle: fixture.handle } });
    const res = mockResponse();
    await handler(req, res);
    expect((res._json as { available: unknown }).available).toBeNull();
  });

  it('returns 404 for unknown handle', async () => {
    const req = mockRequest({ query: { handle: 'definitely-not-real-zzz' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(404);
  });

  it('shows available when available_public is true', async () => {
    const publicFixture = await createTestUser({ availablePublic: true });
    await insertAvailable(publicFixture.id, '617180', 3);
    try {
      const req = mockRequest({ query: { handle: publicFixture.handle } });
      const res = mockResponse();
      await handler(req, res);
      const body = res._json as { available: unknown[] | null };
      expect(body.available).toHaveLength(1);
      expect(body.available![0]).toMatchObject({ productId: '617180', qty: 3 });
    } finally {
      await publicFixture.cleanup();
    }
  });
});
