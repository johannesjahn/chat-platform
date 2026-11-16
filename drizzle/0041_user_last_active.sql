ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp;--> statement-breakpoint
-- Issue #831: users.last_active_at is moved forward by these triggers when
-- someone creates content, so DAU/WAU/MAU count one column instead of the
-- distinct authors of every content table. Only when it's 15 minutes
-- (ACTIVITY_RESOLUTION in src/ActiveUsersMetrics.ts) behind the new row:
-- otherwise the UPDATE matches nothing and writes and locks nothing, which
-- is every insert but a user's first in a quarter hour. Uses the row's own
-- created_at, the timestamp the windows were always measured against, and
-- never moves the column backwards for an older row.
CREATE FUNCTION "users_touch_last_active"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor integer;
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    actor := NEW."sender_id";
  ELSIF TG_TABLE_NAME = 'likes' THEN
    actor := NEW."user_id";
  ELSE
    actor := NEW."author_id";
  END IF;
  UPDATE "users" SET "last_active_at" = NEW."created_at"
  WHERE "id" = actor
    AND ("last_active_at" IS NULL OR "last_active_at" < NEW."created_at" - interval '15 minutes');
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "posts_touch_last_active" AFTER INSERT ON "posts"
  FOR EACH ROW EXECUTE FUNCTION "users_touch_last_active"();--> statement-breakpoint
CREATE TRIGGER "comments_touch_last_active" AFTER INSERT ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "users_touch_last_active"();--> statement-breakpoint
CREATE TRIGGER "likes_touch_last_active" AFTER INSERT ON "likes"
  FOR EACH ROW EXECUTE FUNCTION "users_touch_last_active"();--> statement-breakpoint
CREATE TRIGGER "messages_touch_last_active" AFTER INSERT ON "messages"
  FOR EACH ROW EXECUTE FUNCTION "users_touch_last_active"();--> statement-breakpoint
-- Backfill the longest window (30 days, plus a day of slack). Nothing can
-- be inserted between this and the triggers: the migration commits as one
-- transaction, and the ALTER TABLE above holds an exclusive lock on "users"
-- until then, which every content insert's foreign-key check waits for.
-- This is the last time these tables are scanned for it.
UPDATE "users" SET "last_active_at" = latest."at"
FROM (
  SELECT "user_id", max("at") AS "at" FROM (
    SELECT "author_id" AS "user_id", max("created_at") AS "at" FROM "posts"
      WHERE "created_at" >= (now() AT TIME ZONE 'UTC') - interval '31 days' GROUP BY 1
    UNION ALL
    SELECT "author_id", max("created_at") FROM "comments"
      WHERE "created_at" >= (now() AT TIME ZONE 'UTC') - interval '31 days' GROUP BY 1
    UNION ALL
    SELECT "user_id", max("created_at") FROM "likes"
      WHERE "created_at" >= (now() AT TIME ZONE 'UTC') - interval '31 days' GROUP BY 1
    UNION ALL
    SELECT "sender_id", max("created_at") FROM "messages"
      WHERE "created_at" >= (now() AT TIME ZONE 'UTC') - interval '31 days' GROUP BY 1
  ) AS "per_table"
  GROUP BY "user_id"
) AS latest
WHERE latest."user_id" = "users"."id";
