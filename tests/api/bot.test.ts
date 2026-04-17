import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mockRequest, mockResponse } from './helpers.js';
import handler, { dispatchBotPayload } from '../../api/bot.js';
import { getDb } from '../../lib/db.js';
import { botInstalledGuilds } from '../../lib/schema.js';

function extractRawEd25519PublicKey(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(12).toString('hex');
}

describeWithDb('/api/bot dispatcher', () => {
  const cleanupGuildIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const id of cleanupGuildIds) {
      await db.delete(botInstalledGuilds).where(eq(botInstalledGuilds.guildId, id)).catch(() => {});
    }
    cleanupGuildIds.length = 0;
  });

  describe('interactions', () => {
    it('replies to a PING with a PONG (the handshake Discord requires before accepting the endpoint URL)', async () => {
      const res = mockResponse();
      await dispatchBotPayload('interactions', { type: 1 }, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ type: 1 });
    });

    it('acks unknown interaction types with DEFERRED_UPDATE_MESSAGE (6) so Discord doesn\'t show a generic failure', async () => {
      const res = mockResponse();
      await dispatchBotPayload('interactions', { type: 999 }, res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ type: 6 });
    });
  });

  describe('events', () => {
    it('acks the event-webhook verification ping (type 0) with a 204', async () => {
      const res = mockResponse();
      await dispatchBotPayload('events', { type: 0 }, res);
      expect(res._status).toBe(204);
    });

    it('APPLICATION_AUTHORIZED writes a bot_installed_guilds row with cached metadata', async () => {
      const guildId = `e2e-authd-${Date.now()}`;
      cleanupGuildIds.push(guildId);

      const res = mockResponse();
      await dispatchBotPayload('events', {
        type: 1,
        event: {
          type: 'APPLICATION_AUTHORIZED',
          data: {
            integration_type: 0,
            scopes: ['bot', 'applications.commands'],
            user: { id: 'installer-user', username: 'Installer' },
            guild: { id: guildId, name: 'Star Wars SD Test', icon: 'abc123' },
          },
        },
      }, res);

      expect(res._status).toBe(204);

      const db = getDb();
      const [row] = await db
        .select()
        .from(botInstalledGuilds)
        .where(eq(botInstalledGuilds.guildId, guildId))
        .limit(1);
      expect(row).toBeTruthy();
      expect(row.guildName).toBe('Star Wars SD Test');
      expect(row.guildIcon).toBe('abc123');
      expect(row.installedByUserId).toBe('installer-user');
    });

    it('APPLICATION_AUTHORIZED without a guild (user-install) is a no-op', async () => {
      const res = mockResponse();
      await dispatchBotPayload('events', {
        type: 1,
        event: {
          type: 'APPLICATION_AUTHORIZED',
          data: {
            integration_type: 1,
            scopes: ['identify'],
            user: { id: 'user-installer', username: 'Solo User' },
            // no guild object
          },
        },
      }, res);

      // Still 204 — we don't reject, just nothing to write.
      expect(res._status).toBe(204);
    });

    it('unknown event types are acked (2xx) so Discord doesn\'t retry', async () => {
      const res = mockResponse();
      await dispatchBotPayload('events', {
        type: 1,
        event: { type: 'SOME_FUTURE_EVENT', data: {} },
      }, res);
      expect(res._status).toBe(204);
    });
  });

  it('unknown action returns 404', async () => {
    const res = mockResponse();
    await dispatchBotPayload('who-knows', {}, res);
    expect(res._status).toBe(404);
  });

  /**
   * Full round-trip through the default handler, including signature
   * verification + body canonicalization. Mirrors the exact path
   * Discord's Developer Portal hits when it saves an Interactions
   * Endpoint URL: compact-JSON PING, Ed25519 sig over timestamp+body.
   *
   * Regression guard: @vercel/node pre-parses JSON bodies, so the
   * handler must re-serialize `req.body` to reconstruct the bytes
   * that were signed. Previously this path tried to read the raw
   * stream (already consumed) and failed with 401, which surfaces
   * to Discord as "interactions endpoint url could not be verified".
   */
  describe('signature-verified handler', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyHex = extractRawEd25519PublicKey(publicKey);

    it('accepts a signed PING after re-serializing a @vercel/node-parsed body', async () => {
      process.env.DISCORD_APP_PUBLIC_KEY = publicKeyHex;

      // Discord sends compact JSON — mirror that with JSON.stringify
      // of a plain object. @vercel/node would then JSON.parse it and
      // hand us back the parsed object on req.body.
      const payload = { type: 1 };
      const serialized = JSON.stringify(payload);
      const parsedByVercel = JSON.parse(serialized);

      const timestamp = String(Math.floor(Date.now() / 1000));
      const message = Buffer.concat([Buffer.from(timestamp), Buffer.from(serialized)]);
      const signature = sign(null, message, privateKey).toString('hex');

      const req = mockRequest({
        method: 'POST',
        body: parsedByVercel,
        query: { action: 'interactions' },
        headers: {
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp,
        },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual({ type: 1 });
    });

    it('rejects when the signature doesn\'t match the canonicalized body', async () => {
      process.env.DISCORD_APP_PUBLIC_KEY = publicKeyHex;

      // Sign one body, deliver a different one — verification fails.
      const signedBody = JSON.stringify({ type: 1 });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const message = Buffer.concat([Buffer.from(timestamp), Buffer.from(signedBody)]);
      const signature = sign(null, message, privateKey).toString('hex');

      const req = mockRequest({
        method: 'POST',
        body: { type: 2 }, // different payload
        query: { action: 'interactions' },
        headers: {
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp,
        },
      });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(401);
    });
  });
});
