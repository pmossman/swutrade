#!/usr/bin/env node
/**
 * Developer-ops wrappers around the Discord REST API using the
 * separate `swutrade-admin-ops` bot. DISTINCT from the product bot
 * (`SWUTrade Bot Dev` / `SWUTRADE`) — the admin bot carries broader
 * permissions (Administrator in its installed guilds) for dev-flow
 * tasks like creating the #releases webhook for CI notifications.
 *
 * Scope: ONLY installed in personal dev servers. Token lives in
 * .env.local under `DISCORD_ADMIN_BOT_TOKEN` and MUST NOT be pushed
 * to Vercel (this script runs locally only).
 *
 * Usage:
 *   node scripts/discord-admin.mjs list-guilds
 *   node scripts/discord-admin.mjs list-channels <guild_id>
 *   node scripts/discord-admin.mjs create-webhook <channel_id> <name>
 *   node scripts/discord-admin.mjs delete-channel <channel_id>
 *   node scripts/discord-admin.mjs describe-member <guild_id> <user_id>
 *
 * Each op prints a single JSON object/array to stdout. Errors exit
 * non-zero with a message on stderr — callable from shell pipelines.
 */

import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });

const TOKEN = process.env.DISCORD_ADMIN_BOT_TOKEN;
if (!TOKEN) {
  console.error('DISCORD_ADMIN_BOT_TOKEN not set in .env.local');
  process.exit(1);
}
const API = 'https://discord.com/api/v10';
const headers = {
  Authorization: `Bot ${TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent': 'swutrade-admin-ops/1 (discord-admin.mjs)',
};

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Discord ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'list-guilds': {
    const guilds = await call('GET', '/users/@me/guilds');
    console.log(JSON.stringify(
      guilds.map(g => ({ id: g.id, name: g.name, owner: g.owner })),
      null, 2,
    ));
    break;
  }

  case 'list-channels': {
    const [guildId] = args;
    if (!guildId) { console.error('usage: list-channels <guild_id>'); process.exit(1); }
    const channels = await call('GET', `/guilds/${guildId}/channels`);
    console.log(JSON.stringify(
      channels.map(c => ({ id: c.id, name: c.name, type: c.type, parent_id: c.parent_id })),
      null, 2,
    ));
    break;
  }

  case 'create-channel': {
    const [guildId, name, topic] = args;
    if (!guildId || !name) {
      console.error('usage: create-channel <guild_id> <name> [topic]');
      process.exit(1);
    }
    const channel = await call('POST', `/guilds/${guildId}/channels`, {
      name,
      type: 0, // GUILD_TEXT
      topic: topic ?? undefined,
    });
    console.log(JSON.stringify({ id: channel.id, name: channel.name, type: channel.type }, null, 2));
    break;
  }

  case 'create-webhook': {
    const [channelId, name] = args;
    if (!channelId || !name) {
      console.error('usage: create-webhook <channel_id> <name>');
      process.exit(1);
    }
    const hook = await call('POST', `/channels/${channelId}/webhooks`, { name });
    // URL = https://discord.com/api/webhooks/<id>/<token>. The token
    // portion is secret — print it clearly for stashing.
    console.log(JSON.stringify({
      id: hook.id,
      name: hook.name,
      url: `https://discord.com/api/webhooks/${hook.id}/${hook.token}`,
    }, null, 2));
    break;
  }

  case 'delete-channel': {
    const [channelId] = args;
    if (!channelId) { console.error('usage: delete-channel <channel_id>'); process.exit(1); }
    await call('DELETE', `/channels/${channelId}`);
    console.log(JSON.stringify({ ok: true, channel_id: channelId }, null, 2));
    break;
  }

  case 'describe-member': {
    const [guildId, userId] = args;
    if (!guildId || !userId) {
      console.error('usage: describe-member <guild_id> <user_id>');
      process.exit(1);
    }
    const member = await call('GET', `/guilds/${guildId}/members/${userId}`);
    console.log(JSON.stringify({
      user: { id: member.user?.id, username: member.user?.username },
      roles: member.roles,
      joined_at: member.joined_at,
      nick: member.nick,
    }, null, 2));
    break;
  }

  default:
    console.error(`unknown command: ${command ?? '(none)'}`);
    console.error('commands: list-guilds | list-channels | create-webhook | delete-channel | describe-member');
    process.exit(1);
}
