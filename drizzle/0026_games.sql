CREATE TABLE "game_lobbies" (
	"id" serial PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"host_id" integer NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"passage" text,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"max_players" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_lobby_players" (
	"id" serial PRIMARY KEY NOT NULL,
	"lobby_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"joined_at" timestamp NOT NULL,
	"duration_ms" integer,
	"score" double precision,
	"accuracy" double precision,
	"place" integer,
	CONSTRAINT "game_lobby_players_lobby_id_user_id_unique" UNIQUE("lobby_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "game_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"user_id" integer NOT NULL,
	"lobby_id" integer,
	"round" integer NOT NULL,
	"score" double precision NOT NULL,
	"accuracy" double precision NOT NULL,
	"duration_ms" integer NOT NULL,
	"place" integer NOT NULL,
	"player_count" integer NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_lobbies" ADD CONSTRAINT "game_lobbies_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_lobby_players" ADD CONSTRAINT "game_lobby_players_lobby_id_game_lobbies_id_fk" FOREIGN KEY ("lobby_id") REFERENCES "public"."game_lobbies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_lobby_players" ADD CONSTRAINT "game_lobby_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_lobbies_game_updated_at_idx" ON "game_lobbies" USING btree ("game","updated_at");--> statement-breakpoint
CREATE INDEX "game_lobbies_host_id_idx" ON "game_lobbies" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "game_lobby_players_user_id_idx" ON "game_lobby_players" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_results_game_created_at_idx" ON "game_results" USING btree ("game","created_at");--> statement-breakpoint
CREATE INDEX "game_results_user_id_idx" ON "game_results" USING btree ("user_id");