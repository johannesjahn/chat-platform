ALTER TABLE "likes" DROP CONSTRAINT "likes_exactly_one_target";--> statement-breakpoint
ALTER TABLE "likes" ADD COLUMN "message_id" integer;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "likes_message_id_idx" ON "likes" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_message_emoji_unique" UNIQUE("user_id","message_id","emoji");--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_exactly_one_target" CHECK ((
        (CASE WHEN "likes"."post_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "likes"."comment_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "likes"."message_id" IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1);