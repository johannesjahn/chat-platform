ALTER TABLE "comments" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
-- Issue #904: a soft-deleted comment (the placeholder its replies hang off)
-- isn't counted in posts.comment_count. It comes off the count when it's
-- soft-deleted, so the hard delete that follows its last reply mustn't take
-- it off again. No row is soft-deleted before this migration, so the stored
-- counts need no backfill.
CREATE OR REPLACE FUNCTION "posts_comment_count_bump"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."deleted_at" IS NULL THEN
      UPDATE "posts" SET "comment_count" = "comment_count" + 1 WHERE "id" = NEW."post_id";
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL THEN
      UPDATE "posts" SET "comment_count" = GREATEST("comment_count" - 1, 0) WHERE "id" = NEW."post_id";
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."deleted_at" IS NULL THEN
    UPDATE "posts" SET "comment_count" = GREATEST("comment_count" - 1, 0) WHERE "id" = OLD."post_id";
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "comments_count_soft_delete" AFTER UPDATE OF "deleted_at" ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "posts_comment_count_bump"();
