-- One `body` per post and message (issue #941), instead of `content` meaning
-- text, an image URL or a filename depending on `content_type`, with the text
-- beside an attachment in `caption`.
-- The generated vectors read the columns dropped below.
-- migration-safety: allow drop-column (rebuilt below; the only instance is a dev one with disposable data)
ALTER TABLE "posts" DROP COLUMN "search_vector";--> statement-breakpoint
-- migration-safety: allow drop-column (rebuilt below; the only instance is a dev one with disposable data)
ALTER TABLE "messages" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "body" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "posts" SET "body" = CASE WHEN "content_type" = 'attachment' THEN coalesce("caption", '') ELSE "content" END;--> statement-breakpoint
UPDATE "messages" SET "body" = CASE WHEN "content_type" = 'attachment' THEN coalesce("caption", '') ELSE "content" END;--> statement-breakpoint
-- migration-safety: allow drop-default (it only served the backfill; the only instance is a dev one with disposable data)
ALTER TABLE "posts" ALTER COLUMN "body" DROP DEFAULT;--> statement-breakpoint
-- migration-safety: allow drop-default (it only served the backfill; the only instance is a dev one with disposable data)
ALTER TABLE "messages" ALTER COLUMN "body" DROP DEFAULT;--> statement-breakpoint
-- migration-safety: allow drop-column (moved into body above; takes the content and caption indexes with it)
ALTER TABLE "posts" DROP COLUMN "content_type", DROP COLUMN "content", DROP COLUMN "caption";--> statement-breakpoint
-- migration-safety: allow drop-column (moved into body above; takes the content and caption indexes with it)
ALTER TABLE "messages" DROP COLUMN "content_type", DROP COLUMN "content", DROP COLUMN "caption";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "body")) STORED;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "body")) STORED;--> statement-breakpoint
CREATE INDEX "posts_search_vector_idx" ON "posts" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "messages_search_vector_idx" ON "messages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "posts_body_trgm_idx" ON "posts" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_body_trgm_idx" ON "messages" USING gin ("body" gin_trgm_ops);
