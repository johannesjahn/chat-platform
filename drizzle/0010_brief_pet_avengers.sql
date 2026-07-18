ALTER TABLE "likes" DROP CONSTRAINT "likes_user_post_unique";--> statement-breakpoint
ALTER TABLE "likes" DROP CONSTRAINT "likes_user_comment_unique";--> statement-breakpoint
ALTER TABLE "likes" ADD COLUMN "emoji" text DEFAULT '👍' NOT NULL;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_post_emoji_unique" UNIQUE("user_id","post_id","emoji");--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_comment_emoji_unique" UNIQUE("user_id","comment_id","emoji");