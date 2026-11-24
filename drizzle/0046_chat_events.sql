CREATE TABLE "chat_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"after_message_id" integer NOT NULL,
	"type" text NOT NULL,
	"actor_id" integer,
	"target_id" integer,
	"detail" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_events_chat_id_idx" ON "chat_events" USING btree ("chat_id","id");--> statement-breakpoint
CREATE INDEX "chat_events_actor_id_idx" ON "chat_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "chat_events_target_id_idx" ON "chat_events" USING btree ("target_id");