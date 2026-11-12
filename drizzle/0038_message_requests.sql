ALTER TABLE "chat_participants" ADD COLUMN "request_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD COLUMN "added_by" integer;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;