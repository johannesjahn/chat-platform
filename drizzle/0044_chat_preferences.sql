ALTER TABLE "chat_participants" ADD COLUMN "muted_until" timestamp;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD COLUMN "pinned_at" timestamp;