ALTER TABLE "trade_proposals" ADD COLUMN "delivery_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD COLUMN "discord_dm_channel_id" text;--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD COLUMN "discord_dm_message_id" text;