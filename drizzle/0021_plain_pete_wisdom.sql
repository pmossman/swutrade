CREATE TABLE "card_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"wants_item_id" text,
	"available_item_id" text,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"thread_id" text,
	"event_id" text,
	"lgs_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signal_note" text,
	"max_unit_price" numeric
);
--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD COLUMN "responding_to_signal_id" text;--> statement-breakpoint
ALTER TABLE "card_signals" ADD CONSTRAINT "card_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_signals" ADD CONSTRAINT "card_signals_wants_item_id_wants_items_id_fk" FOREIGN KEY ("wants_item_id") REFERENCES "public"."wants_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_signals" ADD CONSTRAINT "card_signals_available_item_id_available_items_id_fk" FOREIGN KEY ("available_item_id") REFERENCES "public"."available_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_signals" ADD CONSTRAINT "card_signals_guild_id_bot_installed_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."bot_installed_guilds"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_signals_active_match_idx" ON "card_signals" USING btree ("guild_id","kind","status");--> statement-breakpoint
CREATE INDEX "card_signals_user_kind_idx" ON "card_signals" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "card_signals_expiry_idx" ON "card_signals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "trade_proposals_signal_idx" ON "trade_proposals" USING btree ("responding_to_signal_id");--> statement-breakpoint
-- Belt-and-suspenders: drizzle's TS-side schema can't express
-- "exactly one of these two FKs is non-null" — enforce via CHECK
-- so a future hand-rolled migration that violates the invariant
-- fails at the DB layer instead of producing inconsistent rows.
ALTER TABLE "card_signals" ADD CONSTRAINT "card_signals_kind_link_check" CHECK (
  (kind = 'wanted'   AND wants_item_id     IS NOT NULL AND available_item_id IS NULL) OR
  (kind = 'offering' AND available_item_id IS NOT NULL AND wants_item_id     IS NULL)
);