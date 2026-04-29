ALTER TABLE "card_signals" ADD COLUMN "group_id" text;--> statement-breakpoint
CREATE INDEX "card_signals_group_idx" ON "card_signals" USING btree ("group_id");