import { describeWithDb } from './helpers.js';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mockResponse } from './helpers.js';
import { dispatchBotPayload } from '../../api/bot.js';
import { getDb } from '../../lib/db.js';
import { botInstalledGuilds } from '../../lib/schema.js';

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
});
