CREATE TABLE "password_resets" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users" ("id"),
	"token_hash" text NOT NULL,
	"created_at" integer NOT NULL,
	"expires_at" integer NOT NULL,
	"used_at" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "password_resets_token_hash_idx" ON "password_resets" ("token_hash");
--> statement-breakpoint
CREATE INDEX "password_resets_user_id_idx" ON "password_resets" ("user_id");
