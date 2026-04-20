import { config } from 'dotenv';
config({ path: '.env.local' });

import { describe } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sealData } from 'iron-session';
import { getDb } from '../../lib/db.js';
import { users, wantsItems, availableItems, trades, userGuildMemberships, botInstalledGuilds } from '../../lib/schema.js';
import { eq } from 'drizzle-orm';
import { restrictionKey } from '../../lib/shared.js';
import type { DiscordClient, DiscordGuildSummary } from '../../lib/discordClient.js';

/**
 * Use instead of `describe` in API tests — skips the entire suite
 * when POSTGRES_URL isn't set (e.g., fork PRs without secrets).
 */
export const describeWithDb = process.env.POSTGRES_URL
  ? describe
  : describe.skip;

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
  _body: string | null;
  _headers: Record<string, string | string[]>;
  _redirectUrl: string | null;
} {
  const res = {
    _status: 200,
    _json: null,
    _body: null as string | null,
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
    send(body: string | Buffer) {
      res._body = typeof body === 'string' ? body : body.toString('utf8');
      return res;
    },
    end(body?: string | Buffer) {
      if (body != null) {
        res._body = typeof body === 'string' ? body : body.toString('utf8');
      }
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

export async function sealTestCookie(userId: string, opts: {
  discordAccessToken?: string;
  discordAccessTokenExpiresAt?: number;
  isAnonymous?: boolean;
} = {}): Promise<string> {
  return sealData(
    {
      userId,
      username: 'Test',
      handle: 'test',
      avatarUrl: null,
      isAnonymous: opts.isAnonymous ?? false,
      discordAccessToken: opts.discordAccessToken,
      discordAccessTokenExpiresAt: opts.discordAccessTokenExpiresAt,
    },
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
  communicationPref: 'prefer' | 'auto-accept' | 'allow' | 'dm-only';
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
    communicationPref: overrides.communicationPref ?? 'allow',
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

// --- Phase 4 guild fixtures -------------------------------------------------

/**
 * Insert a row into `bot_installed_guilds`. Returns a cleanup function
 * tests can call from afterEach.
 */
export async function installBotInGuild(guildId: string, opts: {
  guildName?: string;
  guildIcon?: string | null;
} = {}): Promise<() => Promise<void>> {
  const db = getDb();
  await db.insert(botInstalledGuilds).values({
    guildId,
    guildName: opts.guildName ?? `Test Guild ${guildId}`,
    guildIcon: opts.guildIcon ?? null,
  }).onConflictDoNothing();
  return async () => {
    await db.delete(botInstalledGuilds).where(eq(botInstalledGuilds.guildId, guildId)).catch(() => {});
  };
}

/**
 * Insert a row into `user_guild_memberships`. Pair with
 * `installBotInGuild` when the guild needs to appear as enrollable.
 */
export async function createGuildMembership(userId: string, guildId: string, opts: {
  enrolled?: boolean;
  includeInRollups?: boolean;
  appearInQueries?: boolean;
  canManage?: boolean;
  guildName?: string;
} = {}): Promise<() => Promise<void>> {
  const db = getDb();
  const enrolled = opts.enrolled ?? false;
  await db.insert(userGuildMemberships).values({
    id: `ugm-${userId}-${guildId}`,
    userId,
    guildId,
    guildName: opts.guildName ?? `Test Guild ${guildId}`,
    guildIcon: null,
    canManage: opts.canManage ?? false,
    enrolled,
    includeInRollups: opts.includeInRollups ?? enrolled,
    appearInQueries: opts.appearInQueries ?? enrolled,
  });
  return async () => {
    await db.delete(userGuildMemberships)
      .where(eq(userGuildMemberships.id, `ugm-${userId}-${guildId}`))
      .catch(() => {});
  };
}

/**
 * Convenience: put two users into the same installed guild with
 * both enrolled. Useful for community-source / match tests.
 */
export async function createMutualGuildMembership(
  userA: string,
  userB: string,
  guildId: string,
  opts: { enrolled?: boolean } = {},
): Promise<() => Promise<void>> {
  const cleanups = [
    await installBotInGuild(guildId),
    await createGuildMembership(userA, guildId, { enrolled: opts.enrolled ?? true }),
    await createGuildMembership(userB, guildId, { enrolled: opts.enrolled ?? true }),
  ];
  return async () => {
    for (const fn of cleanups.reverse()) await fn();
  };
}

/**
 * In-memory `DiscordClient` for tests. Seed with the guild list a
 * given access token should return; `getUserGuilds` is a lookup.
 * Use from tests that exercise `syncGuildMemberships` without
 * hitting real Discord.
 */
export function createFakeDiscordClient(
  guildsByAccessToken: Record<string, DiscordGuildSummary[]> = {},
): DiscordClient {
  return {
    async getUserGuilds(accessToken: string): Promise<DiscordGuildSummary[]> {
      return guildsByAccessToken[accessToken] ?? [];
    },
  };
}
