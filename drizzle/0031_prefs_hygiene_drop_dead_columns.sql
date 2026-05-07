DROP TABLE "user_peer_prefs" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "dm_trade_proposals";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "dm_match_alerts";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "dm_meetup_reminders";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "dm_session_ping";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "dm_session_expired";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "communication_pref";