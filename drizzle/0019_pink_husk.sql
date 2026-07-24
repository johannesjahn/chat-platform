-- Threaded/quoted message replies (issue #217). A nullable self-referencing
-- FK on `messages` pointing at the message a reply quotes. `ON DELETE set null`
-- (not cascade) so deleting a quoted message leaves its replies intact — the
-- quoted preview just disappears client-side — rather than removing the whole
-- thread. Additive/backward-compatible per the expand-contract note in
-- CLAUDE.md: existing rows get NULL (i.e. "not a reply").
ALTER TABLE "messages" ADD COLUMN "parent_message_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_parent_message_id_idx" ON "messages" USING btree ("parent_message_id");