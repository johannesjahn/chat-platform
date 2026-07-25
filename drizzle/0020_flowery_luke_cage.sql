CREATE TABLE "pinned_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"pinned_by" integer,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "starred_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "starred_messages_user_id_message_id_unique" UNIQUE("user_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starred_messages" ADD CONSTRAINT "starred_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starred_messages" ADD CONSTRAINT "starred_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pinned_messages_message_id_idx" ON "pinned_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "pinned_messages_chat_id_idx" ON "pinned_messages" USING btree ("chat_id","id");--> statement-breakpoint
CREATE INDEX "starred_messages_message_id_idx" ON "starred_messages" USING btree ("message_id");