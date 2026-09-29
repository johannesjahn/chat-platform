CREATE TABLE "game_lobby_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"lobby_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_lobby_messages" ADD CONSTRAINT "game_lobby_messages_lobby_id_game_lobbies_id_fk" FOREIGN KEY ("lobby_id") REFERENCES "public"."game_lobbies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_lobby_messages" ADD CONSTRAINT "game_lobby_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_lobby_messages_lobby_id_id_idx" ON "game_lobby_messages" USING btree ("lobby_id","id");--> statement-breakpoint
CREATE INDEX "game_lobby_messages_user_id_idx" ON "game_lobby_messages" USING btree ("user_id");