-- Full-text search (issue #224). Each searchable table gets a generated,
-- always-stored `tsvector` column plus a GIN index, so search is served by an
-- index Postgres maintains automatically on write rather than a sequential
-- `ILIKE` scan that grows with the table.
--
-- The vector is built with the two-argument `to_tsvector('english', ...)` form
-- (an explicit regconfig makes it IMMUTABLE, a prerequisite for both a
-- generated column and a GIN index over it — the single-argument form is only
-- STABLE and would be rejected here).
--
-- Posts and messages only index rows whose content is actual text: for
-- `image_url`/`attachment` content the `content` column holds a URL or caption,
-- never something worth full-text matching, so the CASE keeps those out of the
-- index entirely (smaller index, and a query for "http" doesn't surface every
-- image). Comments have no content-type discriminator — their content is always
-- text — so they index unconditionally.
--
-- These columns are deliberately NOT represented in the Drizzle schema
-- (src/db/schema.ts): a bare `db.select()` would otherwise materialize the full
-- tsvector on every hot-path read (listPosts/listMessages/getPost), so they're
-- managed here and referenced only via raw SQL in the search handler.
ALTER TABLE "posts" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', CASE WHEN "content_type" = 'text' THEN "content" ELSE '' END)) STORED;--> statement-breakpoint
CREATE INDEX "posts_search_vector_idx" ON "posts" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;--> statement-breakpoint
CREATE INDEX "comments_search_vector_idx" ON "comments" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', CASE WHEN "content_type" = 'text' THEN "content" ELSE '' END)) STORED;--> statement-breakpoint
CREATE INDEX "messages_search_vector_idx" ON "messages" USING gin ("search_vector");
