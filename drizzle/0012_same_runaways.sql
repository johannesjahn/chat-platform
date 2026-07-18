CREATE TABLE "chat_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"code" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "chat_participants" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_invites" ADD CONSTRAINT "chat_invites_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_invites" ADD CONSTRAINT "chat_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_invites_code_idx" ON "chat_invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "chat_invites_chat_id_idx" ON "chat_invites" USING btree ("chat_id");--> statement-breakpoint
-- Backfill: every existing chat's creator becomes its "owner" so pre-existing
-- groups don't lose their creator-only permissions once those checks switch
-- from `chats.created_by` to this per-participant role (issue #220).
UPDATE "chat_participants" AS cp
SET "role" = 'owner'
FROM "chats" AS c
WHERE c."id" = cp."chat_id"
  AND c."created_by" = cp."user_id";