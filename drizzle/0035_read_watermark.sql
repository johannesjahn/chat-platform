ALTER TABLE "chat_participants" ADD COLUMN "last_read_message_id" integer;--> statement-breakpoint
-- Back-fill each participant's watermark from the newest message they have a
-- read row for (issue #659). `markRead` always read a whole prefix of the chat,
-- so the max is the watermark that prefix implies.
UPDATE "chat_participants" AS cp
SET "last_read_message_id" = r."max_id"
FROM (
	SELECT m."chat_id", mr."user_id", max(mr."message_id") AS "max_id"
	FROM "message_reads" mr
	INNER JOIN "messages" m ON m."id" = mr."message_id"
	GROUP BY m."chat_id", mr."user_id"
) AS r
WHERE cp."chat_id" = r."chat_id" AND cp."user_id" = r."user_id";
