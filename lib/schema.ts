import {
  pgTable,
  text,
  integer,
  boolean,
  bigint,
  numeric,
  timestamp,
  unique,
  index,
  jsonb,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  discordId: text('discord_id').unique().notNull(),
  username: text('username').notNull(),
  handle: text('handle').unique().notNull(),
  avatarUrl: text('avatar_url'),
  wantsPublic: boolean('wants_public').default(true).notNull(),
  availablePublic: boolean('available_public').default(false).notNull(),
  // Phase 4 — account-level settings. Three-axis consent model:
  //   profileVisibility gates all profile discoverability
  //   dm* toggles gate bot-pushed notifications (default off except
  //     trade proposals, which are direct transactional mail)
  // Per-guild toggles live in user_guild_memberships.
  profileVisibility: text('profile_visibility', { enum: ['public', 'discord', 'private'] })
    .default('discord')
    .notNull(),
  dmTradeProposals: boolean('dm_trade_proposals').default(true).notNull(),
  dmMatchAlerts: boolean('dm_match_alerts').default(false).notNull(),
  dmMeetupReminders: boolean('dm_meetup_reminders').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Registry of every Discord guild that SWUTrade's bot has been
 * installed into. Written when Discord fires `GUILD_CREATE` at the
 * bot on install (and when someone runs the install OAuth flow);
 * deleted on `GUILD_DELETE` / bot kick.
 *
 * Used to filter the enrollment UI: a user is only offered community
 * features for guilds in `user_guild_memberships ∩ bot_installed_guilds`.
 * Prevents the enrollment screen from enumerating every server the user
 * has ever joined and keeps "enrollable" synonymous with "has the bot
 * actually installed, so the features will work here."
 *
 * Bot not built yet — table stays empty for now, reserved so the
 * schema + query layer don't need reworking when it ships.
 */
export const botInstalledGuilds = pgTable('bot_installed_guilds', {
  guildId: text('guild_id').primaryKey(),
  guildName: text('guild_name').notNull(),
  guildIcon: text('guild_icon'),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  // Discord user id of whoever ran the install flow. Informational —
  // not used for authorization decisions.
  installedByUserId: text('installed_by_user_id'),
});

/**
 * Record of which Discord guilds a user belongs to + their Phase-4
 * consent state for each. Enrollment is affirmative — signing in
 * populates rows here (via the Discord `guilds` OAuth scope) but
 * `enrolled=false` by default. A user has to explicitly opt into
 * each server's trading community via the settings UI.
 *
 * Refreshed on each sign-in so membership reflects Discord reality
 * (leaving a server removes the row; joining one adds it).
 */
export const userGuildMemberships = pgTable(
  'user_guild_memberships',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    guildId: text('guild_id').notNull(),
    // Cached guild metadata — Discord's guild list endpoint returns
    // these alongside the id so we might as well store them for the
    // enrollment UI without a second fetch per render.
    guildName: text('guild_name').notNull(),
    guildIcon: text('guild_icon'),
    // True if the viewer has Discord `MANAGE_GUILD` in this server.
    // Gate for the `/guilds/<id>/admin` LGS-directory page (v2).
    canManage: boolean('can_manage').default(false).notNull(),
    // Per-guild consent flags. Only meaningful when enrolled=true.
    enrolled: boolean('enrolled').default(false).notNull(),
    includeInRollups: boolean('include_in_rollups').default(false).notNull(),
    appearInQueries: boolean('appear_in_queries').default(false).notNull(),
    // v2 — channel for outbound "visit announcement" broadcasts.
    announceVisitsChannelId: text('announce_visits_channel_id'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('user_guild_unique').on(t.userId, t.guildId),
  ],
);

export const wantsItems = pgTable(
  'wants_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    familyId: text('family_id').notNull(),
    qty: integer('qty').notNull(),
    restrictionMode: text('restriction_mode').notNull(),
    restrictionVariants: text('restriction_variants')
      .array()
      .$type<string[]>(),
    restrictionKey: text('restriction_key').notNull(),
    maxUnitPrice: numeric('max_unit_price'),
    note: text('note'),
    isPriority: boolean('is_priority').default(false),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('wants_user_family_restriction').on(t.userId, t.familyId, t.restrictionKey),
  ],
);

export const availableItems = pgTable(
  'available_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    productId: text('product_id').notNull(),
    qty: integer('qty').notNull(),
    note: text('note'),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('available_user_product').on(t.userId, t.productId),
  ],
);

export const trades = pgTable('trades', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  yourCards: jsonb('your_cards').notNull().$type<TradeCardSnapshot[]>(),
  theirCards: jsonb('their_cards').notNull().$type<TradeCardSnapshot[]>(),
  percentage: integer('percentage').notNull(),
  priceMode: text('price_mode').notNull(),
  totalYours: numeric('total_yours').notNull(),
  totalTheirs: numeric('total_theirs').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export interface TradeCardSnapshot {
  productId: string;
  name: string;
  variant: string;
  qty: number;
  unitPrice: number | null;
}

/**
 * A proposal one user sends another. Distinct from `trades` (which
 * is a personal save-your-trade snapshot keyed to a single user) —
 * proposals live between two users and carry state through the
 * accept/decline lifecycle.
 *
 * Status transitions (Phase 4c):
 *   pending → accepted | declined | cancelled (by proposer) | expired (TTL)
 * `responded_at` marks when status first left `pending`. No
 * resumable state — a declined/cancelled proposal can't be
 * reopened; the proposer submits a new one.
 *
 * Cards are frozen as snapshots at proposal time because:
 *   - Prices fluctuate and the proposer is implicitly agreeing to
 *     current pricing when they compose.
 *   - Either party may have removed a card from their list by the
 *     time the other responds; the proposal should still show what
 *     was offered, not what's currently listed.
 */
export const tradeProposals = pgTable(
  'trade_proposals',
  {
    id: text('id').primaryKey(),
    proposerUserId: text('proposer_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    recipientUserId: text('recipient_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'declined', 'cancelled', 'expired', 'countered'] })
      .default('pending')
      .notNull(),
    // Self-FK: when set, points to the proposal this one was made
    // against. Counters form a chain walked backwards via this FK;
    // the original has counter_of_id=null. See
    // PHASE4C_COUNTER_DESIGN.md for the full semantic model.
    // `on delete set null` means deleting an ancestor (shouldn't
    // happen in practice) leaves the counter as a standalone row
    // with a broken history pointer — acceptable degradation.
    counterOfId: text('counter_of_id').references(
      (): AnyPgColumn => tradeProposals.id,
      { onDelete: 'set null' },
    ),
    offeringCards: jsonb('offering_cards').notNull().$type<TradeCardSnapshot[]>(),
    receivingCards: jsonb('receiving_cards').notNull().$type<TradeCardSnapshot[]>(),
    message: text('message'),
    // DM tracking (Phase 4c slice 3). Recorded after we successfully
    // create the recipient's DM channel + post the embed. Used by the
    // button-interaction handler to edit the DM in place on accept/
    // decline (swapping the button row for an outcome line).
    //
    // `deliveryStatus` is distinct from `status`: the proposal's
    // logical state (pending → accepted/declined) is one axis; the
    // Discord transport (pending → delivered / failed) is another.
    // Keeping them separate lets us surface "we saved but couldn't
    // DM them" in the UI without overloading a single enum.
    deliveryStatus: text('delivery_status', { enum: ['pending', 'delivered', 'failed'] })
      .default('pending')
      .notNull(),
    discordDmChannelId: text('discord_dm_channel_id'),
    discordDmMessageId: text('discord_dm_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  // Postgres does not auto-index FK columns. These cover the hot
  // paths: counter-child lookups (counter_of_id), single-row fetch
  // by recipient/proposer in detail views, status filters in the
  // optimistic-concurrency WHERE clauses, and the history query
  // (filter by user id, order by updated_at DESC).
  (t) => [
    index('trade_proposals_counter_of_id_idx').on(t.counterOfId),
    index('trade_proposals_status_idx').on(t.status),
    index('trade_proposals_proposer_updated_idx').on(t.proposerUserId, t.updatedAt.desc()),
    index('trade_proposals_recipient_updated_idx').on(t.recipientUserId, t.updatedAt.desc()),
  ],
);
