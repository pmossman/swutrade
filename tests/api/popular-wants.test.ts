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

    // u1 + u2 want 'shared::vader' with no restriction (any variant);
    // u3 wants 'shared::vader' restricted to Hyperspace Foil only +
    // wants 'only::cad' with no restriction.
    await insertWant(u1.id, 'shared::vader');
    await insertWant(u2.id, 'shared::vader');
    await insertWant(u3.id, 'shared::vader', {
      restriction: { mode: 'restricted', variants: ['Hyperspace Foil'] },
    });
    await insertWant(u3.id, 'only::cad');
  });

  afterEach(async () => {
    for (const f of fixtures) await f.cleanup();
    fixtures.length = 0;
  });

  it('returns per-productId count + users for anonymous callers', async () => {
    const req = mockRequest({
      method: 'POST',
      body: {
        items: [
          { productId: 'p-vader-standard', familyId: 'shared::vader', variant: 'Standard' },
          { productId: 'p-cad', familyId: 'only::cad', variant: 'Standard' },
          { productId: 'p-nobody', familyId: 'nobody::wants-this', variant: 'Standard' },
        ],
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { counts } = res._json as { counts: Record<string, { count: number; users: Array<{ handle: string }> }> };

    // shared::vader Standard: only u1 + u2 match (u3's restriction is
    // Hyperspace Foil only — doesn't satisfy Standard).
    expect(counts['p-vader-standard']?.count).toBeGreaterThanOrEqual(2);
    expect(counts['p-vader-standard']?.users.length).toBeGreaterThanOrEqual(2);

    // only::cad Standard: u3 has restriction.any → matches.
    expect(counts['p-cad']?.count).toBeGreaterThanOrEqual(1);

    // Empty families omitted.
    expect(counts['p-nobody']).toBeUndefined();
  });

  it('restriction-aware: Hyperspace Foil binder row matches Hyperspace-Foil-restricted want', async () => {
    const req = mockRequest({
      method: 'POST',
      body: {
        items: [
          { productId: 'p-vader-hsf', familyId: 'shared::vader', variant: 'Hyperspace Foil' },
        ],
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { counts } = res._json as { counts: Record<string, { count: number }> };
    // u1 + u2 (any) + u3 (HSF-only) all match a HSF binder row.
    expect(counts['p-vader-hsf']?.count).toBeGreaterThanOrEqual(3);
  });

  it('restriction-aware: Standard binder row does NOT match Hyperspace-Foil-only want', async () => {
    // Pin the regression: variant-stripped counts used to lie here —
    // a Standard binder row would have shown +1 from u3's HSF-only
    // want. With variant-awareness u3 falls out of the tally.
    const req = mockRequest({
      method: 'POST',
      body: {
        items: [
          { productId: 'p-vader-std', familyId: 'shared::vader', variant: 'Standard' },
        ],
      },
    });
    const res = mockResponse();
    await handler(req, res);

    const { counts } = res._json as { counts: Record<string, { count: number; users: Array<{ handle: string }> }> };
    // u1 + u2 only. u3's want is HSF-restricted and must NOT count.
    const u3Handle = fixtures[2].handle;
    const handles = counts['p-vader-std']?.users.map(u => u.handle) ?? [];
    expect(handles).not.toContain(u3Handle);
  });

  it('excludes the caller from the count when signed in', async () => {
    const [u1] = fixtures;
    const sessionCookie = await sealTestCookie(u1.id);

    const req = mockRequest({
      method: 'POST',
      cookies: { swu_session: sessionCookie },
      body: {
        items: [
          { productId: 'p-vader', familyId: 'shared::vader', variant: 'Standard' },
        ],
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const { counts } = res._json as { counts: Record<string, { count: number; users: Array<{ handle: string }> }> };
    // u1 is one of the matching wanters; signed-in as u1 the count
    // drops by one + u1's handle never appears in the users list.
    const handles = counts['p-vader']?.users.map(u => u.handle) ?? [];
    expect(handles).not.toContain(u1.handle);
  });

  it('returns empty counts for an empty items list', async () => {
    const req = mockRequest({ method: 'POST', body: { items: [] } });
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
