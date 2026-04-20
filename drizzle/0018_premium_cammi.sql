DROP INDEX "trade_sessions_active_pair_idx";--> statement-breakpoint
ALTER TABLE "trade_sessions" ALTER COLUMN "user_b_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "discord_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trade_sessions_active_pair_idx" ON "trade_sessions" USING btree ("user_a_id","user_b_id") WHERE "trade_sessions"."status" = 'active' AND "trade_sessions"."user_b_id" IS NOT NULL;