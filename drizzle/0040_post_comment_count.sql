ALTER TABLE "posts" ADD COLUMN "comment_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Issue #835: posts.comment_count is kept by these triggers rather than
-- counted on every feed read. A row-level trigger also fires for rows a
-- cascade removes (a deleted comment's replies, a deleted account's
-- comments), so every path stays counted. When the post itself is being
-- deleted, the cascaded comments' UPDATE simply finds no row.
CREATE FUNCTION "posts_comment_count_bump"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "posts" SET "comment_count" = "comment_count" + 1 WHERE "id" = NEW."post_id";
    RETURN NEW;
  END IF;
  UPDATE "posts" SET "comment_count" = GREATEST("comment_count" - 1, 0) WHERE "id" = OLD."post_id";
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "comments_count_insert" AFTER INSERT ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "posts_comment_count_bump"();--> statement-breakpoint
CREATE TRIGGER "comments_count_delete" AFTER DELETE ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "posts_comment_count_bump"();--> statement-breakpoint
-- Backfill. No comment can land between this and the triggers: the
-- migration commits as one transaction, and the ALTER TABLE above holds an
-- exclusive lock on "posts" until then, which a comment insert's foreign-key
-- check (a key-share lock on its post) waits for.
UPDATE "posts" SET "comment_count" = counts."total"
FROM (SELECT "post_id", count(*)::integer AS "total" FROM "comments" GROUP BY "post_id") AS counts
WHERE counts."post_id" = "posts"."id";
