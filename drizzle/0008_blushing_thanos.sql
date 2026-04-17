CREATE INDEX "trade_proposals_counter_of_id_idx" ON "trade_proposals" USING btree ("counter_of_id");--> statement-breakpoint
CREATE INDEX "trade_proposals_status_idx" ON "trade_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trade_proposals_proposer_updated_idx" ON "trade_proposals" USING btree ("proposer_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trade_proposals_recipient_updated_idx" ON "trade_proposals" USING btree ("recipient_user_id","updated_at" DESC NULLS LAST);