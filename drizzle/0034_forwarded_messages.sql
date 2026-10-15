ALTER TABLE "messages" ADD COLUMN "forwarded_from_message_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "forwarded_from_sender_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "forwarded_from_sender_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_message_id_messages_id_fk" FOREIGN KEY ("forwarded_from_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_sender_id_users_id_fk" FOREIGN KEY ("forwarded_from_sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_forwarded_from_message_id_idx" ON "messages" USING btree ("forwarded_from_message_id");--> statement-breakpoint
CREATE INDEX "messages_forwarded_from_sender_id_idx" ON "messages" USING btree ("forwarded_from_sender_id");