-- Search overhaul: fragment ("contains") matching, index-served.
--
-- The `tsvector` columns from migration 0017 only ever index whole, stemmed
-- lexemes, so they can answer "which rows contain the word *fragment*" but
-- never "which rows contain the fragment *ragmen*". An unanchored
-- `ILIKE '%ragmen%'` can answer that, but only by sequentially scanning the
-- table — precisely what a search feature must not do.
--
-- `pg_trgm` fixes both halves: it indexes every 3-character substring
-- (trigram) of a column, and its `gin_trgm_ops` operator class teaches the
-- planner to answer `LIKE`/`ILIKE` patterns from that index. Substring search
-- therefore becomes an index lookup, like the full-text branch beside it.
--
-- `pg_trgm` is a *trusted* extension (PG13+), so this needs no superuser —
-- the database owner the app/migration job connects as is enough. On PGlite
-- (local dev + tests) the extension bundle is registered when the instance is
-- created, see src/Db.ts and src/testDb.ts.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- Posts/messages: partial indexes matching the `content_type = 'text'`
-- predicate the search queries carry (the same rule migration 0017's generated
-- vectors bake in — an image URL or attachment caption isn't worth matching).
-- Keeping the predicate on the index keeps it small, and the planner can only
-- use it when the query says the same thing.
CREATE INDEX IF NOT EXISTS "posts_content_trgm_idx" ON "posts" USING gin ("content" gin_trgm_ops) WHERE "content_type" = 'text';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx" ON "messages" USING gin ("content" gin_trgm_ops) WHERE "content_type" = 'text';--> statement-breakpoint

-- Comments (and replies — a reply is a comment with a parent) are always text.
CREATE INDEX IF NOT EXISTS "comments_content_trgm_idx" ON "comments" USING gin ("content" gin_trgm_ops);--> statement-breakpoint

-- People search matches a fragment of either name. Two separate indexes rather
-- than one over `username || display_name`: the columns are searched with
-- independent OR'd predicates, which the planner can serve as a bitmap OR of
-- both, and a concatenated expression index couldn't answer a query that only
-- touches one of them.
CREATE INDEX IF NOT EXISTS "users_username_trgm_idx" ON "users" USING gin ("username" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_display_name_trgm_idx" ON "users" USING gin ("display_name" gin_trgm_ops);
