import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockRequest, mockResponse } from './helpers.js';
import handler, { getRedirectUri } from '../../api/auth/discord.js';

describe('getRedirectUri', () => {
  const origVercelUrl = process.env.VERCEL_URL;

  beforeEach(() => {
    // Null-out VERCEL_URL so host-header logic is exercised deterministically.
    delete process.env.VERCEL_URL;
  });

  afterEach(() => {
    if (origVercelUrl !== undefined) process.env.VERCEL_URL = origVercelUrl;
  });

  it('uses https + the request Host for production', () => {
    const req = mockRequest({ headers: { host: 'swutrade.com' } });
    expect(getRedirectUri(req)).toBe('https://swutrade.com/api/auth/callback');
  });

  it('uses https + the request Host for the beta subdomain', () => {
    // Regression: this used to pin to VERCEL_PROJECT_PRODUCTION_URL
    // (= swutrade.com), which broke the OAuth state cookie round-trip
    // on beta.swutrade.com because cookies are subdomain-scoped.
    const req = mockRequest({ headers: { host: 'beta.swutrade.com' } });
    expect(getRedirectUri(req)).toBe('https://beta.swutrade.com/api/auth/callback');
  });

  it('uses http for localhost with port', () => {
    const req = mockRequest({ headers: { host: 'localhost:3000' } });
    expect(getRedirectUri(req)).toBe('http://localhost:3000/api/auth/callback');
  });

  it('uses http for 127.0.0.1 with port', () => {
    const req = mockRequest({ headers: { host: '127.0.0.1:3000' } });
    expect(getRedirectUri(req)).toBe('http://127.0.0.1:3000/api/auth/callback');
  });

  it('falls back to VERCEL_URL when the Host header is missing', () => {
    process.env.VERCEL_URL = 'swu-trade-balancer-abc.vercel.app';
    const req = mockRequest();
    // mockRequest omits host; helpers don't inject one.
    delete (req.headers as Record<string, string>).host;
    expect(getRedirectUri(req))
      .toBe('https://swu-trade-balancer-abc.vercel.app/api/auth/callback');
  });

  it('falls back to localhost:3000 when neither Host nor VERCEL_URL is set', () => {
    const req = mockRequest();
    delete (req.headers as Record<string, string>).host;
    expect(getRedirectUri(req)).toBe('http://localhost:3000/api/auth/callback');
  });
});

describe('GET /api/auth/discord', () => {
  beforeEach(() => {
    // Arctic doesn't call Discord during URL construction — it just
    // assembles the authorize URL — so stub values are fine. Keeps the
    // test green on fork PRs / CI runs without OAuth secrets.
    vi.stubEnv('DISCORD_CLIENT_ID', 'test-client-id');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'test-client-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stamps the generated Discord URL with a redirect_uri matching the request Host', async () => {
    const req = mockRequest({ headers: { host: 'beta.swutrade.com' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(302);
    expect(res._redirectUrl).toBeTruthy();
    const url = new URL(res._redirectUrl!);
    expect(url.hostname).toBe('discord.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://beta.swutrade.com/api/auth/callback',
    );
  });

  it('sets oauth state + verifier cookies scoped to path=/', async () => {
    const req = mockRequest({ headers: { host: 'beta.swutrade.com' } });
    const res = mockResponse();
    await handler(req, res);

    const cookies = res._headers['set-cookie'] as string[] | undefined;
    expect(cookies).toBeDefined();
    expect(cookies!.length).toBe(2);

    const [stateCookie, verifierCookie] = cookies!;
    expect(stateCookie).toMatch(/^swu_oauth_state=/);
    expect(verifierCookie).toMatch(/^swu_oauth_verifier=/);

    for (const c of cookies!) {
      expect(c).toContain('HttpOnly');
      expect(c).toContain('Path=/');
      expect(c).toContain('SameSite=Lax');
      // https host → Secure flag must be present so the browser will
      // actually return the cookie on the callback.
      expect(c).toContain('Secure');
    }
  });

  it('omits the Secure flag for localhost (http) so cookies still round-trip in dev', async () => {
    const req = mockRequest({ headers: { host: 'localhost:3000' } });
    const res = mockResponse();
    await handler(req, res);

    const cookies = res._headers['set-cookie'] as string[];
    for (const c of cookies) {
      expect(c).not.toContain('Secure');
    }
  });

  it('embeds the state cookie value into the Discord URL state param', async () => {
    const req = mockRequest({ headers: { host: 'swutrade.com' } });
    const res = mockResponse();
    await handler(req, res);

    const cookies = res._headers['set-cookie'] as string[];
    const stateCookie = cookies.find(c => c.startsWith('swu_oauth_state='));
    expect(stateCookie).toBeDefined();
    const stateValue = stateCookie!.split(';')[0].split('=')[1];

    const url = new URL(res._redirectUrl!);
    expect(url.searchParams.get('state')).toBe(stateValue);
  });
});
