CREATE TABLE "bot_installed_guilds" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"guild_name" text NOT NULL,
	"guild_icon" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by_user_id" text
);
