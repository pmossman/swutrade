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
 *   # Target a specific app (otherwise reads from .env.local):
 *   node scripts/register-discord-commands.mjs --app=prod global
 *   node scripts/register-discord-commands.mjs --app=beta guild <guild_id>
 *
 *   # List currently-registered commands at the given scope:
 *   node scripts/register-discord-commands.mjs list global
 *   node scripts/register-discord-commands.mjs list guild <guild_id>
 *
 *   # Clear all commands at a scope (useful when renaming):
 *   node scripts/register-discord-commands.mjs clear guild <guild_id>
 *
 * Credential resolution:
 *   --app=prod  → vercel env pull --environment=production
 *   --app=beta  → vercel env pull --environment=preview --git-branch=beta
 *   (default)   → .env.local
 *
 * The --app flag pulls a fresh, scoped credentials file via the
 * Vercel CLI so the deployed app's bot token + client id are used —
 * avoids the foot-gun of swapping .env.local between runs and
 * accidentally registering the prod bot's commands against the
 * beta app or vice-versa. Requires `vercel` on PATH and a logged-in
 * Vercel session.
 *
 * `.env.local` (or the pulled file) must have:
 *   DISCORD_BOT_TOKEN       — product bot token
 *   DISCORD_CLIENT_ID       — product app client id
 *
 * PUT semantics: the call REPLACES the full command list at that
 * scope. Guild-scoped replacements leave global commands untouched
 * and vice-versa. Deleting a command removes its slot on the Discord
 * end; clients may cache for a few minutes.
 */

import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pull --app=<X> out of argv before positional parsing; everything
// else flows through to the verb/scope/guildId pattern unchanged.
let appFlag = null;
const positionalArgs = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--app=(prod|beta)$/.exec(arg);
  if (m) {
    if (appFlag) {
      console.error('multiple --app flags supplied');
      process.exit(1);
    }
    appFlag = m[1];
  } else {
    positionalArgs.push(arg);
  }
}

let credCleanup = null;
if (appFlag) {
  // Pull into a per-run tempdir so concurrent invocations can't race
  // on the same path, and so we never leave plain-text creds on disk
  // after the script exits.
  const dir = mkdtempSync(join(tmpdir(), `swu-discord-${appFlag}-`));
  const path = join(dir, '.env');
  const args = appFlag === 'prod'
    ? ['env', 'pull', '--environment=production', path, '--yes']
    : ['env', 'pull', '--environment=preview', '--git-branch=beta', path, '--yes'];
  try {
    execFileSync('vercel', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    console.error(`vercel env pull failed for --app=${appFlag}:`, err.message);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  config({ path, quiet: true });
  credCleanup = () => rmSync(dir, { recursive: true, force: true });
} else {
  config({ path: '.env.local', quiet: true });
}

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
if (!BOT_TOKEN || !CLIENT_ID) {
  console.error(
    appFlag
      ? `DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID missing from --app=${appFlag} pulled env`
      : 'DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID must be set in .env.local',
  );
  if (credCleanup) credCleanup();
  process.exit(1);
}

const API = 'https://discord.com/api/v10';
const headers = {
  Authorization: `Bot ${BOT_TOKEN}`,
  'Content-Type': 'application/json',
};

// Command definitions. Keep in sync with the dispatcher in
// api/bot.ts — the handler matches on `data.name` + `data.type`.
//
// Shared option set for /looking-for and /offering. The two
// commands are symmetric — same shape, just inverse semantics —
// so the option list lives in one place to keep them in lockstep.
// Multi-card support: card2..card5 are optional and autocomplete
// the same way card does. Each becomes its own card_signals row
// in the resulting group; the public post lists them as bullets.
// 5 max per slash invocation — Discord allows 25 options total per
// command, but the slash UI gets unwieldy past 5 cards. "Add
// another card" button on the post will lift this limit later.
const SIGNAL_OPTIONS = [
  {
    type: 3, // STRING
    name: 'card',
    description: 'Card name (autocompletes from the SWUTrade index)',
    required: true,
    autocomplete: true,
  },
  {
    type: 3, // STRING
    name: 'variant',
    description: 'Restrict to a specific printing (autocompletes from the chosen card)',
    required: false,
    autocomplete: true,
  },
  {
    type: 3, // STRING
    name: 'card2',
    description: 'Add a second card to this signal (optional)',
    required: false,
    autocomplete: true,
  },
  {
    type: 3, // STRING
    name: 'card3',
    description: 'Add a third card (optional)',
    required: false,
    autocomplete: true,
  },
  {
    type: 3, // STRING
    name: 'card4',
    description: 'Add a fourth card (optional)',
    required: false,
    autocomplete: true,
  },
  {
    type: 3, // STRING
    name: 'card5',
    description: 'Add a fifth card (optional)',
    required: false,
    autocomplete: true,
  },
  {
    type: 4, // INTEGER
    name: 'qty',
    description: 'How many copies of each card (default 1; applies to all cards in this signal)',
    required: false,
    min_value: 1,
    max_value: 99,
  },
  {
    type: 10, // NUMBER (float)
    name: 'max_price',
    description: 'Max unit price you\'d pay / asking price ($)',
    required: false,
    min_value: 0,
  },
  {
    type: 3, // STRING
    name: 'note',
    description: 'Optional context (e.g. "for Friday\'s draft")',
    required: false,
    max_length: 100,
  },
  {
    type: 3, // STRING
    name: 'event',
    description: 'Forward-compat — pickup at a specific LGS event (currently unused)',
    required: false,
    autocomplete: true,
  },
];

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
  {
    type: 1, // CHAT_INPUT
    name: 'looking-for',
    description: 'Post that you\'re looking for a card — pings users in this server who have it listed',
    options: SIGNAL_OPTIONS,
  },
  {
    type: 1, // CHAT_INPUT
    name: 'offering',
    description: 'Post that you have a card to offload — pings users in this server who want it',
    options: SIGNAL_OPTIONS,
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

const [verb, scope, guildId] = positionalArgs;

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

main()
  .then(() => {
    if (credCleanup) credCleanup();
  })
  .catch(err => {
    console.error(err.message);
    if (credCleanup) credCleanup();
    process.exit(1);
  });
