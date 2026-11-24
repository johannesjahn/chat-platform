-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "chat_events" ALTER COLUMN "after_message_id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "chat_participants" ALTER COLUMN "last_read_message_id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "likes" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "likes" ALTER COLUMN "message_id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "messages" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "messages" ALTER COLUMN "parent_message_id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "messages" ALTER COLUMN "forwarded_from_message_id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "notifications" ALTER COLUMN "id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "pinned_messages" ALTER COLUMN "message_id" SET DATA TYPE bigint;--> statement-breakpoint
-- migration-safety: allow column-type (integer to bigint only widens; the only instance is a dev one with disposable data)
ALTER TABLE "starred_messages" ALTER COLUMN "message_id" SET DATA TYPE bigint;--> statement-breakpoint
-- Widening a serial column leaves its sequence capped at 2^31.
ALTER SEQUENCE "messages_id_seq" AS bigint;--> statement-breakpoint
ALTER SEQUENCE "likes_id_seq" AS bigint;--> statement-breakpoint
ALTER SEQUENCE "notifications_id_seq" AS bigint;
