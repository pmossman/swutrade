CREATE TABLE "user_peer_prefs" (
	"user_id" text NOT NULL,
	"peer_user_id" text NOT NULL,
	"communication_pref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_peer_prefs_user_id_peer_user_id_pk" PRIMARY KEY("user_id","peer_user_id")
);
--> statement-breakpoint
ALTER TABLE "user_peer_prefs" ADD CONSTRAINT "user_peer_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_peer_prefs" ADD CONSTRAINT "user_peer_prefs_peer_user_id_users_id_fk" FOREIGN KEY ("peer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;