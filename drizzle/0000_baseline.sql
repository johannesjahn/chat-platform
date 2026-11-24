-- The whole schema up to issue #943, which squashed 53 migrations into this
-- one. Generated from src/db/schema.ts, then extended by hand with what
-- Drizzle doesn't model, marked "By hand" below. `drizzle-kit generate` leaves
-- those out, so carry them over if this is ever regenerated.

-- By hand: substring search. Trusted since PG13, so it needs no superuser;
-- PGlite has it registered at creation (`createPglite` in src/Db.ts).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"uploader_id" integer NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"blurhash" text,
	"waveform" jsonb,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"after_message_id" bigint NOT NULL,
	"type" text NOT NULL,
	"actor_id" integer,
	"target_id" integer,
	"detail" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"code" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"last_read_message_id" bigint,
	"request_pending" boolean DEFAULT false NOT NULL,
	"added_by" integer,
	"muted_until" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	CONSTRAINT "chat_participants_chat_id_user_id_unique" UNIQUE("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"created_by" integer,
	"direct_user_low" integer,
	"direct_user_high" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"avatar_small_key" text,
	"avatar_medium_key" text,
	"avatar_large_key" text,
	CONSTRAINT "chats_direct_pair_ordered" CHECK ("chats"."direct_user_low" < "chats"."direct_user_high")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"parent_comment_id" integer,
	"author_id" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "game_bluffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"drawing_id" integer NOT NULL,
	"author_id" integer NOT NULL,
	"text" text NOT NULL,
	"normalized" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
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
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "game_drawings_lobby_id_turn_artist_id_unique" UNIQUE("lobby_id","turn","artist_id"),
	CONSTRAINT "game_drawings_lobby_id_prompt_unique" UNIQUE("lobby_id","prompt")
);
--> statement-breakpoint
CREATE TABLE "game_lobbies" (
	"id" serial PRIMARY KEY NOT NULL,
	"game" text NOT NULL,
	"host_id" integer NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"passage" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"max_players" integer NOT NULL,
	"settings" jsonb,
	"settled_round" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_lobby_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"lobby_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_lobby_players" (
	"id" serial PRIMARY KEY NOT NULL,
	"lobby_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"score" double precision,
	"accuracy" double precision,
	"place" integer,
	"detail" jsonb,
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
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"drawing_id" integer NOT NULL,
	"voter_id" integer NOT NULL,
	"bluff_id" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "game_votes_drawing_id_voter_id_unique" UNIQUE("drawing_id","voter_id")
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"post_id" integer,
	"comment_id" integer,
	"message_id" bigint,
	"emoji" text DEFAULT '👍' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "likes_user_post_emoji_unique" UNIQUE("user_id","post_id","emoji"),
	CONSTRAINT "likes_user_comment_emoji_unique" UNIQUE("user_id","comment_id","emoji"),
	CONSTRAINT "likes_user_message_emoji_unique" UNIQUE("user_id","message_id","emoji"),
	CONSTRAINT "likes_exactly_one_target" CHECK ((
        (CASE WHEN "likes"."post_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "likes"."comment_id" IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "likes"."message_id" IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"sender_id" integer NOT NULL,
	"body" text NOT NULL,
	"attachment_id" integer,
	"parent_message_id" bigint,
	"client_id" text,
	"forwarded_from_message_id" bigint,
	"forwarded_from_sender_id" integer,
	"forwarded_from_sender_name" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "notification_preferences_user_id_type_pk" PRIMARY KEY("user_id","type")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"actor_id" integer NOT NULL,
	"type" text NOT NULL,
	"post_id" integer,
	"comment_id" integer,
	"emoji" text,
	"game" text,
	"lobby_id" integer,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinned_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"message_id" bigint NOT NULL,
	"pinned_by" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" integer NOT NULL,
	"body" text NOT NULL,
	"attachment_id" integer,
	"client_id" text,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"jti" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"family_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "starred_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"message_id" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "starred_messages_user_id_message_id_unique" UNIQUE("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"blocker_id" integer NOT NULL,
	"blocked_id" integer NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_blocks_blocker_id_blocked_id_unique" UNIQUE("blocker_id","blocked_id"),
	CONSTRAINT "user_blocks_no_self" CHECK ("user_blocks"."blocker_id" <> "user_blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"avatar_small_key" text,
	"avatar_medium_key" text,
	"avatar_large_key" text,
	"role" text DEFAULT 'user' NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"status_text" text,
	"status_emoji" text,
	"status_expires_at" timestamp with time zone,
	"bio" text,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_invites" ADD CONSTRAINT "chat_invites_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_invites" ADD CONSTRAINT "chat_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_direct_user_low_users_id_fk" FOREIGN KEY ("direct_user_low") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_direct_user_high_users_id_fk" FOREIGN KEY ("direct_user_high") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_bluffs" ADD CONSTRAINT "game_bluffs_drawing_id_game_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."game_drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_bluffs" ADD CONSTRAINT "game_bluffs_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_drawings" ADD CONSTRAINT "game_drawings_lobby_id_game_lobbies_id_fk" FOREIGN KEY ("lobby_id") REFERENCES "public"."game_lobbies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_drawings" ADD CONSTRAINT "game_drawings_artist_id_users_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_lobbies" ADD CONSTRAINT "game_lobbies_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_lobby_messages" ADD CONSTRAINT "game_lobby_messages_lobby_id_game_lobbies_id_fk" FOREIGN KEY ("lobby_id") REFERENCES "public"."game_lobbies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_lobby_messages" ADD CONSTRAINT "game_lobby_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_lobby_players" ADD CONSTRAINT "game_lobby_players_lobby_id_game_lobbies_id_fk" FOREIGN KEY ("lobby_id") REFERENCES "public"."game_lobbies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_lobby_players" ADD CONSTRAINT "game_lobby_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_drawing_id_game_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."game_drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_voter_id_users_id_fk" FOREIGN KEY ("voter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_votes" ADD CONSTRAINT "game_votes_bluff_id_game_bluffs_id_fk" FOREIGN KEY ("bluff_id") REFERENCES "public"."game_bluffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_message_id_messages_id_fk" FOREIGN KEY ("forwarded_from_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_sender_id_users_id_fk" FOREIGN KEY ("forwarded_from_sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starred_messages" ADD CONSTRAINT "starred_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starred_messages" ADD CONSTRAINT "starred_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_uploader_id_idx" ON "attachments" USING btree ("uploader_id");--> statement-breakpoint
CREATE INDEX "chat_events_chat_id_idx" ON "chat_events" USING btree ("chat_id","id");--> statement-breakpoint
CREATE INDEX "chat_events_actor_id_idx" ON "chat_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "chat_events_target_id_idx" ON "chat_events" USING btree ("target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_invites_code_idx" ON "chat_invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "chat_invites_chat_id_idx" ON "chat_invites" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chat_participants_user_id_idx" ON "chat_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_direct_pair_idx" ON "chats" USING btree ("direct_user_low","direct_user_high");--> statement-breakpoint
CREATE INDEX "chats_direct_user_high_idx" ON "chats" USING btree ("direct_user_high");--> statement-breakpoint
CREATE INDEX "comments_post_id_idx" ON "comments" USING btree ("post_id","id");--> statement-breakpoint
CREATE INDEX "comments_parent_comment_id_idx" ON "comments" USING btree ("parent_comment_id","id");--> statement-breakpoint
CREATE INDEX "comments_author_id_idx" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "game_bluffs_author_id_idx" ON "game_bluffs" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "game_drawings_artist_id_idx" ON "game_drawings" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "game_lobbies_game_updated_at_idx" ON "game_lobbies" USING btree ("game","updated_at");--> statement-breakpoint
CREATE INDEX "game_lobbies_host_id_idx" ON "game_lobbies" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "game_lobby_messages_lobby_id_id_idx" ON "game_lobby_messages" USING btree ("lobby_id","id");--> statement-breakpoint
CREATE INDEX "game_lobby_messages_user_id_idx" ON "game_lobby_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_lobby_players_user_id_idx" ON "game_lobby_players" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_results_game_created_at_idx" ON "game_results" USING btree ("game","created_at");--> statement-breakpoint
CREATE INDEX "game_results_user_id_idx" ON "game_results" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_votes_voter_id_idx" ON "game_votes" USING btree ("voter_id");--> statement-breakpoint
CREATE INDEX "game_votes_bluff_id_idx" ON "game_votes" USING btree ("bluff_id");--> statement-breakpoint
CREATE INDEX "likes_post_id_idx" ON "likes" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "likes_comment_id_idx" ON "likes" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "likes_message_id_idx" ON "likes" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_forwarded_from_message_id_idx" ON "messages" USING btree ("forwarded_from_message_id");--> statement-breakpoint
CREATE INDEX "messages_forwarded_from_sender_id_idx" ON "messages" USING btree ("forwarded_from_sender_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_idx" ON "messages" USING btree ("chat_id","sender_id","client_id");--> statement-breakpoint
CREATE INDEX "messages_chat_id_idx" ON "messages" USING btree ("chat_id","id");--> statement-breakpoint
CREATE INDEX "messages_sender_id_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "messages_attachment_id_idx" ON "messages" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "messages_parent_message_id_idx" ON "messages" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_id_idx" ON "notifications" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_actor_id_idx" ON "notifications" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "notifications_post_id_idx" ON "notifications" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "notifications_comment_id_idx" ON "notifications" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pinned_messages_message_id_idx" ON "pinned_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "pinned_messages_chat_id_idx" ON "pinned_messages" USING btree ("chat_id","id");--> statement-breakpoint
CREATE INDEX "posts_author_id_idx" ON "posts" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "posts_attachment_id_idx" ON "posts" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_client_id_idx" ON "posts" USING btree ("author_id","client_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "starred_messages_message_id_idx" ON "starred_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_id_idx" ON "user_blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" USING btree (lower("username"));--> statement-breakpoint

-- By hand: full-text search. Generated columns deliberately absent from the
-- Drizzle schema, where a bare `db.select()` would fetch them on every hot
-- read; SearchHandler.ts names them in raw SQL. The explicit config makes
-- `to_tsvector` immutable, which a generated column needs, and must stay equal
-- to `SEARCH_CONFIG` in search.ts.
ALTER TABLE "posts" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "body")) STORED;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "body")) STORED;--> statement-breakpoint
CREATE INDEX "posts_search_vector_idx" ON "posts" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "comments_search_vector_idx" ON "comments" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "messages_search_vector_idx" ON "messages" USING gin ("search_vector");--> statement-breakpoint

-- By hand: trigram indexes behind substring search. Two on users rather than
-- one over both names, since the names are searched as separate predicates.
CREATE INDEX "posts_body_trgm_idx" ON "posts" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "comments_content_trgm_idx" ON "comments" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_body_trgm_idx" ON "messages" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_username_trgm_idx" ON "users" USING gin ("username" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "users_display_name_trgm_idx" ON "users" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint

-- By hand: users.storage_used_bytes is the sum of the user's attachments
-- (issue #326). A trigger, so every path that changes them keeps it exact.
CREATE FUNCTION "attachments_track_storage_used"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE "users" SET "storage_used_bytes" = "storage_used_bytes" - OLD."size"
      WHERE "id" = OLD."uploader_id";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE "users" SET "storage_used_bytes" = "storage_used_bytes" + NEW."size"
      WHERE "id" = NEW."uploader_id";
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "attachments_track_storage_used"
  AFTER INSERT OR DELETE OR UPDATE OF "size", "uploader_id" ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION "attachments_track_storage_used"();--> statement-breakpoint

-- By hand: posts.comment_count (issues #835, #904). Row-level triggers also
-- fire for rows a cascade removes, so every path stays counted; when the post
-- itself is being deleted, the UPDATE finds no row. A soft-deleted comment
-- comes off the count when it's soft-deleted, so the hard delete that follows
-- mustn't take it off again.
CREATE FUNCTION "posts_comment_count_bump"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."deleted_at" IS NULL THEN
      UPDATE "posts" SET "comment_count" = "comment_count" + 1 WHERE "id" = NEW."post_id";
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NOT NULL THEN
      UPDATE "posts" SET "comment_count" = GREATEST("comment_count" - 1, 0) WHERE "id" = NEW."post_id";
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."deleted_at" IS NULL THEN
    UPDATE "posts" SET "comment_count" = GREATEST("comment_count" - 1, 0) WHERE "id" = OLD."post_id";
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "comments_count_insert" AFTER INSERT ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "posts_comment_count_bump"();--> statement-breakpoint
CREATE TRIGGER "comments_count_delete" AFTER DELETE ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "posts_comment_count_bump"();--> statement-breakpoint
CREATE TRIGGER "comments_count_soft_delete" AFTER UPDATE OF "deleted_at" ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "posts_comment_count_bump"();--> statement-breakpoint

-- By hand: users.last_active_at moves forward when someone creates content
-- (issue #831). Only when it's 15 minutes (ACTIVITY_RESOLUTION in
-- src/ActiveUsersMetrics.ts) behind the new row: otherwise the UPDATE matches
-- nothing and writes and locks nothing. Uses the row's own created_at, and
-- never moves the column backwards for an older row.
CREATE FUNCTION "users_touch_last_active"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor integer;
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    actor := NEW."sender_id";
  ELSIF TG_TABLE_NAME = 'likes' THEN
    actor := NEW."user_id";
  ELSE
    actor := NEW."author_id";
  END IF;
  UPDATE "users" SET "last_active_at" = NEW."created_at"
  WHERE "id" = actor
    AND ("last_active_at" IS NULL OR "last_active_at" < NEW."created_at" - interval '15 minutes');
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "posts_touch_last_active" AFTER INSERT ON "posts"
  FOR EACH ROW EXECUTE FUNCTION "users_touch_last_active"();--> statement-breakpoint
CREATE TRIGGER "comments_touch_last_active" AFTER INSERT ON "comments"
  FOR EACH ROW EXECUTE FUNCTION "users_touch_last_active"();--> statement-breakpoint
CREATE TRIGGER "likes_touch_last_active" AFTER INSERT ON "likes"
  FOR EACH ROW EXECUTE FUNCTION "users_touch_last_active"();--> statement-breakpoint
CREATE TRIGGER "messages_touch_last_active" AFTER INSERT ON "messages"
  FOR EACH ROW EXECUTE FUNCTION "users_touch_last_active"();
