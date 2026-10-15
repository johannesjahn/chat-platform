-- Per-user storage counter for the upload quota (issue #326).
--
-- `enforceUploadQuota` used to run `SUM(size)` over every attachment the
-- uploader ever kept, on every upload — a cost that grows with the user's
-- history. It now reads this one column instead.
--
-- The counter is maintained by a trigger rather than by the handlers, so
-- every path that changes `attachments` keeps it exact: an upload, a
-- `DELETE /attachments/:id`, the orphan sweep (AttachmentCleanup.ts), a
-- cascade, a test's direct insert — and, mid-rollout, replicas still on the
-- old code, which know nothing about the column.
ALTER TABLE "users" ADD COLUMN "storage_used_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "attachments_track_storage_used"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE "users" SET "storage_used_bytes" = "storage_used_bytes" - OLD."size"
      WHERE "id" = OLD."uploader_id";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE "users" SET "storage_used_bytes" = "storage_used_bytes" + NEW."size"
      WHERE "id" = NEW."uploader_id";
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
-- Created before the backfill below: CREATE TRIGGER locks `attachments`
-- against writes until this migration commits, so no upload can land
-- between the sum being taken and the trigger taking over.
CREATE TRIGGER "attachments_track_storage_used"
  AFTER INSERT OR DELETE OR UPDATE OF "size", "uploader_id" ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION "attachments_track_storage_used"();--> statement-breakpoint
UPDATE "users" SET "storage_used_bytes" = "totals"."bytes"
  FROM (
    SELECT "uploader_id", SUM("size") AS "bytes"
    FROM "attachments"
    GROUP BY "uploader_id"
  ) AS "totals"
  WHERE "users"."id" = "totals"."uploader_id";
