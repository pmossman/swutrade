#!/usr/bin/env node
/**
 * One-off registration of SWUTrade's Discord application commands
 * (slash + user context menu). Uses the PRODUCT bot (DISCORD_BOT_TOKEN
 * + DISCORD_CLIENT_ID) — NOT the admin-ops bot — because these
 * commands are user-facing and need to live on whichever app users
 * are installing (SWUTrade Bot / SWUTrade Bot Dev).
 *
 * Usage:
 *   # Register globally (takes up to 1 hour to propagate):
 *   node scripts/register-discord-commands.mjs global
 *
 *   # Register to a specific guild (instant; use during development):
 *   node scripts/register-discord-commands.mjs guild <guild_id>
 *
 *   # List currently-registered commands at the given scope:
 *   node scripts/register-discord-commands.mjs list global
 *   node scripts/register-discord-commands.mjs list guild <guild_id>
 *
 *   # Clear all commands at a scope (useful when renaming):
 *   node scripts/register-discord-commands.mjs clear guild <guild_id>
 *
 * `.env.local` must have:
 *   DISCORD_BOT_TOKEN       — product bot token
 *   DISCORD_CLIENT_ID       — product app client id
 *
 * PUT semantics: the call REPLACES the full command list at that
 * scope. Guild-scoped replacements leave global commands untouched
 * and vice-versa. Deleting a command removes its slot on the Discord
 * end; clients may cache for a few minutes.
 */

import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
if (!BOT_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID must be set in .env.local');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';
const headers = {
  Authorization: `Bot ${BOT_TOKEN}`,
  'Content-Type': 'application/json',
};

// Command definitions. Keep in sync with the dispatcher in
// api/bot.ts — the handler matches on `data.name` + `data.type`.
const COMMANDS = [
  {
    type: 1, // CHAT_INPUT (slash command)
    name: 'swutrade',
    description: 'SWUTrade commands',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'settings',
        description: 'Open your SWUTrade preferences',
        options: [
          {
            type: 6, // USER
            name: 'user',
            description: 'Optional — set per-trader preferences for this user',
            required: false,
          },
        ],
      },
    ],
  },
  {
    type: 2, // USER (context menu)
    name: 'SWUTrade prefs',
    // Context menu commands do NOT take a description field.
  },
];

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

function basePath(scope, guildId) {
  return scope === 'global'
    ? `/applications/${CLIENT_ID}/commands`
    : `/applications/${CLIENT_ID}/guilds/${guildId}/commands`;
}

const [, , verb, scope, guildId] = process.argv;

async function main() {
  switch (verb) {
    case 'global':
    case 'guild': {
      const actualScope = verb;
      const actualGuildId = verb === 'guild' ? scope : undefined;
      if (actualScope === 'guild' && !actualGuildId) {
        console.error('usage: register-discord-commands.mjs guild <guild_id>');
        process.exit(1);
      }
      const path = basePath(actualScope, actualGuildId);
      const result = await call('PUT', path, COMMANDS);
      console.log(JSON.stringify(
        result.map(c => ({ id: c.id, name: c.name, type: c.type })),
        null, 2,
      ));
      break;
    }
    case 'list': {
      if (scope !== 'global' && scope !== 'guild') {
        console.error('usage: list <global|guild> [guild_id]');
        process.exit(1);
      }
      if (scope === 'guild' && !guildId) {
        console.error('usage: list guild <guild_id>');
        process.exit(1);
      }
      const result = await call('GET', basePath(scope, guildId));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'clear': {
      if (scope !== 'global' && scope !== 'guild') {
        console.error('usage: clear <global|guild> [guild_id]');
        process.exit(1);
      }
      if (scope === 'guild' && !guildId) {
        console.error('usage: clear guild <guild_id>');
        process.exit(1);
      }
      await call('PUT', basePath(scope, guildId), []);
      console.log(JSON.stringify({ ok: true, cleared: scope }));
      break;
    }
    default:
      console.error('usage: register-discord-commands.mjs <global|guild> [guild_id]');
      console.error('       register-discord-commands.mjs list <global|guild> [guild_id]');
      console.error('       register-discord-commands.mjs clear <global|guild> [guild_id]');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
