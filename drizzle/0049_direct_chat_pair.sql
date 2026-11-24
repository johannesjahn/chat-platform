ALTER TABLE "chats" ADD COLUMN "direct_user_low" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "direct_user_high" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_direct_user_low_users_id_fk" FOREIGN KEY ("direct_user_low") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_direct_user_high_users_id_fk" FOREIGN KEY ("direct_user_high") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "chats" SET "direct_user_low" = pair."low", "direct_user_high" = pair."high"
FROM (
	SELECT DISTINCT ON ("low", "high") "chat_id", "low", "high"
	FROM (
		SELECT cp."chat_id", min(cp."user_id") AS "low", max(cp."user_id") AS "high"
		FROM "chat_participants" cp
		JOIN "chats" c ON c."id" = cp."chat_id" AND c."type" = 'direct'
		GROUP BY cp."chat_id"
		HAVING count(*) = 2
	) pairs
	ORDER BY "low", "high", "chat_id"
) pair
WHERE pair."chat_id" = "chats"."id";--> statement-breakpoint
-- migration-safety: allow new-constraint (nullable columns added above, which old replicas never write)
CREATE UNIQUE INDEX "chats_direct_pair_idx" ON "chats" USING btree ("direct_user_low","direct_user_high");--> statement-breakpoint
CREATE INDEX "chats_direct_user_high_idx" ON "chats" USING btree ("direct_user_high");--> statement-breakpoint
-- migration-safety: allow new-constraint (nullable columns added above, which old replicas never write)
ALTER TABLE "chats" ADD CONSTRAINT "chats_direct_pair_ordered" CHECK ("chats"."direct_user_low" < "chats"."direct_user_high");