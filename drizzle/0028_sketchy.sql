CREATE TABLE "game_bluffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"drawing_id" integer NOT NULL,
	"author_id" integer NOT NULL,
	"text" text NOT NULL,
	"normalized" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "game_bluffs_drawing_id_author_id_unique" UNIQUE("drawing_id","author_id"),
	CONSTRAINT "game_bluffs_drawing_id_normalized_unique" UNIQUE("drawing_id","normalized")
);
--> statement-breakpoint
CREATE TABLE "game_drawings" (
	"id" serial PRIMARY KEY NOT NULL,
	"lobby_id" integer NOT NULL,
	"artist_id" integer NOT NULL,
	"turn" integer NOT NULL,
	"position" integer NOT NULL,
	"prompt" text NOT NULL,
	"shuffle_seed" integer NOT NULL,
	"strokes" jsonb,
	"submitted_at" timestamp,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "game_drawings_lobby_id_turn_artist_id_unique" UNIQUE("lobby_id","turn","artist_id"),
	CONSTRAINT "game_drawings_lobby_id_prompt_unique" UNIQUE("lobby_id","prompt")
);
--> statement-breakpoint
CREATE TABLE "game_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"drawing_id" integer NOT NULL,
	"voter_id" integer NOT NULL,
	"bluff_id" integer,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "game_votes_drawing_id_voter_id_unique" UNIQUE("drawing_id","voter_id")
);
--> statement-breakpoint
ALTER TABLE "game_lobbies" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "game_lobbies" ADD COLUMN "settled_round" integer;--> statement-breakpoint
ALTER TABLE "game_bluffs" ADD CONSTRAINT "game_bluffs_drawing_id_game_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."game_drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_bluffs" ADD CONSTRAINT "game_bluffs_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_drawings" ADD CONSTRAINT "game_drawings_lobby_id_game_lobbies_id_fk" FOREIGN KEY ("lobby_id") REFERENCES "public"."game_lobbies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_drawings" ADD CONSTRAINT "game_drawings_artist_id_users_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_drawing_id_game_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."game_drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_bluff_id_game_bluffs_id_fk" FOREIGN KEY ("bluff_id") REFERENCES "public"."game_bluffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_bluffs_author_id_idx" ON "game_bluffs" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "game_drawings_artist_id_idx" ON "game_drawings" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "game_votes_voter_id_idx" ON "game_votes" USING btree ("voter_id");--> statement-breakpoint
CREATE INDEX "game_votes_bluff_id_idx" ON "game_votes" USING btree ("bluff_id");