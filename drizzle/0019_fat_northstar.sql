CREATE TABLE "user_favorite_partners" (
	"user_id" text NOT NULL,
	"partner_user_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorite_partners_user_id_partner_user_id_pk" PRIMARY KEY("user_id","partner_user_id")
);
--> statement-breakpoint
ALTER TABLE "user_favorite_partners" ADD CONSTRAINT "user_favorite_partners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorite_partners" ADD CONSTRAINT "user_favorite_partners_partner_user_id_users_id_fk" FOREIGN KEY ("partner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_favorite_partners_user_id_idx" ON "user_favorite_partners" USING btree ("user_id");