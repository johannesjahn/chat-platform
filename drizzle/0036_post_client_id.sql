ALTER TABLE "posts" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_client_id_idx" ON "posts" USING btree ("author_id","client_id");