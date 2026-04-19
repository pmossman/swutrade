CREATE TABLE "session_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"actor_user_id" text,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_a_id" text NOT NULL,
	"user_b_id" text NOT NULL,
	"user_a_cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_b_cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"confirmed_by_user_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"last_edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_edited_by_user_id" text,
	"last_notified_at" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_trade_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."trade_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_sessions" ADD CONSTRAINT "trade_sessions_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_sessions" ADD CONSTRAINT "trade_sessions_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_sessions" ADD CONSTRAINT "trade_sessions_last_edited_by_user_id_users_id_fk" FOREIGN KEY ("last_edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_events_session_created_idx" ON "session_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_sessions_active_pair_idx" ON "trade_sessions" USING btree ("user_a_id","user_b_id") WHERE "trade_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "trade_sessions_user_a_status_idx" ON "trade_sessions" USING btree ("user_a_id","status");--> statement-breakpoint
CREATE INDEX "trade_sessions_user_b_status_idx" ON "trade_sessions" USING btree ("user_b_id","status");--> statement-breakpoint
CREATE INDEX "trade_sessions_status_expires_idx" ON "trade_sessions" USING btree ("status","expires_at");