ALTER TABLE "refresh_tokens" ADD COLUMN "family_id" text NOT NULL DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "family_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" USING btree ("family_id");