-- Captions on attachments (issue #765).
--
-- A nullable column of its own rather than a reuse of `content`: for an
-- "attachment" row `content` holds the filename, on every row written so far
-- and on every row an old replica still writes mid-rollout. Keeping it that
-- way means old replicas read new rows correctly (they never look at
-- `caption`) and new code never has to guess whether a `content` is a
-- filename or a caption. Adding a nullable column with no default is a
-- metadata-only change — no table rewrite, no backfill.
ALTER TABLE "messages" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "caption" text;--> statement-breakpoint

-- Search over captions, served by indexes like the text branches (migrations
-- 0017 and 0023). Expression indexes rather than another generated tsvector
-- column: a generated STORED column would rewrite both tables under an
-- exclusive lock, where an index over the new — still all-NULL — column is
-- cheap to build. Partial on the predicate the search arms carry, so only
-- captioned attachments are indexed. The expression must stay exactly the
-- one SearchHandler.ts queries with (`to_tsvector('english', caption)`).
CREATE INDEX IF NOT EXISTS "posts_caption_search_idx" ON "posts" USING gin (to_tsvector('english', "caption")) WHERE "content_type" = 'attachment' AND "caption" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_caption_trgm_idx" ON "posts" USING gin ("caption" gin_trgm_ops) WHERE "content_type" = 'attachment' AND "caption" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_caption_search_idx" ON "messages" USING gin (to_tsvector('english', "caption")) WHERE "content_type" = 'attachment' AND "caption" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_caption_trgm_idx" ON "messages" USING gin ("caption" gin_trgm_ops) WHERE "content_type" = 'attachment' AND "caption" IS NOT NULL;
