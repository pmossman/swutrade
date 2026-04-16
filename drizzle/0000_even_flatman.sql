CREATE TABLE "available_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"qty" integer NOT NULL,
	"note" text,
	"added_at" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "available_user_product" UNIQUE("user_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"discord_id" text NOT NULL,
	"username" text NOT NULL,
	"handle" text NOT NULL,
	"avatar_url" text,
	"wants_public" boolean DEFAULT true NOT NULL,
	"available_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id"),
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "wants_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"family_id" text NOT NULL,
	"qty" integer NOT NULL,
	"restriction_mode" text NOT NULL,
	"restriction_variants" text[],
	"restriction_key" text NOT NULL,
	"max_unit_price" numeric,
	"note" text,
	"is_priority" boolean DEFAULT false,
	"added_at" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wants_user_family_restriction" UNIQUE("user_id","family_id","restriction_key")
);
--> statement-breakpoint
ALTER TABLE "available_items" ADD CONSTRAINT "available_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wants_items" ADD CONSTRAINT "wants_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;