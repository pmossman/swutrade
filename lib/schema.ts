import {
  pgTable,
  primaryKey,
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
  // Fires once per APPLICATION_AUTHORIZED event for an existing user
  // already in that guild. Opt-out surface for "SWUTrade just landed
  // in your server, want to join?" DMs. Default on — this is how we
  // invite existing community members into a newly-bot-installed
  // server; the feature doesn't work without the DM.
  dmServerNewInstall: boolean('dm_server_new_install').default(true).notNull(),
  // Aggressive auto-enrollment: when the bot lands in a guild the user
  // is ALREADY in, flip all three consent axes (enrolled, rollups,
  // queries) to true automatically. Default OFF — existing
  // memberships should not silently gain visibility from a server-
  // admin decision the user didn't make. Users opt in via Settings.
  autoEnrollOnBotInstall: boolean('auto_enroll_on_bot_install').default(false).notNull(),
  // Trade-thread consent model. Four states driving the decision of
  // whether a proposal's chat happens in a private thread (with both
  // traders inside) or stays in per-user DMs:
  //   - prefer       — wants threads by default when the other side
  //                    is also opted in
  //   - auto-accept  — DM first, but auto-approves any thread request
  //                    from the counterpart
  //   - allow        — DM first, approves/declines thread requests
  //                    manually via button (default)
  //   - dm-only      — refuses threads entirely; no "Request thread"
  //                    button is surfaced to the counterpart
  // See handlePropose's decision matrix for the full 4×4 routing.
  communicationPref: text('communication_pref', {
    enum: ['prefer', 'auto-accept', 'allow', 'dm-only'],
  }).default('allow').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Per-peer preference overrides — sparse storage for "I want a
 * different default specifically when trading with this person."
 * A missing row (or a null column) means "no override; resolve
 * through the cascade to the viewer's self-scoped default" (see
 * docs/prefs-registry.md for the resolution rule).
 *
 * Composite primary key `(user_id, peer_user_id)` enforces at most
 * one row per viewer/peer pair. Both FKs cascade on delete: if
 * either party deactivates, their peer pref rows vanish. Rows are
 * NOT cleaned up when the viewer leaves a mutual guild — overrides
 * are tied to user identity, not the guild relationship.
 */
export const userPeerPrefs = pgTable(
  'user_peer_prefs',
  {
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    peerUserId: text('peer_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    // Override for the viewer's self-scoped communicationPref when
    // the counterpart is `peerUserId`. Null = inherit from self.
    // Enum values must stay in sync with users.communicationPref;
    // the registry unit test asserts the peer-scoped def and the
    // self-scoped def agree on options.
    communicationPref: text('communication_pref', {
      enum: ['prefer', 'auto-accept', 'allow', 'dm-only'],
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.peerUserId] }),
  ],
);

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
  /**
   * Per-guild `#swutrade-threads` channel created by the bot on
   * install to host private trade-proposal threads. Nullable because
   * (a) the install may have predated the auto-create feature, and
   * (b) the bot may have lacked `MANAGE_CHANNELS` at install time —
   * in both cases the install still succeeded and this column stays
   * null until remedied.
   */
  tradesChannelId: text('trades_channel_id'),
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
    // Private-thread mode (preferred when TRADES_CHANNEL_ID env is set).
    // When a proposal lands, the bot creates a private thread in the
    // configured parent channel, adds both users, and posts the embed
    // there instead of per-user DMs. Both users get a push-style
    // notification on add, and both can chat in-thread. DM columns
    // above remain the fallback when thread creation fails (user not
    // in the guild, perms missing, etc.).
    discordThreadId: text('discord_thread_id'),
    discordThreadParentChannelId: text('discord_thread_parent_channel_id'),
    // Request-thread flow (Phase-1 consent model). When one party
    // clicks "Request thread" and the counterpart's pref is `allow`
    // (manual-decide), the bot sends the counterpart a NEW approval
    // DM with Approve / Keep as DM buttons. These columns store that
    // DM's channel + message id so approve/decline can PATCH it back
    // in place. Cleared after the request resolves (approve → thread
    // created; decline → continuing in DM).
    //
    // Naming note: the column names reference "approval" not
    // "proposer" — either party can request, so the approval DM goes
    // to whichever party DIDN'T click Request.
    threadApprovalDmChannelId: text('thread_approval_dm_channel_id'),
    threadApprovalDmMessageId: text('thread_approval_dm_message_id'),
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
