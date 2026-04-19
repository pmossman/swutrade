CREATE TABLE "community_events" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_user_id" text,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "share_activity_publicly" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_events_guild_created_idx" ON "community_events" USING btree ("guild_id","created_at");