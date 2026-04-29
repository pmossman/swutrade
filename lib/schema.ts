import { sql } from 'drizzle-orm';
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
  uniqueIndex,
  index,
  jsonb,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  // Nullable as of Phase 5b (anonymous / ghost users) — a signed-in
  // Discord user has a non-null id; a ghost claimed via QR doesn't.
  // Still unique when set. Upgrade path: ghost → real via the OAuth
  // callback which merges the ghost row into the Discord user.
  discordId: text('discord_id').unique(),
  username: text('username').notNull(),
  handle: text('handle').unique().notNull(),
  avatarUrl: text('avatar_url'),
  // True when this row was created as a ghost for an anonymous
  // participant in a shared trade. Ghost users:
  //   - have a null discord_id, auto-generated handle / username
  //   - never appear in community rollups, directory, or activity
  //     feeds (every public listing must add `WHERE is_anonymous =
  //     false`)
  //   - can't own wants / available / guild memberships / peer prefs
  //     until they sign in (the OAuth callback merges them into the
  //     Discord account at that point)
  isAnonymous: boolean('is_anonymous').default(false).notNull(),
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
  // Community activity feed opt-out. When true, the user's
  // lifecycle events (trade_accepted, member_joined) render in each
  // mutual guild's Community Overview feed. Default on — the feed is
  // a guild-scoped surface only visible to other enrolled members, so
  // the baseline expectation is presence. Toggling off hides future
  // AND historical events; events are still recorded so flipping back
  // on restores the trail.
  shareActivityPublicly: boolean('share_activity_publicly').default(true).notNull(),
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
 * Explicit bookmark list — "I know @bob, I want to trade with him."
 * Independent of community enrollment: a user can favorite any other
 * SWUTrade user with a public profile, even if they share no Discord
 * guild. Companion to `useRecentPartners` (auto-populated from actual
 * trade history) — favorites add the "I haven't traded with them yet
 * but will" case that RecentPartners can't cover.
 *
 * Composite PK so re-favoriting the same partner is an upsert / no-op,
 * not a duplicate row. `note` is optional ("met at LGS tournament") —
 * ships empty today; wired in schema so the CRUD API doesn't need a
 * follow-on migration when we add a notes UI.
 *
 * `ON DELETE cascade` on both FK columns: when either party deletes
 * their account, the favorite row is removed. Neither party is
 * notified that the other favorited them (bookmarking is a one-sided
 * act, same semantics as bookmarking a public profile URL).
 */
export const userFavoritePartners = pgTable(
  'user_favorite_partners',
  {
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    partnerUserId: text('partner_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.partnerUserId] }),
    index('user_favorite_partners_user_id_idx').on(t.userId),
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
    // Guild scope for the proposal's thread routing. Resolved at
    // propose-time from the (proposer, recipient) pair's mutual
    // bot-installed guilds; null when no qualifying guild exists
    // (DM-only delivery) or for legacy rows pre-dating this column.
    // Counters inherit this from the original to preserve
    // conversation continuity. The thread itself lives in
    // `bot_installed_guilds.trades_channel_id` for this guild — we
    // store the guild_id rather than the channel_id directly so a
    // server admin renaming/recreating the channel doesn't orphan
    // historical proposals.
    guildId: text('guild_id'),
    // Private-thread mode. When a proposal lands AND a guild is
    // resolved, the bot creates a private thread in that guild's
    // `#swutrade-threads` channel, adds both users, and posts the
    // embed there instead of per-user DMs. Both users get a push-
    // style notification on add, and both can chat in-thread. DM
    // columns above remain the fallback when thread creation fails
    // (user not in the guild, perms missing, etc.).
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
    // Set when this proposal was created in response to a
    // `card_signals` post (someone clicked "I have this!" / "I want
    // this!" on a /looking-for or /offering signal). Lets the
    // signal's response thread render in one query and lets
    // fulfillment detection mark the source signal as `fulfilled`
    // when this proposal transitions to `accepted`. ON DELETE SET
    // NULL so cancelling a signal doesn't cascade through to its
    // response proposals — the conversations stay alive.
    respondingToSignalId: text('responding_to_signal_id'),
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
    // Hot path: render a signal's response thread (find proposals
    // where responding_to_signal_id = X) + fulfillment detection
    // on accept transitions. Partial — most rows have a NULL value.
    index('trade_proposals_signal_idx').on(t.respondingToSignalId),
  ],
);

/**
 * Append-only activity log for a proposal. Powers the timeline on the
 * trade detail view + lets product surface things like "Alice edited
 * this 2h ago" or "You nudged @bob yesterday".
 *
 * Event types map 1:1 to user-visible lifecycle beats plus a couple of
 * delivery-transport beats so we can diagnose silent failures:
 *   created         — proposer sends the initial proposal
 *   delivered_ok    — Discord DM/thread post landed
 *   delivered_failed — Discord post failed (recipient has DMs disabled, bot missing perms, etc.)
 *   edited          — proposer revised the pending proposal (cards or note)
 *   nudged          — proposer re-sent the DM with an optional note
 *   accepted | declined | cancelled | countered | expired — lifecycle terminals
 *
 * `actor_user_id` is the person who triggered the event. Null for
 * system events (delivery transport, expiry cron). Payload is a
 * free-form JSON bag — per-type shapes:
 *   edited:   { cardsChanged: boolean, messageChanged: boolean }
 *   nudged:   { note: string | null }
 *   delivered_failed: { error: string }  — for debugging
 *   Other events typically have no payload.
 *
 * No partial order beyond `created_at`; the index covers the hot
 * path (list events for a given proposal, oldest-first).
 */
export const proposalEventTypes = [
  'created',
  'delivered_ok',
  'delivered_failed',
  'edited',
  'nudged',
  'accepted',
  'declined',
  'cancelled',
  'countered',
  'expired',
] as const;
export type ProposalEventType = typeof proposalEventTypes[number];

export const proposalEvents = pgTable(
  'proposal_events',
  {
    id: text('id').primaryKey(),
    proposalId: text('proposal_id')
      .references(() => tradeProposals.id, { onDelete: 'cascade' })
      .notNull(),
    actorUserId: text('actor_user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    type: text('type', { enum: proposalEventTypes }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('proposal_events_proposal_created_idx').on(t.proposalId, t.createdAt),
  ],
);

/**
 * Append-only activity log scoped to a Discord guild. Powers the
 * Community 2.0 Overview tab's activity feed.
 *
 * Event types (per-type payload shape):
 *   trade_accepted — { proposalId, counterpartUserId }
 *   member_joined  — { } (actor_user_id carries the identity)
 *
 * Privacy: an actor's `users.share_activity_publicly` flag gates
 * whether their events render in the feed. Events are always recorded
 * (we don't delete an actor's history when they toggle off) — the
 * read-side query filters. Turning the pref back on restores
 * visibility of the historical events.
 */
export const communityEventTypes = [
  'trade_accepted',
  'member_joined',
] as const;
export type CommunityEventType = typeof communityEventTypes[number];

export const communityEvents = pgTable(
  'community_events',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id').notNull(),
    actorUserId: text('actor_user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    type: text('type', { enum: communityEventTypes }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('community_events_guild_created_idx').on(t.guildId, t.createdAt),
  ],
);

/**
 * Phase 5b — Shared trade sessions. A collaborative alternative to
 * `trade_proposals`: two users share a single mutable trade object
 * they both edit over time. Same primitive serves both the live case
 * (both connected, phones on the table, polling every 2-3s) and the
 * async case (edit-and-come-back with Discord pings on the other
 * side's changes).
 *
 * Why distinct from trade_proposals:
 *   - Proposals are ping-pong, convergent via counter chain, formal.
 *   - Sessions are collaborative, convergent via a single mutable
 *     object, confirm-at-the-end. Different modalities, coexist.
 *
 * Status transitions:
 *   active → settled (both parties confirm)
 *   active → cancelled (either party explicitly cancels)
 *   active → expired (TTL cron sweep)
 *
 * Conflict model: each participant edits only their OWN half of the
 * trade — `user_a_cards` is owned by `user_a_id`, `user_b_cards` by
 * `user_b_id`. Per-side ownership → no concurrent writes to the same
 * field → no CRDT needed for v1. The cards columns hold live state,
 * mutated in place (unlike trade_proposals' frozen snapshots).
 *
 * Pair uniqueness: a partial unique index on (least(user_a_id,
 * user_b_id), greatest(user_a_id, user_b_id)) WHERE status='active'
 * enforces "at most one active session per pair" at the DB layer. The
 * sorted pair lets us ignore ordering — `(alice, bob)` and `(bob,
 * alice)` collide. Settled/expired/cancelled rows don't count against
 * the cap so a pair who completes a trade can start a new session.
 *
 * Async resumption: `last_notified_at` is a JSONB map keyed by user
 * id → ISO timestamp of the last DM we sent that user about changes
 * here. The debounce-DM job reads this to decide whether to ping on
 * a new edit. Per-user so each side has its own debounce window.
 */
export const sessionStatuses = ['active', 'settled', 'cancelled', 'expired'] as const;
export type SessionStatus = typeof sessionStatuses[number];

export const tradeSessions = pgTable(
  'trade_sessions',
  {
    // Short alphanumeric code (8 chars, nanoid-like, unambiguous
    // alphabet — no 0/O/1/I/l). Used directly in the /s/<code> URL
    // + QR handoff. Large enough for no collisions under realistic
    // active-session volumes.
    id: text('id').primaryKey(),
    // Participants stored canonically — when both are set,
    // `user_a_id` < `user_b_id` lexicographically. Lets the partial
    // unique index + lookups work without coalesce gymnastics.
    // Callers normalise before insert; select queries check both
    // positions when filtering by viewer id.
    //
    // `user_b_id` is nullable for the QR / in-person flow: a user
    // creates an "open" session with just themselves in slot A and
    // shares a QR-coded URL. The scanner claims slot B — either as
    // an existing user or as a freshly-minted ghost (is_anonymous).
    // Slot A is never null; someone has to originate the session.
    userAId: text('user_a_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    userBId: text('user_b_id')
      .references(() => users.id, { onDelete: 'cascade' }),
    // Live card state — what each side currently offers. Mutated
    // in place by PUT endpoints. Same TradeCardSnapshot shape as
    // trade_proposals for code reuse on the render side.
    userACards: jsonb('user_a_cards').notNull().default([]).$type<TradeCardSnapshot[]>(),
    userBCards: jsonb('user_b_cards').notNull().default([]).$type<TradeCardSnapshot[]>(),
    status: text('status', { enum: sessionStatuses }).default('active').notNull(),
    // Both participants must be in this array for the session to
    // transition to `settled`. Any edit from either side clears it.
    // Stored as a text[] (not jsonb) so we can use array operators
    // when checking membership at the query layer.
    confirmedByUserIds: text('confirmed_by_user_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    // Last edit bookkeeping. `last_edited_by_user_id` lets the
    // debounce job target the OTHER user; `last_edited_at` drives
    // both the UI "last activity" timestamp and the ping cooldown.
    lastEditedAt: timestamp('last_edited_at', { withTimezone: true }).defaultNow().notNull(),
    lastEditedByUserId: text('last_edited_by_user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    // Map user_id → ISO timestamp of last DM sent to them about
    // changes here. The debounce-DM job reads this entry for the
    // OTHER user when deciding whether to ping. Updated atomically
    // with the DM send.
    lastNotifiedAt: jsonb('last_notified_at').notNull().default({}).$type<Record<string, string>>(),
    // Longer TTL than proposals (days, not hours) because async
    // sessions can span multi-day negotiations. Exact policy (N days
    // of inactivity? N days from creation?) is the cron's call.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Optional final-state timestamp — when the session first left
    // `active`. Symmetric with trade_proposals.respondedAt.
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    // Partial unique index: only ONE active session per sorted pair.
    // Settled/cancelled/expired rows skipped via the WHERE clause
    // (Postgres partial indexes), which means a pair can start a
    // fresh session after completing an old one. Also skipped: rows
    // where user_b_id is null (open, un-claimed sessions) — a
    // single user can have many open slots waiting for a scanner,
    // and the uniqueness concept only applies once the pair is
    // fully formed.
    uniqueIndex('trade_sessions_active_pair_idx')
      .on(t.userAId, t.userBId)
      .where(sql`${t.status} = 'active' AND ${t.userBId} IS NOT NULL`),
    // Lookup by viewer id — the "my sessions" query hits these.
    index('trade_sessions_user_a_status_idx').on(t.userAId, t.status),
    index('trade_sessions_user_b_status_idx').on(t.userBId, t.status),
    // Expiry cron scans `active` rows by `expires_at`.
    index('trade_sessions_status_expires_idx').on(t.status, t.expiresAt),
  ],
);

/**
 * Append-only event log for a session. Powers the timeline UI +
 * audit trail for "who changed what, when." Kept sparse — we don't
 * log every card add/remove as its own row (that would balloon),
 * just lifecycle beats.
 *
 * Event types:
 *   created      — session opened
 *   edited       — one side mutated their half (batched per PUT call)
 *   confirmed    — a participant tapped Confirm
 *   unconfirmed  — confirmations cleared because of a subsequent edit
 *   settled      — both parties confirmed, session frozen
 *   cancelled    — explicit cancel by a participant
 *   expired      — TTL cron moved it to terminal
 *   notified     — debounce-DM job sent a ping (helps reason about
 *                  why a user got/didn't get a DM)
 *
 * Payload shape varies by type — see the write call sites.
 */
export const sessionEventTypes = [
  'created',
  'edited',
  'confirmed',
  'unconfirmed',
  'settled',
  'cancelled',
  'expired',
  'notified',
] as const;
export type SessionEventType = typeof sessionEventTypes[number];

export const sessionEvents = pgTable(
  'session_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .references(() => tradeSessions.id, { onDelete: 'cascade' })
      .notNull(),
    actorUserId: text('actor_user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    type: text('type', { enum: sessionEventTypes }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('session_events_session_created_idx').on(t.sessionId, t.createdAt),
  ],
);

/**
 * Acute "I want this card NOW" / "I have this card to offload NOW"
 * broadcasts surfaced via `/looking-for` + `/offering` slash commands.
 *
 * Distinct from a user's standing wishlist (`wants_items`) and binder
 * (`available_items`) — those are the long-tail inventory; signals
 * are the high-priority subset the user wants to call attention to
 * for an upcoming event or quick turnaround.
 *
 * The signal IS the public surface of an inventory row, NOT a copy.
 * The slash handler upserts the underlying wants/available row first,
 * then inserts a signal row pointing at it. Cascade-delete from the
 * inventory side: if the user removes the card from their list, the
 * signal post becomes meaningless and gets retired automatically.
 *
 * Lifecycle:
 *   active     — broadcast live; matched users have been DM-pinged
 *   cancelled  — owner clicked Cancel on the post
 *   fulfilled  — a trade between requester + responder for this card
 *                landed `accepted` (PR 3 detection)
 *   expired    — past `expires_at`; cron sweep marks + PATCHes embed
 *
 * Forward-compat for LGS integration:
 *   `event_id` / `lgs_id` are nullable today (no events table yet).
 *   When LGS ships, the slash command grows an `event:` autocomplete,
 *   matching gets a same-event-attendee boost, and these columns
 *   start carrying values without a schema change.
 */
export const cardSignalKinds = ['wanted', 'offering'] as const;
export type CardSignalKind = typeof cardSignalKinds[number];

export const cardSignalStatuses = ['active', 'cancelled', 'fulfilled', 'expired'] as const;
export type CardSignalStatus = typeof cardSignalStatuses[number];

export const cardSignals = pgTable(
  'card_signals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    kind: text('kind', { enum: cardSignalKinds }).notNull(),

    // Exactly one is non-null (enforced by DB CHECK constraint added
    // in the migration). Cascade-delete from the inventory side so a
    // standing-list mutation retires the signal automatically.
    wantsItemId: text('wants_item_id')
      .references(() => wantsItems.id, { onDelete: 'cascade' }),
    availableItemId: text('available_item_id')
      .references(() => availableItems.id, { onDelete: 'cascade' }),

    // Discord post anchors. Cascade from the guild row so an
    // uninstall sweeps the signals it scoped.
    guildId: text('guild_id')
      .references(() => botInstalledGuilds.guildId, { onDelete: 'cascade' })
      .notNull(),
    channelId: text('channel_id').notNull(),
    // message_id is set after the bot.postChannelMessage call returns;
    // null briefly between INSERT and UPDATE in the slash handler.
    messageId: text('message_id'),

    // PR 2 stores the response thread id here. Reserved for forward
    // compatibility so the column exists at PR 1 time and PR 2 just
    // populates it.
    threadId: text('thread_id'),

    // Forward-compat for LGS. Both nullable today.
    eventId: text('event_id'),
    lgsId: text('lgs_id'),

    status: text('status', { enum: cardSignalStatuses })
      .default('active')
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),

    // Signal-specific overrides layered over the inventory row's own
    // note / max-price. Lets a user say "normally I'd take $5 max
    // but for THIS post I'd pay $8 to grab one fast" without
    // mutating their standing wishlist's ceiling.
    signalNote: text('signal_note'),
    maxUnitPrice: numeric('max_unit_price'),
  },
  (t) => [
    // Match query — find active signals in a guild by kind. Partial
    // index on status='active' so the cron expiry sweep can scan the
    // small live set without filtering through cancelled/fulfilled.
    index('card_signals_active_match_idx').on(t.guildId, t.kind, t.status),
    // "My active signals" view in the web app.
    index('card_signals_user_kind_idx').on(t.userId, t.kind),
    // Cron sweep: walk active signals past expires_at.
    index('card_signals_expiry_idx').on(t.status, t.expiresAt),
  ],
);
