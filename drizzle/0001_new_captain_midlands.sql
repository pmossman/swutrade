CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"your_cards" jsonb NOT NULL,
	"their_cards" jsonb NOT NULL,
	"percentage" integer NOT NULL,
	"price_mode" text NOT NULL,
	"total_yours" numeric NOT NULL,
	"total_theirs" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;