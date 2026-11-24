-- A column named in a trigger's definition can't be retyped, so this one is
-- recreated below.
DROP TRIGGER "comments_count_soft_delete" ON "comments";--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "attachments" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chat_events" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chat_invites" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chat_invites" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chat_invites" ALTER COLUMN "revoked_at" SET DATA TYPE timestamp with time zone USING "revoked_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chat_participants" ALTER COLUMN "joined_at" SET DATA TYPE timestamp with time zone USING "joined_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chat_participants" ALTER COLUMN "muted_until" SET DATA TYPE timestamp with time zone USING "muted_until" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chat_participants" ALTER COLUMN "archived_at" SET DATA TYPE timestamp with time zone USING "archived_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chat_participants" ALTER COLUMN "pinned_at" SET DATA TYPE timestamp with time zone USING "pinned_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chats" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "chats" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "comments" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "comments" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "comments" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp with time zone USING "deleted_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_bluffs" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_drawings" ALTER COLUMN "submitted_at" SET DATA TYPE timestamp with time zone USING "submitted_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_drawings" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_lobbies" ALTER COLUMN "starts_at" SET DATA TYPE timestamp with time zone USING "starts_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_lobbies" ALTER COLUMN "ends_at" SET DATA TYPE timestamp with time zone USING "ends_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_lobbies" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_lobbies" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_lobby_messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_lobby_players" ALTER COLUMN "joined_at" SET DATA TYPE timestamp with time zone USING "joined_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_results" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "game_votes" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "likes" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "messages" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "notifications" ALTER COLUMN "read_at" SET DATA TYPE timestamp with time zone USING "read_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "notifications" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "pinned_messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "posts" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "posts" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "refresh_tokens" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "refresh_tokens" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "refresh_tokens" ALTER COLUMN "revoked_at" SET DATA TYPE timestamp with time zone USING "revoked_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "scheduled_jobs" ALTER COLUMN "last_run_at" SET DATA TYPE timestamp with time zone USING "last_run_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "starred_messages" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "user_blocks" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "users" ALTER COLUMN "status_expires_at" SET DATA TYPE timestamp with time zone USING "status_expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
-- migration-safety: allow column-type (the columns hold UTC; the only instance is a dev one with disposable data)
ALTER TABLE "users" ALTER COLUMN "last_active_at" SET DATA TYPE timestamp with time zone USING "last_active_at" AT TIME ZONE 'UTC';--> statement-breakpoint
CREATE TRIGGER "comments_count_soft_delete" AFTER UPDATE OF "deleted_at" ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "posts_comment_count_bump"();
