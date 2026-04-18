#!/usr/bin/env node
/**
 * Seeds fake Discord users into the community directory for preview /
 * local testing. Real test with no humans: gives you rows to look at,
 * profiles to visit, and proposals to send Accept/Counter/Decline on.
 *
 * Every fake uses a `dev-seed-` id prefix and a tiny inline SVG robot
 * avatar, so cleanup is a one-WHERE-clause operation.
 *
 * The fakes' wants + available are mirrored against the viewer's own
 * lists so the overlap chips display non-trivial numbers — each fake
 * gets a different slice so sort tabs are interesting.
 *
 * Usage:
 *   node scripts/dev-seed-community.mjs seed \
 *     --viewer pmoss --guild 1494557809814142976 [--count 3]
 *   node scripts/dev-seed-community.mjs cleanup
 *
 * Reads POSTGRES_URL_NON_POOLING from .env.local — pull the right
 * environment first if seeding against beta:
 *   vercel env pull --environment=preview --git-branch=beta
 */

import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { parseArgs } from 'node:util';
import { neon } from '@neondatabase/serverless';

config({ path: '.env.local' });

const PREFIX = 'dev-seed-';
const GUILD_NAME = 'SWUTrade Dev Test';

// A handful of droids — varied handles so sort-alpha has something to
// do, varied usernames so screen readers don't all announce the same thing.
const FAKE_USERS = [
  { handle: 'testbot-r2', username: 'R2 Test Unit' },
  { handle: 'testbot-bb', username: 'BB Test Unit' },
  { handle: 'testbot-c3', username: 'C-3 Test Unit' },
  { handle: 'testbot-bd', username: 'BD Test Unit' },
  { handle: 'testbot-chop', username: 'Chopper Test Unit' },
];

// Tiny inline SVG — dark space-tinted circle with a gold robot head,
// little antenna, space-600 ears. Rendered as data: URI so no external
// asset fetch. Palette colors are percent-encoded (%23 = #) so the
// data URI parses.
const ROBOT_AVATAR =
  'data:image/svg+xml;utf8,' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
  '<rect width="40" height="40" rx="20" fill="%23242a3d"/>' +
  '<rect x="11" y="12" width="18" height="14" rx="3" fill="%23F5A623"/>' +
  '<rect x="14" y="16" width="3" height="3" rx="1" fill="%230a0e1a"/>' +
  '<rect x="23" y="16" width="3" height="3" rx="1" fill="%230a0e1a"/>' +
  '<rect x="15" y="22" width="10" height="1.5" rx="0.75" fill="%230a0e1a"/>' +
  '<rect x="19.5" y="7" width="1" height="4" fill="%23F5A623"/>' +
  '<circle cx="20" cy="6" r="1.5" fill="%23FFD700"/>' +
  '<rect x="7" y="17" width="3" height="5" rx="1" fill="%231a1f2e"/>' +
  '<rect x="30" y="17" width="3" height="5" rx="1" fill="%231a1f2e"/>' +
  '</svg>';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      viewer: { type: 'string' },
      guild: { type: 'string' },
      count: { type: 'string' },
      strategy: { type: 'string' }, // 'mirror' (default) | 'law-hyperspace'
      yes: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];
  const strategy = values.strategy ?? 'mirror';

  // Validate command + required args before touching DB / prompting.
  if (cmd !== 'seed' && cmd !== 'cleanup') {
    console.error('Usage:');
    console.error('  node scripts/dev-seed-community.mjs seed --viewer <handle> --guild <id>');
    console.error('                                          [--count N] [--strategy mirror|law-hyperspace] [--yes]');
    console.error('  node scripts/dev-seed-community.mjs cleanup [--yes]');
    process.exit(1);
  }
  if (cmd === 'seed' && (!values.viewer || !values.guild)) {
    console.error('seed requires --viewer <handle> and --guild <id>');
    process.exit(1);
  }
  if (cmd === 'seed' && strategy !== 'mirror' && strategy !== 'law-hyperspace') {
    console.error(`unknown --strategy "${strategy}" (expected: mirror, law-hyperspace)`);
    process.exit(1);
  }

  const url = process.env.POSTGRES_URL_NON_POOLING;
  if (!url) {
    console.error('POSTGRES_URL_NON_POOLING not set — did you pull env? Aborting.');
    process.exit(1);
  }

  const host = new URL(url).host;
  console.log(`Target DB host: ${host}`);
  if (!values.yes) {
    const rl = createInterface({ input, output });
    const answer = await rl.question('Proceed against this DB? [y/N] ');
    rl.close();
    if (!answer.trim().toLowerCase().startsWith('y')) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const sql = neon(url);

  if (cmd === 'cleanup') return cleanup(sql);
  return seed(sql, {
    viewerHandle: values.viewer,
    guildId: values.guild,
    count: Math.max(1, Math.min(FAKE_USERS.length, parseInt(values.count ?? '3', 10))),
    strategy,
  });
}

const LAW_SET_SLUG = 'a-lawless-time';
const LAW_VARIANTS = new Set(['Hyperspace', 'Hyperspace Foil', 'Showcase']);

async function seed(sql, { viewerHandle, guildId, count, strategy }) {
  const [viewer] = await sql`
    SELECT id, handle FROM users WHERE handle = ${viewerHandle} LIMIT 1
  `;
  if (!viewer) {
    console.error(`No user found with handle @${viewerHandle}`);
    process.exit(1);
  }

  // Build product → family lookup from the same static data the client uses.
  const familyIndex = JSON.parse(
    readFileSync(new URL('../public/data/family-index.json', import.meta.url), 'utf8'),
  );
  const familyByProduct = new Map();
  const productsByFamily = new Map();
  for (const [familyId, entries] of Object.entries(familyIndex)) {
    productsByFamily.set(familyId, entries.map(e => e.p));
    for (const e of entries) familyByProduct.set(e.p, familyId);
  }

  const plans = strategy === 'law-hyperspace'
    ? planLawHyperspace(familyIndex, count)
    : await planMirror(sql, viewer, familyByProduct, productsByFamily, count);

  const fakes = FAKE_USERS.slice(0, count);
  for (const [i, u] of fakes.entries()) {
    const userId = `${PREFIX}${u.handle}`;
    const discordId = `${PREFIX}discord-${u.handle}`;
    const membershipId = `${PREFIX}mem-${u.handle}`;

    await sql`
      INSERT INTO users (id, discord_id, username, handle, avatar_url, profile_visibility, wants_public, available_public)
      VALUES (${userId}, ${discordId}, ${u.username}, ${u.handle}, ${ROBOT_AVATAR}, 'public', true, true)
      ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url, profile_visibility = 'public'
    `;

    await sql`
      INSERT INTO user_guild_memberships (id, user_id, guild_id, guild_name, enrolled, appear_in_queries, include_in_rollups, can_manage)
      VALUES (${membershipId}, ${userId}, ${guildId}, ${GUILD_NAME}, true, true, true, false)
      ON CONFLICT ON CONSTRAINT user_guild_unique DO UPDATE SET enrolled = true, appear_in_queries = true
    `;

    await sql`DELETE FROM wants_items WHERE user_id = ${userId}`;
    await sql`DELETE FROM available_items WHERE user_id = ${userId}`;

    const { wants: wantsSlice, available: availSlice } = plans[i];

    for (const [j, familyId] of wantsSlice.entries()) {
      // Star roughly every 3rd want as priority so the ★ Priorities
      // suggest mode has something meaningful to work with — matches
      // how real users would sparsely star items, not the whole list.
      const isPriority = j % 3 === 0;
      await sql`
        INSERT INTO wants_items (id, user_id, family_id, qty, restriction_mode, restriction_key, is_priority, added_at)
        VALUES (${`${PREFIX}w-${u.handle}-${j}`}, ${userId}, ${familyId}, ${1 + (j % 3)}, 'any', 'any', ${isPriority}, ${Date.now()})
      `;
    }

    for (const [j, productId] of availSlice.entries()) {
      await sql`
        INSERT INTO available_items (id, user_id, product_id, qty, added_at)
        VALUES (${`${PREFIX}a-${u.handle}-${j}`}, ${userId}, ${productId}, ${1 + (j % 2)}, ${Date.now()})
      `;
    }

    console.log(`  seeded @${u.handle}: ${wantsSlice.length} wants, ${availSlice.length} available`);
  }

  console.log('\nDone. Reload /?community=1 and the fakes should appear.');
}

/**
 * Mirror strategy: fakes' inventory is a function of the viewer's,
 * so overlap chips display non-trivial numbers out of the box.
 * Each fake gets a disjoint slice so sort tabs rank them differently.
 */
async function planMirror(sql, viewer, familyByProduct, productsByFamily, count) {
  const viewerWants = await sql`
    SELECT family_id FROM wants_items WHERE user_id = ${viewer.id}
  `;
  const viewerAvailable = await sql`
    SELECT product_id FROM available_items WHERE user_id = ${viewer.id}
  `;

  const viewerAvailableFamilies = [...new Set(
    viewerAvailable.map(r => familyByProduct.get(r.product_id)).filter(Boolean),
  )];

  const productsForViewerWants = [];
  for (const w of viewerWants) {
    const pids = productsByFamily.get(w.family_id);
    if (pids?.length) productsForViewerWants.push(pids[0]);
  }

  console.log(
    `Viewer @${viewer.handle}: ${viewerWants.length} wants, ${viewerAvailable.length} available. ` +
    `Mirrorable — ${viewerAvailableFamilies.length} want-families, ${productsForViewerWants.length} offer-products.`,
  );
  if (viewerAvailableFamilies.length === 0 && productsForViewerWants.length === 0) {
    console.log('  (viewer has empty lists — fakes will still seed but overlap chips will all be 0)');
    console.log('  tip: try --strategy law-hyperspace for a content-rich alternative.');
  }

  const plans = [];
  for (let i = 0; i < count; i++) {
    const stride = i + 1;
    plans.push({
      wants: viewerAvailableFamilies.filter((_, k) => k % stride === i % stride).slice(0, 6),
      available: productsForViewerWants.filter((_, k) => k % stride === i % stride).slice(0, 6),
    });
  }
  return plans;
}

/**
 * LAW-hyperspace strategy: each fake gets a realistic chunk of the
 * latest set's Hyperspace / Hyperspace Foil / Showcase printings —
 * populous enough that the viewer can add any LAW card and see real
 * overlap without having to seed a mirror base first.
 *
 * Wants: rotating slice of LAW family_ids (mode 'any' — they're open
 *   to any printing).
 * Available: specific LAW SKUs in the three targeted variants, again
 *   sliced rotating so fakes don't all own the same products.
 */
function planLawHyperspace(familyIndex, count) {
  const lawFamilies = Object.keys(familyIndex).filter(k => k.startsWith(`${LAW_SET_SLUG}::`));
  const lawProducts = [];
  for (const fid of lawFamilies) {
    for (const entry of familyIndex[fid]) {
      if (LAW_VARIANTS.has(entry.v)) lawProducts.push(entry.p);
    }
  }
  console.log(
    `LAW inventory pool: ${lawFamilies.length} families, ${lawProducts.length} Hyperspace/HS-Foil/Showcase SKUs.`,
  );

  const plans = [];
  const wantsPerFake = 15;
  const availPerFake = 12;
  for (let i = 0; i < count; i++) {
    // Rotating offset so each fake's wants + available come from a
    // different region of the pool — makes sort tabs distinguishable.
    const wOff = (i * wantsPerFake) % Math.max(1, lawFamilies.length);
    const aOff = (i * availPerFake) % Math.max(1, lawProducts.length);
    plans.push({
      wants: rotate(lawFamilies, wOff).slice(0, wantsPerFake),
      available: rotate(lawProducts, aOff).slice(0, availPerFake),
    });
  }
  return plans;
}

function rotate(arr, n) {
  if (arr.length === 0) return arr;
  const off = n % arr.length;
  return arr.slice(off).concat(arr.slice(0, off));
}

async function cleanup(sql) {
  // Count first so we can report how many we deleted — the neon
  // driver's return shape for DELETE isn't documented as stable.
  const before = await sql`SELECT id FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  if (before.length === 0) {
    console.log('No dev-seed users present.');
    return;
  }
  // wants_items, available_items, user_guild_memberships all cascade
  // on user delete, so one DELETE is enough.
  await sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  console.log(`Deleted ${before.length} dev-seed users (cascades to wants/available/memberships).`);
}

await main();
