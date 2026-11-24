-- migration-safety: allow drop-column (avatars have lived in object storage since #289; the only instance is a dev one with disposable data)
ALTER TABLE "users" DROP COLUMN "avatar_small";--> statement-breakpoint
-- migration-safety: allow drop-column (avatars have lived in object storage since #289; the only instance is a dev one with disposable data)
ALTER TABLE "users" DROP COLUMN "avatar_medium";--> statement-breakpoint
-- migration-safety: allow drop-column (avatars have lived in object storage since #289; the only instance is a dev one with disposable data)
ALTER TABLE "users" DROP COLUMN "avatar_large";