import { describeWithDb, } from './helpers.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import handler from '../../api/trades.js';
import { mockRequest, mockResponse, sealTestCookie, createTestUser } from './helpers.js';

describeWithDb('/api/trades', () => {
  let fixture: Awaited<ReturnType<typeof createTestUser>>;
  let cookie: string;

  beforeEach(async () => {
    fixture = await createTestUser();
    cookie = await sealTestCookie(fixture.id);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('returns 401 without auth', async () => {
    const req = mockRequest();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('POST saves a trade and returns its id', async () => {
    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: cookie },
      body: {
        yourCards: [{ productId: '123', name: 'Card A', variant: 'Standard', qty: 1, unitPrice: 1.0 }],
        theirCards: [{ productId: '456', name: 'Card B', variant: 'Hyperspace', qty: 2, unitPrice: 2.0 }],
        percentage: 80,
        priceMode: 'market',
        totalYours: 1.0,
        totalTheirs: 4.0,
      },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(201);
    expect(res._json).toHaveProperty('id');
  });

  it('GET returns saved trades sorted by date descending', async () => {
    // Save two trades.
    for (let i = 0; i < 2; i++) {
      const req = mockRequest({
        method: 'POST',
        cookies: { swu_session: cookie },
        body: {
          yourCards: [{ productId: `p${i}`, name: `Card ${i}`, variant: 'Standard', qty: 1, unitPrice: i }],
          theirCards: [],
          percentage: 80,
          priceMode: 'market',
          totalYours: i,
          totalTheirs: 0,
        },
      });
      await handler(req, mockResponse());
    }

    const req = mockRequest({ cookies: { swu_session: cookie } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const trades = res._json as Array<{ createdAt: string }>;
    expect(trades).toHaveLength(2);
    expect(new Date(trades[0].createdAt).getTime())
      .toBeGreaterThanOrEqual(new Date(trades[1].createdAt).getTime());
  });
});
