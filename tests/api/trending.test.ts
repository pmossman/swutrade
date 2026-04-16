import { describeWithDb, } from './helpers.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import handler from '../../api/trending.js';
import { mockRequest, mockResponse, createTestUser, insertWant } from './helpers.js';

describeWithDb('GET /api/trending', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createTestUser>>> = [];

  beforeEach(async () => {
    // Create two users with overlapping wants to verify aggregation.
    const user1 = await createTestUser();
    const user2 = await createTestUser();
    fixtures.push(user1, user2);

    await insertWant(user1.id, 'jtl::luke');
    await insertWant(user2.id, 'jtl::luke');
    await insertWant(user1.id, 'law::cad-bane');
  });

  afterEach(async () => {
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('returns trending cards sorted by user count', async () => {
    const req = mockRequest();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const trending = res._json as Array<{ familyId: string; userCount: number; totalQty: number }>;
    expect(trending.length).toBeGreaterThanOrEqual(2);

    // jtl::luke should have more users than law::cad-bane (at least
    // our 2 fixture users, possibly more from real DB data).
    const luke = trending.find(t => t.familyId === 'jtl::luke');
    const cad = trending.find(t => t.familyId === 'law::cad-bane');
    expect(luke).toBeTruthy();
    expect(cad).toBeTruthy();
    expect(luke!.userCount).toBeGreaterThanOrEqual(2);
    expect(luke!.userCount).toBeGreaterThanOrEqual(cad!.userCount);
  });
});
