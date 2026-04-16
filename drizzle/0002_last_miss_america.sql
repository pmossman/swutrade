CREATE TABLE "user_guild_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"guild_name" text NOT NULL,
	"guild_icon" text,
	"can_manage" boolean DEFAULT false NOT NULL,
	"enrolled" boolean DEFAULT false NOT NULL,
	"include_in_rollups" boolean DEFAULT false NOT NULL,
	"appear_in_queries" boolean DEFAULT false NOT NULL,
	"announce_visits_channel_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_guild_unique" UNIQUE("user_id","guild_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dm_trade_proposals" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dm_match_alerts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dm_meetup_reminders" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_guild_memberships" ADD CONSTRAINT "user_guild_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;