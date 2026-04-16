import { config } from 'dotenv';
config({ path: '.env.local' });

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sealData } from 'iron-session';
import { getDb } from '../../lib/db.js';
import { users, wantsItems, availableItems, trades } from '../../lib/schema.js';
import { eq } from 'drizzle-orm';
import { restrictionKey } from '../../lib/shared.js';

// --- Mock Request / Response ------------------------------------------------

export function mockRequest(opts: {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
} = {}): VercelRequest {
  const cookieHeader = opts.cookies
    ? Object.entries(opts.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';

  return {
    method: opts.method ?? 'GET',
    body: opts.body ?? null,
    query: opts.query ?? {},
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
      ...opts.headers,
    },
  } as unknown as VercelRequest;
}

export function mockResponse(): VercelResponse & {
  _status: number;
  _json: unknown;
  _headers: Record<string, string | string[]>;
  _redirectUrl: string | null;
} {
  const res = {
    _status: 200,
    _json: null,
    _headers: {} as Record<string, string | string[]>,
    _redirectUrl: null as string | null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
    setHeader(key: string, value: string | string[]) {
      res._headers[key.toLowerCase()] = value;
      return res;
    },
    getHeader(key: string) {
      return res._headers[key.toLowerCase()];
    },
    redirect(code: number, url: string) {
      res._status = code;
      res._redirectUrl = url;
      return res;
    },
  };
  return res as unknown as VercelResponse & typeof res;
}

// --- Auth helpers -----------------------------------------------------------

export async function sealTestCookie(userId: string): Promise<string> {
  return sealData(
    { userId, username: 'Test', handle: 'test', avatarUrl: null },
    { password: process.env.SESSION_SECRET!, ttl: 86400 },
  );
}

// --- DB fixtures ------------------------------------------------------------

export async function createTestUser(overrides: Partial<{
  id: string;
  handle: string;
  username: string;
  wantsPublic: boolean;
  availablePublic: boolean;
}> = {}) {
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 12);
  const id = overrides.id ?? `api-${suffix}`;
  const handle = overrides.handle ?? `api-${suffix}`;

  await db.insert(users).values({
    id,
    discordId: id,
    username: overrides.username ?? `API Test ${suffix}`,
    handle,
    avatarUrl: null,
    wantsPublic: overrides.wantsPublic ?? true,
    availablePublic: overrides.availablePublic ?? false,
  });

  return {
    id,
    handle,
    async cleanup() {
      await db.delete(trades).where(eq(trades.userId, id)).catch(() => {});
      await db.delete(wantsItems).where(eq(wantsItems.userId, id)).catch(() => {});
      await db.delete(availableItems).where(eq(availableItems.userId, id)).catch(() => {});
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    },
  };
}

export async function insertWant(userId: string, familyId: string, opts: {
  qty?: number;
  restriction?: { mode: string; variants?: string[] };
  isPriority?: boolean;
} = {}) {
  const db = getDb();
  const restriction = opts.restriction ?? { mode: 'any' };
  await db.insert(wantsItems).values({
    id: `want-${crypto.randomUUID().slice(0, 12)}`,
    userId,
    familyId,
    qty: opts.qty ?? 1,
    restrictionMode: restriction.mode,
    restrictionVariants: restriction.mode === 'restricted' ? restriction.variants ?? [] : null,
    restrictionKey: restrictionKey(restriction),
    isPriority: opts.isPriority ?? false,
    addedAt: Date.now(),
  });
}

export async function insertAvailable(userId: string, productId: string, qty = 1) {
  const db = getDb();
  await db.insert(availableItems).values({
    id: `avail-${crypto.randomUUID().slice(0, 12)}`,
    userId,
    productId,
    qty,
    addedAt: Date.now(),
  });
}
