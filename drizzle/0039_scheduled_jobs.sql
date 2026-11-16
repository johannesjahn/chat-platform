CREATE TABLE "scheduled_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp NOT NULL,
	"result" jsonb
);
