CREATE TABLE "users" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users" ("id"),
	"token_hash" text NOT NULL,
	"created_at" integer NOT NULL,
	"expires_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"age" integer NOT NULL,
	"color" text NOT NULL,
	"emoji" text DEFAULT '⭐' NOT NULL,
	"equipped_avatar" text DEFAULT 'starter' NOT NULL,
	"hearts" integer DEFAULT 5 NOT NULL,
	"last_grumbler_day" text,
	"last_grumbler_hit" text,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chores" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"points" integer NOT NULL,
	"cadence" text DEFAULT 'daily' NOT NULL,
	"assigned_player_id" integer REFERENCES "players" ("id"),
	"active" integer DEFAULT true NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "completions" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"chore_id" integer NOT NULL REFERENCES "chores" ("id"),
	"player_id" integer NOT NULL REFERENCES "players" ("id"),
	"chore_title" text NOT NULL,
	"points" integer NOT NULL,
	"day" text NOT NULL,
	"status" text DEFAULT 'verified' NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rewards" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"cost" integer NOT NULL,
	"active" integer DEFAULT true NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemptions" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"reward_id" integer NOT NULL REFERENCES "rewards" ("id"),
	"player_id" integer NOT NULL REFERENCES "players" ("id"),
	"reward_title" text NOT NULL,
	"cost" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" integer NOT NULL,
	"resolved_at" integer
);
--> statement-breakpoint
CREATE TABLE "bonuses" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"player_id" integer NOT NULL REFERENCES "players" ("id"),
	"points" integer NOT NULL,
	"label" text NOT NULL,
	"day" text NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "penalties" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"player_id" integer NOT NULL REFERENCES "players" ("id"),
	"points" integer NOT NULL,
	"label" text NOT NULL,
	"day" text NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quests" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"player_id" integer NOT NULL REFERENCES "players" ("id"),
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"target_chores" integer NOT NULL,
	"bonus_points" integer NOT NULL,
	"deadline_day" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" integer NOT NULL,
	"completed_at" integer
);
--> statement-breakpoint
CREATE TABLE "boss_battles" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"emoji" text NOT NULL,
	"taunt" text NOT NULL,
	"max_hp" integer NOT NULL,
	"week_start" text NOT NULL,
	"loot_granted" integer DEFAULT false NOT NULL,
	"created_at" integer NOT NULL,
	"defeated_at" integer
);
--> statement-breakpoint
CREATE TABLE "loot_chests" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"player_id" integer NOT NULL REFERENCES "players" ("id"),
	"tier" text DEFAULT 'common' NOT NULL,
	"status" text DEFAULT 'unopened' NOT NULL,
	"reward_points" integer,
	"reward_label" text,
	"created_at" integer NOT NULL,
	"opened_at" integer
);
--> statement-breakpoint
CREATE TABLE "grownup_auth" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"pin_hash" text NOT NULL,
	"pin_salt" text NOT NULL,
	"recovery_hash" text NOT NULL,
	"recovery_salt" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pin_sessions" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" integer NOT NULL,
	"expires_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "week_winners" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL,
	"week_start" text NOT NULL,
	"player_id" integer NOT NULL REFERENCES "players" ("id"),
	"points" integer NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "players_user_id_idx" ON "players" ("user_id");
--> statement-breakpoint
CREATE INDEX "chores_user_id_idx" ON "chores" ("user_id");
--> statement-breakpoint
CREATE INDEX "completions_user_id_idx" ON "completions" ("user_id");
--> statement-breakpoint
CREATE INDEX "rewards_user_id_idx" ON "rewards" ("user_id");
--> statement-breakpoint
CREATE INDEX "redemptions_user_id_idx" ON "redemptions" ("user_id");
--> statement-breakpoint
CREATE INDEX "bonuses_user_id_idx" ON "bonuses" ("user_id");
--> statement-breakpoint
CREATE INDEX "penalties_user_id_idx" ON "penalties" ("user_id");
--> statement-breakpoint
CREATE INDEX "quests_user_id_idx" ON "quests" ("user_id");
--> statement-breakpoint
CREATE INDEX "boss_battles_user_id_idx" ON "boss_battles" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "boss_battles_user_week_idx" ON "boss_battles" ("user_id", "week_start");
--> statement-breakpoint
CREATE INDEX "loot_chests_user_id_idx" ON "loot_chests" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "grownup_auth_user_id_idx" ON "grownup_auth" ("user_id");
--> statement-breakpoint
CREATE INDEX "pin_sessions_user_id_idx" ON "pin_sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "week_winners_user_id_idx" ON "week_winners" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "week_winners_user_week_idx" ON "week_winners" ("user_id", "week_start");
