ALTER TABLE "trade_sessions" ADD COLUMN "user_a_last_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_sessions" ADD COLUMN "user_b_last_read_at" timestamp with time zone;