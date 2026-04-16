import {
  pgTable,
  text,
  integer,
  boolean,
  bigint,
  numeric,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  discordId: text('discord_id').unique().notNull(),
  username: text('username').notNull(),
  handle: text('handle').unique().notNull(),
  avatarUrl: text('avatar_url'),
  wantsPublic: boolean('wants_public').default(true).notNull(),
  availablePublic: boolean('available_public').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

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
