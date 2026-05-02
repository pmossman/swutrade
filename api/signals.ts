/**
 * Signal API — web-side equivalent of the (now-removed) Discord
 * `/looking-for` and `/offering` slash commands.
 *
 * The web Signal Builder posts here. The API is the only entry
 * point for creating signals; the bot's job is just to render the
 * embed in Discord and own the per-post button interactions
 * (Cancel, Specify variant). All signal lifecycle state lives in
 * `card_signals`; the bot reaches into the same table from
 * `api/bot.ts`'s button + cron handlers.
 *
 * Routes (via vercel.json action rewrites):
 *   POST   /api/signals/create         → create + post (action=create)
 *   DELETE /api/signals/:groupId/cancel → cancel a group (action=cancel)
 *   GET    /api/signals/mine           → list viewer's active signals (action=mine)
 *
 * Note: Vercel's filesystem routing matches `/api/signals` directly to
 * this file BEFORE checking vercel.json rewrites, which means a bare
 * `/api/signals` URL hits the action dispatcher with no `?action=` and
 * 404s. Front-door URLs must be subpaths (e.g. `/create`, `/mine`)
 * so the rewrite layer fires.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import {
  cardSignals,
  wantsItems,
  availableItems,
  users,
  botInstalledGuilds,
  userGuildMemberships,
  type CardSignalKind,
} from '../lib/schema.js';
import { requireSession } from '../lib/auth.js';
import { restrictionKey } from '../lib/shared.js';
import {
  findMatches,
  lookupSignalFamily,
  resolveSignalCardsBatch,
  type VariantSpec,
} from '../lib/signalMatching.js';
import {
  buildSignalPost,
  formatExpiryHint,
} from '../lib/signalMessages.js';
import { createDiscordBotClient, type DiscordBotClient } from '../lib/discordBot.js';
import { ensureSwutradeCategory } from '../lib/tradeGuild.js';
import { reportError } from '../lib/errorReporter.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = (req.query.action as string | undefined) ?? '';
  switch (action) {
    case 'create': return handleCreate(req, res);
    case 'cancel': return handleCancel(req, res);
    case 'mine':   return handleListMine(req, res);
    default:
      return res.status(404).json({ error: 'Unknown /api/signals action' });
  }
}

// --- create ----------------------------------------------------------------

const CardInputSchema = z.object({
  familyId: z.string().min(1).max(200),
  /** null / omitted / empty array → "any printing"; 1+ variant
   *  labels → the user wants/offers exactly those printings. The
   *  embed renders multi-variant restrictions as "A / B only". */
  variants: z.array(z.string().min(1).max(60)).max(20).nullable().optional(),
  qty: z.number().int().min(1).max(99),
  // maxPrice removed 2026-05-01 — signals are conversation
  // starters; specific pricing is worked out fairly in the trade
  // thread, not pre-committed in the post. Zod's default strips
  // extra fields, so cached old clients that still send maxPrice
  // POST successfully — the field is silently dropped.
});

const CreateBodySchema = z.object({
  kind: z.enum(['wanted', 'offering']),
  cards: z.array(CardInputSchema).min(1).max(20),
  note: z.string().max(500).nullable().optional(),
  guildId: z.string().min(1).max(40),
});

// Server-side TTL for match-query hygiene. Not user-facing — viewers
// see signal posts as plain Discord messages with no lifecycle, so
// the value is hard-coded here rather than a request parameter.
const SIGNAL_TTL_DAYS = 90;

interface CreateDeps {
  /** Bot client for outbound Discord posts. Tests inject a fake. */
  bot?: DiscordBotClient;
}

export async function handleCreate(
  req: VercelRequest,
  res: VercelResponse,
  deps: CreateDeps = {},
) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = CreateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', detail: parsed.error.flatten() });
  }
  const body = parsed.data;

  const db = getDb();

  // Validate the user's enrollment + the bot's install in the
  // chosen guild. Both are required for the signal to be useful:
  // the user has to be a member who's opted into community
  // queries (so matches can find them too), and the bot has to be
  // installed (so the post can land).
  const [enrollment] = await db
    .select({
      enrolled: userGuildMemberships.enrolled,
      appearInQueries: userGuildMemberships.appearInQueries,
    })
    .from(userGuildMemberships)
    .where(and(
      eq(userGuildMemberships.userId, session.userId),
      eq(userGuildMemberships.guildId, body.guildId),
    ))
    .limit(1);
  if (!enrollment) {
    return res.status(403).json({ error: 'You\'re not a member of that server.' });
  }
  if (!enrollment.enrolled) {
    return res.status(403).json({ error: 'Join SWUTrade in this server first.' });
  }

  const [installRow] = await db
    .select({
      tradesChannelId: botInstalledGuilds.tradesChannelId,
      signalsChannelId: botInstalledGuilds.signalsChannelId,
      postsChannelId: botInstalledGuilds.postsChannelId,
      guildName: botInstalledGuilds.guildName,
    })
    .from(botInstalledGuilds)
    .where(eq(botInstalledGuilds.guildId, body.guildId))
    .limit(1);
  if (!installRow) {
    return res.status(403).json({ error: 'SWUTrade isn\'t set up in that server yet.' });
  }
  // Channel resolution priority:
  //   1. signals_channel_id   → server admin's manual override
  //   2. posts_channel_id     → auto-created `#swutrade-posts`
  //   3. trades_channel_id    → legacy installs predating the
  //                             SWUTrade-category model
  // When all three are null, run the category-ensure flow inline —
  // this covers (a) installs predating any auto-create, (b) installs
  // whose auto-create silently failed, (c) admins who deleted the
  // posts channel manually.
  let channelId = installRow.signalsChannelId
    ?? installRow.postsChannelId
    ?? installRow.tradesChannelId;
  if (!channelId) {
    try {
      const bot = deps.bot ?? createDiscordBotClient();
      const ids = await ensureSwutradeCategory(db, body.guildId, bot);
      channelId = ids.postsChannelId;
    } catch (err) {
      console.error('handleCreate: ensureSwutradeCategory failed', err);
      await reportError({
        source: 'signals.create.ensure-channel',
        tags: { guildId: body.guildId, kind: body.kind },
      }, err);
      return res.status(409).json({
        error: 'SWUTrade couldn\'t create a posts channel in this server. The bot may need the Manage Channels permission — re-invite it from SWUTrade home and try again.',
      });
    }
  }

  const [signaler] = await db
    .select({ id: users.id, handle: users.handle, avatarUrl: users.avatarUrl, discordId: users.discordId })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!signaler) {
    return res.status(500).json({ error: 'Signaler row not found' });
  }

  // Resolve every card payload up front. Any invalid family →
  // 400, no DB writes. Cleaner than partial inserts on failure.
  type ResolvedCard = {
    family: NonNullable<ReturnType<typeof lookupSignalFamily>>;
    variantSpec: VariantSpec;
    representativeProductId: string;
    qty: number;
  };
  const resolved: ResolvedCard[] = [];
  for (const c of body.cards) {
    const family = lookupSignalFamily(c.familyId);
    if (!family) {
      return res.status(400).json({ error: `Unknown card family: ${c.familyId}` });
    }
    // Filter the requested variants to those that actually exist in
    // the family — defends against stale frontend data (post-set-rotation
    // a printing might be missing) without rejecting the whole post.
    // After filtering: 0 valid → 'any', 1+ → 'restricted' with the
    // surviving variants.
    const requestedVariants = (c.variants ?? []).filter(rv =>
      family.variants.some(v => v.variant === rv),
    );
    const variantSpec: VariantSpec = requestedVariants.length > 0
      ? { mode: 'restricted', variants: requestedVariants }
      : { mode: 'any' };
    const representativeProductId = variantSpec.mode === 'restricted'
      ? family.variants.find(v => v.variant === variantSpec.variants[0])!.productId
      : family.variants[0].productId;
    resolved.push({
      family,
      variantSpec,
      representativeProductId,
      qty: c.qty,
    });
  }

  // All-or-nothing inserts. Build the wants/available rows + the
  // signal rows + post to Discord. If the Discord post fails,
  // mark the signals as cancelled so they don't dangle in the
  // active set with no public surface.
  const groupId = randomUUID();
  const expiresAt = new Date(Date.now() + SIGNAL_TTL_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();

  type DraftCard = ResolvedCard & { signalId: string };
  const drafts: DraftCard[] = [];

  for (const rc of resolved) {
    let inventoryRowId: string;
    if (body.kind === 'wanted') {
      const wantsId = `w-${randomUUID().slice(0, 12)}`;
      const restriction = rc.variantSpec.mode === 'any'
        ? { mode: 'any' as const }
        : { mode: 'restricted' as const, variants: rc.variantSpec.variants };
      await db.insert(wantsItems).values({
        id: wantsId,
        userId: signaler.id,
        familyId: rc.family.familyId,
        qty: rc.qty,
        restrictionMode: restriction.mode,
        restrictionVariants: restriction.mode === 'restricted' ? restriction.variants : null,
        restrictionKey: restrictionKey(restriction),
        // wantsItems.maxUnitPrice (the user's standing personal
        // ceiling) is unrelated to the removed signal-side max-$
        // — but signals never set it; that's a wishlist-UI-only
        // concern. Leave null on signal-driven inserts.
        maxUnitPrice: null,
        isPriority: true,
        addedAt: now.getTime(),
      }).onConflictDoUpdate({
        target: [wantsItems.userId, wantsItems.familyId, wantsItems.restrictionKey],
        set: {
          qty: sql`GREATEST(${wantsItems.qty}, ${rc.qty})`,
          isPriority: true,
          updatedAt: now,
        },
      });
      const [row] = await db
        .select({ id: wantsItems.id })
        .from(wantsItems)
        .where(and(
          eq(wantsItems.userId, signaler.id),
          eq(wantsItems.familyId, rc.family.familyId),
          eq(wantsItems.restrictionKey, restrictionKey(restriction)),
        ))
        .limit(1);
      inventoryRowId = row.id;
    } else {
      const availId = `a-${randomUUID().slice(0, 12)}`;
      await db.insert(availableItems).values({
        id: availId,
        userId: signaler.id,
        productId: rc.representativeProductId,
        qty: rc.qty,
        addedAt: now.getTime(),
      }).onConflictDoUpdate({
        target: [availableItems.userId, availableItems.productId],
        set: {
          qty: sql`GREATEST(${availableItems.qty}, ${rc.qty})`,
          updatedAt: now,
        },
      });
      const [row] = await db
        .select({ id: availableItems.id })
        .from(availableItems)
        .where(and(
          eq(availableItems.userId, signaler.id),
          eq(availableItems.productId, rc.representativeProductId),
        ))
        .limit(1);
      inventoryRowId = row.id;
    }

    const signalId = randomUUID();
    await db.insert(cardSignals).values({
      id: signalId,
      userId: signaler.id,
      kind: body.kind,
      groupId,
      wantsItemId: body.kind === 'wanted' ? inventoryRowId : null,
      availableItemId: body.kind === 'offering' ? inventoryRowId : null,
      guildId: body.guildId,
      channelId,
      expiresAt,
      signalNote: body.note ?? null,
      // maxUnitPrice removed from the signal API 2026-05-01.
      // Column kept on card_signals for backwards-compat with
      // already-posted rows; new writes always null.
      maxUnitPrice: null,
      status: 'active',
    });
    drafts.push({ ...rc, signalId });
  }

  // Build the embed. Match listings come from a fresh findMatches
  // call per card.
  const cardsForEmbed = await Promise.all(drafts.map(async (d) => {
    const matches = await findMatches(db, {
      kind: body.kind,
      family: d.family,
      variant: d.variantSpec,
      guildId: body.guildId,
      requesterUserId: signaler.id,
      eventId: null,
    });
    return {
      signalId: d.signalId,
      name: d.family.name,
      setCode: d.family.setCode,
      cardType: d.family.cardType,
      productId: d.representativeProductId,
      variantSpec: d.variantSpec,
      qty: d.qty,
      matchedUsers: matches.map(m => ({ discordId: m.discordId, handle: m.handle })),
    };
  }));

  // Absolute URL for the OG composite image referenced by the embed.
  // Discord caches embed images by URL, so we include the groupId in
  // the path; status changes (cancel / expire) just drop the embed's
  // image field rather than re-rendering this URL.
  const origin = req.headers.host
    ? `https://${req.headers.host}`
    : process.env.SWUTRADE_PUBLIC_URL ?? 'https://swutrade.com';
  const imageUrl = `${origin}/api/og?signal=${encodeURIComponent(groupId)}`;

  const embedBody = buildSignalPost({
    groupId,
    kind: body.kind,
    status: 'active',
    cards: cardsForEmbed,
    note: body.note ?? null,
    requester: { discordId: signaler.discordId, handle: signaler.handle, avatarUrl: signaler.avatarUrl },
    expiryHint: formatExpiryHint(expiresAt, now),
    imageUrl,
    origin,
  });

  // Post the public embed.
  const bot = deps.bot ?? createDiscordBotClient();
  let postedMessageId: string;
  try {
    const posted = await bot.postChannelMessage(channelId, embedBody);
    postedMessageId = posted.id;
  } catch (err) {
    // Roll back to a cancelled state so we don't leave dangling
    // active signals with no message_id. Soft cancel — the rows
    // stay for audit.
    await db.update(cardSignals)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(cardSignals.groupId, groupId));
    console.error('handleCreate: postChannelMessage failed', err);
    await reportError({
      source: 'signals.create.post',
      tags: { groupId, channelId, kind: body.kind },
    }, err);
    return res.status(502).json({
      error: 'Couldn\'t post in the channel — SWUTrade might not have permission to send messages there.',
    });
  }

  // Stamp the message id on every row.
  await db.update(cardSignals)
    .set({ messageId: postedMessageId })
    .where(eq(cardSignals.groupId, groupId));

  return res.status(201).json({
    groupId,
    messageId: postedMessageId,
    channelId,
    guildId: body.guildId,
    messageUrl: `https://discord.com/channels/${body.guildId}/${channelId}/${postedMessageId}`,
    matchSummary: cardsForEmbed.map(c => ({
      familyId: drafts.find(d => d.signalId === c.signalId)!.family.familyId,
      matchCount: c.matchedUsers.length,
    })),
  });
}

// --- cancel ----------------------------------------------------------------

interface CancelDeps {
  bot?: DiscordBotClient;
}

export async function handleCancel(
  req: VercelRequest,
  res: VercelResponse,
  deps: CancelDeps = {},
) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    res.setHeader('Allow', 'DELETE, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const groupId = (req.query.groupId as string | undefined) ?? '';
  if (!groupId) {
    return res.status(400).json({ error: 'Missing groupId' });
  }

  const db = getDb();
  const groupRows = await db
    .select()
    .from(cardSignals)
    .where(eq(cardSignals.groupId, groupId));
  if (groupRows.length === 0) {
    return res.status(404).json({ error: 'Post not found.' });
  }
  if (groupRows[0].userId !== session.userId) {
    return res.status(403).json({ error: 'Only the post\'s author can cancel it' });
  }
  if (groupRows.every(r => r.status !== 'active')) {
    return res.status(409).json({ error: `Signal is already ${groupRows[0].status}` });
  }

  // Flip every row in the group to cancelled.
  await db.update(cardSignals)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(cardSignals.groupId, groupId));

  // Best-effort embed PATCH so the channel reflects the new state.
  // Failure here doesn't fail the API call — the database is
  // authoritative; the embed lag self-corrects on the next user
  // interaction or the cron sweep.
  const firstRow = groupRows[0];
  if (firstRow.messageId) {
    try {
      const bot = deps.bot ?? createDiscordBotClient();
      const resolved = await resolveSignalCardsBatch(db, groupRows);
      const cards = groupRows.map((row) => {
        if (!row.wantsItemId && !row.availableItemId) return null;
        const r = resolved.get(row.id);
        if (!r) return null;
        const { family, variantSpec } = r;
        const representative = variantSpec.mode === 'restricted'
          ? family.variants.find(v => v.variant === variantSpec.variants[0]) ?? family.variants[0]
          : family.variants[0];
        return {
          signalId: row.id,
          name: family.name,
          setCode: family.setCode,
          cardType: family.cardType,
          productId: representative.productId,
          variantSpec,
          qty: 1,
          matchedUsers: [],
        };
      });
      const [signaler] = await db
        .select({ handle: users.handle, avatarUrl: users.avatarUrl, discordId: users.discordId })
        .from(users)
        .where(eq(users.id, firstRow.userId))
        .limit(1);
      const cancelledEmbed = buildSignalPost({
        groupId,
        kind: firstRow.kind,
        status: 'cancelled',
        cards: cards.filter(c => c !== null) as Array<NonNullable<typeof cards[number]>>,
        note: firstRow.signalNote,
        requester: {
          discordId: signaler?.discordId ?? null,
          handle: signaler?.handle ?? '?',
          avatarUrl: signaler?.avatarUrl ?? null,
        },
        expiryHint: '',
      });
      await bot.editChannelMessage(firstRow.channelId, firstRow.messageId, cancelledEmbed);
    } catch (err) {
      console.error('handleCancel: editChannelMessage failed', err);
      // Don't fail the request — DB is authoritative.
    }
  }

  return res.status(200).json({ ok: true, groupId });
}

// --- list mine -------------------------------------------------------------

export async function handleListMine(req: VercelRequest, res: VercelResponse) {
  const session = await requireSession(req, res);
  if (!session) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(cardSignals)
    .where(and(
      eq(cardSignals.userId, session.userId),
      eq(cardSignals.status, 'active'),
    ));

  // Group by groupId so the client gets one row per signal post.
  const byGroup = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.groupId ?? row.id;
    const list = byGroup.get(key) ?? [];
    list.push(row);
    byGroup.set(key, list);
  }

  // Batch-resolve every row's family + variantSpec in two SELECTs
  // total, then iterate groups synchronously. Audit 07-performance #2.
  const resolved = await resolveSignalCardsBatch(db, rows);
  const groups = Array.from(byGroup.entries()).map(([groupId, groupRows]) => {
    const cards = groupRows.map((row) => {
      const r = resolved.get(row.id);
      if (!r) return null;
      const { family, variantSpec } = r;
      return {
        signalId: row.id,
        familyId: family.familyId,
        name: family.name,
        setCode: family.setCode,
        cardType: family.cardType,
        variantSpec,
      };
    });
    const firstRow = groupRows[0];
    return {
      groupId,
      kind: firstRow.kind,
      guildId: firstRow.guildId,
      channelId: firstRow.channelId,
      messageId: firstRow.messageId,
      messageUrl: firstRow.messageId
        ? `https://discord.com/channels/${firstRow.guildId}/${firstRow.channelId}/${firstRow.messageId}`
        : null,
      expiresAt: firstRow.expiresAt,
      note: firstRow.signalNote,
      cards: cards.filter(c => c !== null),
    };
  });

  return res.status(200).json({ groups });
}

// Avoid unused-import lint on CardSignalKind — exported via the
// schema barrel and consumed by callers of the API responses.
export type { CardSignalKind };
