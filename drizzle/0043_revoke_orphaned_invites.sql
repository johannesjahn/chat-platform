-- Issue #894: an invite link is revoked once its creator leaves the group, is
-- removed from it or loses their admin role. Links made before that rule are
-- revoked here if their creator is no longer an owner/admin of the chat (a
-- site admin's links stay, as a site admin can manage any chat).
UPDATE "chat_invites" SET "revoked_at" = now()
WHERE "revoked_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "chat_participants"
    WHERE "chat_participants"."chat_id" = "chat_invites"."chat_id"
      AND "chat_participants"."user_id" = "chat_invites"."created_by"
      AND "chat_participants"."role" IN ('owner', 'admin')
  )
  AND NOT EXISTS (
    SELECT 1 FROM "users"
    WHERE "users"."id" = "chat_invites"."created_by" AND "users"."role" = 'admin'
  );
