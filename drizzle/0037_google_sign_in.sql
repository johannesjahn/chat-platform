ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_credential_check" CHECK ("users"."password_hash" IS NOT NULL OR "users"."google_sub" IS NOT NULL);