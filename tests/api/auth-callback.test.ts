import { describeWithDb, mockRequest, mockResponse, createTestUser, sealTestCookie } from './helpers.js';
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Mock the arctic library at module scope. handleCallback uses
 * arctic's `Discord` class to exchange the OAuth code for tokens —
 * we replace it with a stub that returns synthetic tokens (or
 * throws, depending on the test). The other arctic exports
 * (`generateState`, `generateCodeVerifier`) aren't used by
 * handleCallback, so we provide trivial stubs to keep the import
 * shape intact.
 *
 * This mock applies ONLY to this test file. handleDiscordStart
 * tests in auth-oauth.test.ts continue to use the real arctic.
 */
const mockValidateAuthCode = vi.fn();
vi.mock('arctic', () => ({
  Discord: class {
    constructor(_clientId: string, _clientSecret: string, _redirectUri: string) {}
    validateAuthorizationCode = mockValidateAuthCode;
  },
  generateState: () => 'unused-in-callback-tests',
  generateCodeVerifier: () => 'unused-in-callback-tests',
}));

import { handleCallback } from '../../api/auth.js';
import { getDb } from '../../lib/db.js';
import { users, tradeSessions } from '../../lib/schema.js';

/**
 * F2 of the Discord-coverage audit (2026-05-01). The callback
 * handler had zero unit tests despite being the bulk of OAuth
 * logic — token exchange, users/@me fetch, handle derivation,
 * collision fallback, and the ghost-merge path that moves
 * sessions from an anonymous user onto the resolved real user.
 *
 * Mocks: arctic's Discord class (above) + global fetch (per-test
 * setup so each case can return its own users/@me payload).
 */

const FAKE_TOKENS = {
  accessToken: () => 'fake-access-token',
  accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
};

let originalFetch: typeof globalThis.fetch;

function mockUsersAtMe(payload: {
  id: string;
  username: string;
  avatar?: string | null;
  global_name?: string | null;
}, status = 200) {
  const realFetch = originalFetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('discord.com/api/users/@me/guilds')) {
      // syncGuildMemberships swallows non-2xx by default — return a
      // 401 so it logs and proceeds without affecting test outcome.
      return new Response('', { status: 401 });
    }
    if (u === 'https://discord.com/api/users/@me') {
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Pass through to the real fetch so Neon HTTP DB calls work.
    return realFetch(url, init);
  }) as typeof globalThis.fetch;
}

function callbackReq(opts: {
  code?: string;
  state?: string;
  storedState?: string;
  codeVerifier?: string;
  swuSession?: string;
  host?: string;
}) {
  const cookies: Record<string, string> = {};
  if (opts.storedState !== undefined) cookies.swu_oauth_state = opts.storedState;
  if (opts.codeVerifier !== undefined) cookies.swu_oauth_verifier = opts.codeVerifier;
  if (opts.swuSession !== undefined) cookies.swu_session = opts.swuSession;
  return mockRequest({
    query: {
      ...(opts.code !== undefined ? { code: opts.code } : {}),
      ...(opts.state !== undefined ? { state: opts.state } : {}),
    },
    cookies,
    headers: { host: opts.host ?? 'beta.swutrade.com' },
  });
}

/**
 * Verifies that handleCallback's exit emitted Set-Cookie entries
 * that null out the OAuth state + verifier cookies. The serialize
 * format is `name=; Max-Age=0; HttpOnly; Path=/`.
 */
function assertOAuthCookiesCleared(res: ReturnType<typeof mockResponse>): void {
  const setCookie = res._headers['set-cookie'] as string[] | undefined;
  expect(setCookie).toBeDefined();
  const stateCleared = setCookie!.some(c =>
    c.startsWith('swu_oauth_state=') && /Max-Age=0/i.test(c),
  );
  const verifierCleared = setCookie!.some(c =>
    c.startsWith('swu_oauth_verifier=') && /Max-Age=0/i.test(c),
  );
  expect(stateCleared, 'swu_oauth_state cookie should be cleared').toBe(true);
  expect(verifierCleared, 'swu_oauth_verifier cookie should be cleared').toBe(true);
}

describeWithDb('handleCallback (api/auth)', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockValidateAuthCode.mockReset();
    vi.stubEnv('DISCORD_CLIENT_ID', 'test-client-id');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'test-client-secret');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns 400 when `code` is missing', async () => {
    const req = callbackReq({ state: 'abc' });
    const res = mockResponse();
    await handleCallback(req, res);
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: expect.stringMatching(/missing code/i) });
    // Discord wasn't touched — the validate stub never ran.
    expect(mockValidateAuthCode).not.toHaveBeenCalled();
    // OAuth cookies cleared so a stale verifier doesn't sit through the
    // 600s TTL when sign-in fails (S1.3).
    assertOAuthCookiesCleared(res);
  });

  it('returns 400 when `state` cookie does not match query state (CSRF)', async () => {
    const req = callbackReq({
      code: 'c',
      state: 'attacker-supplied',
      storedState: 'real-state',
      codeVerifier: 'v',
    });
    const res = mockResponse();
    await handleCallback(req, res);
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: expect.stringMatching(/invalid state/i) });
    expect(mockValidateAuthCode).not.toHaveBeenCalled();
    assertOAuthCookiesCleared(res);
  });

  it('returns 400 with detail when validateAuthorizationCode throws', async () => {
    mockValidateAuthCode.mockRejectedValueOnce(new Error('token endpoint says 401'));
    const req = callbackReq({
      code: 'c',
      state: 's',
      storedState: 's',
      codeVerifier: 'v',
    });
    const res = mockResponse();
    await handleCallback(req, res);
    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({
      error: expect.stringMatching(/failed to exchange/i),
      detail: 'token endpoint says 401',
    });
    assertOAuthCookiesCleared(res);
  });

  it('returns 502 when users/@me fetch fails', async () => {
    mockValidateAuthCode.mockResolvedValueOnce(FAKE_TOKENS);
    const realFetch = originalFetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.startsWith('https://discord.com/')) {
        return new Response('upstream down', { status: 503 });
      }
      return realFetch(url, init);
    }) as typeof globalThis.fetch;
    const req = callbackReq({
      code: 'c',
      state: 's',
      storedState: 's',
      codeVerifier: 'v',
    });
    const res = mockResponse();
    await handleCallback(req, res);
    expect(res._status).toBe(502);
    expect(res._json).toMatchObject({ error: expect.stringMatching(/discord profile/i) });
    assertOAuthCookiesCleared(res);
  });

  it('happy path: new user — inserts a row with derived handle + public-by-default flags', async () => {
    const discordId = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    mockValidateAuthCode.mockResolvedValueOnce(FAKE_TOKENS);
    mockUsersAtMe({
      id: discordId,
      username: 'NewUser_42',
      avatar: 'avatar-hash',
      global_name: 'Display Name',
    });

    const req = callbackReq({
      code: 'c',
      state: 's',
      storedState: 's',
      codeVerifier: 'v',
    });
    const res = mockResponse();
    await handleCallback(req, res);

    expect(res._status).toBe(302);
    expect(res._redirectUrl).toBe('/');

    const db = getDb();
    const [row] = await db.select().from(users).where(eq(users.discordId, discordId)).limit(1);
    expect(row).toBeDefined();
    // username uses global_name preference; lower-cased + symbol-stripped handle.
    expect(row.username).toBe('Display Name');
    expect(row.handle).toBe('newuser_42');
    expect(row.avatarUrl).toBe(`https://cdn.discordapp.com/avatars/${discordId}/avatar-hash.png`);
    // Public-by-default for new users (beta-feedback driven).
    expect(row.profileVisibility).toBe('public');
    expect(row.wantsPublic).toBe(true);
    expect(row.availablePublic).toBe(true);

    // Cleanup.
    await db.delete(users).where(eq(users.id, discordId));
  });

  it('existing user: updates username + avatar, keeps the original handle', async () => {
    const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const fixture = await createTestUser({
      handle: `orig-${uniq}`,
      username: 'Old Name',
    });
    try {
      mockValidateAuthCode.mockResolvedValueOnce(FAKE_TOKENS);
      // createTestUser sets `discordId === id` for the fixture,
      // so the existing-user lookup matches when we use fixture.id.
      mockUsersAtMe({
        id: fixture.id,
        username: 'doesnt-matter',
        avatar: 'new-avatar',
        global_name: 'New Display',
      });

      const req = callbackReq({
        code: 'c',
        state: 's',
        storedState: 's',
        codeVerifier: 'v',
      });
      const res = mockResponse();
      await handleCallback(req, res);

      expect(res._status).toBe(302);

      const db = getDb();
      const [row] = await db.select().from(users).where(eq(users.id, fixture.id)).limit(1);
      expect(row.username).toBe('New Display');
      expect(row.avatarUrl).toBe(`https://cdn.discordapp.com/avatars/${fixture.id}/new-avatar.png`);
      // Handle is NOT re-derived on update — preserves the existing one.
      expect(row.handle).toBe(`orig-${uniq}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('handle collision: appends a random suffix when the derived handle is taken', async () => {
    // Seed an existing user whose handle matches what the new user
    // would derive. The callback must avoid reusing that handle.
    // Use a random base so reruns + parallel shards don't collide.
    const baseHandle = `collide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const incumbent = await createTestUser({
      handle: baseHandle,
      username: 'Incumbent',
    });
    try {
      const newDiscordId = `d-collide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      mockValidateAuthCode.mockResolvedValueOnce(FAKE_TOKENS);
      mockUsersAtMe({
        id: newDiscordId,
        // username is already lowercase + valid handle chars, so it
        // derives to baseHandle directly.
        username: baseHandle,
        avatar: null,
        global_name: null,
      });

      const req = callbackReq({
        code: 'c',
        state: 's',
        storedState: 's',
        codeVerifier: 'v',
      });
      const res = mockResponse();
      await handleCallback(req, res);

      expect(res._status).toBe(302);

      const db = getDb();
      const [row] = await db.select().from(users).where(eq(users.discordId, newDiscordId)).limit(1);
      expect(row).toBeDefined();
      expect(row.handle).not.toBe(baseHandle);
      // Source: api/auth.ts adds `-${Math.random().toString(36).slice(2, 6)}`
      // → 4 lowercase alphanumeric chars.
      expect(row.handle).toMatch(new RegExp(`^${baseHandle}-[a-z0-9]{4}$`));

      await db.delete(users).where(eq(users.id, newDiscordId));
    } finally {
      await incumbent.cleanup();
    }
  });

  it('ghost-merge: prior anonymous session migrates trade_sessions onto the resolved real user', async () => {
    const ghostUserId = `ghost-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const realDiscordId = `d-real-${Date.now().toString(36)}`;
    const sessionId = `S${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const db = getDb();

    // Seed a ghost user + a session with userAId pointing at them.
    await db.insert(users).values({
      id: ghostUserId,
      discordId: ghostUserId,
      username: 'Ghost',
      handle: ghostUserId.slice(0, 16),
      avatarUrl: null,
    });
    await db.insert(tradeSessions).values({
      id: sessionId,
      userAId: ghostUserId,
      userBId: null,
      status: 'active',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    try {
      mockValidateAuthCode.mockResolvedValueOnce(FAKE_TOKENS);
      mockUsersAtMe({
        id: realDiscordId,
        username: 'RealUser',
        avatar: null,
        global_name: 'Real User',
      });

      // Seal a session cookie marking the caller as the ghost.
      const ghostCookie = await sealTestCookie(ghostUserId, { isAnonymous: true });

      const req = callbackReq({
        code: 'c',
        state: 's',
        storedState: 's',
        codeVerifier: 'v',
        swuSession: ghostCookie,
      });
      const res = mockResponse();
      await handleCallback(req, res);

      expect(res._status).toBe(302);

      // The session was migrated onto the real user.
      const [migratedSession] = await db.select().from(tradeSessions).where(eq(tradeSessions.id, sessionId)).limit(1);
      expect(migratedSession.userAId).toBe(realDiscordId);

      // Real user row exists.
      const [realRow] = await db.select().from(users).where(eq(users.id, realDiscordId)).limit(1);
      expect(realRow).toBeDefined();
      expect(realRow.handle).toBe('realuser');
    } finally {
      // Clean up — order matters because of FKs.
      await db.delete(tradeSessions).where(eq(tradeSessions.id, sessionId)).catch(() => {});
      await db.delete(users).where(eq(users.id, realDiscordId)).catch(() => {});
      await db.delete(users).where(eq(users.id, ghostUserId)).catch(() => {});
    }
  });
});
