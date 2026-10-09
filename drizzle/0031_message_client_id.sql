ALTER TABLE "messages" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_idx" ON "messages" USING btree ("chat_id","sender_id","client_id");