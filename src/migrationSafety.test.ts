import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  checkMigration,
  invalidAllowDirectives,
  type MigrationRule,
} from "./migrationSafety.ts";

const BP = "--> statement-breakpoint";
const rules = (sql: string): MigrationRule[] =>
  checkMigration(sql).map((v) => v.rule);

describe("checkMigration", () => {
  test.each<[MigrationRule, string]>([
    ["drop-table", `DROP TABLE "game_votes";`],
    ["drop-table", `DROP TABLE IF EXISTS "game_votes" CASCADE;`],
    ["drop-column", `ALTER TABLE "posts" DROP COLUMN "legacy";`],
    ["drop-column", `ALTER TABLE "posts" DROP COLUMN IF EXISTS "legacy";`],
    ["rename", `ALTER TABLE "posts" RENAME COLUMN "body" TO "content";`],
    ["rename", `ALTER TABLE "posts" RENAME TO "articles";`],
    [
      "column-type",
      `ALTER TABLE "posts" ALTER COLUMN "id" SET DATA TYPE bigint;`,
    ],
    ["column-type", `ALTER TABLE posts ALTER COLUMN id TYPE bigint;`],
    ["set-not-null", `ALTER TABLE "users" ALTER COLUMN "bio" SET NOT NULL;`],
    ["drop-default", `ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;`],
    [
      "not-null-without-default",
      `ALTER TABLE "users" ADD COLUMN "tier" text NOT NULL;`,
    ],
    [
      "new-constraint",
      `ALTER TABLE "likes" ADD CONSTRAINT "one" CHECK ("n" > 0);`,
    ],
    [
      "new-constraint",
      `ALTER TABLE "likes" ADD CONSTRAINT "u" UNIQUE("user_id","emoji");`,
    ],
    [
      "new-constraint",
      `CREATE UNIQUE INDEX "u_idx" ON "posts" USING btree ("author_id","x");`,
    ],
  ])("flags %s: %s", (rule, sql) => {
    expect(rules(sql)).toEqual([rule]);
  });

  test.each([
    // What expand migrations look like.
    `ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp;`,
    `ALTER TABLE "chats" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;`,
    `ALTER TABLE "likes" ADD COLUMN "emoji" text DEFAULT '👍' NOT NULL;`,
    `ALTER TABLE "posts" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED NOT NULL;`,
    `ALTER TABLE "likes" ADD CONSTRAINT "likes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade;`,
    `CREATE INDEX "posts_author_idx" ON "posts" USING btree ("author_id");`,
    `ALTER TABLE "likes" DROP CONSTRAINT "likes_exactly_one_target";`,
    `ALTER INDEX "a" RENAME TO "b";`,
    // Text that only looks like a breaking change.
    `UPDATE "posts" SET "content" = 'DROP TABLE users';`,
    `-- We used to DROP COLUMN here.\nCREATE INDEX "x" ON "posts" ("id");`,
    `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'ALTER TABLE t DROP COLUMN c'; DROP TABLE tmp; RETURN NULL; END; $$;`,
    `CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $body$ DROP TABLE tmp $body$;`,
  ])("passes: %s", (sql) => {
    expect(rules(sql)).toEqual([]);
  });

  test("a second statement in the same chunk is checked too", () => {
    expect(
      rules(`CREATE INDEX "x" ON "posts" ("id");\nDROP TABLE "old";`),
    ).toEqual(["drop-table"]);
  });

  test("constraints and unique indexes on a table created in the same migration pass", () => {
    const sql = [
      `CREATE TABLE "game_votes" ("id" serial PRIMARY KEY NOT NULL, "voter_id" integer NOT NULL);`,
      `ALTER TABLE "game_votes" ADD CONSTRAINT "one_vote" UNIQUE("voter_id");`,
      `CREATE UNIQUE INDEX "votes_idx" ON "game_votes" USING btree ("voter_id");`,
    ].join(BP);
    expect(rules(sql)).toEqual([]);
  });

  test("an allow directive with a reason covers only its own statement and rule", () => {
    const sql = [
      `-- migration-safety: allow drop-column (unused since 0.42.0)\nALTER TABLE "posts" DROP COLUMN "legacy";`,
      `\nALTER TABLE "posts" DROP COLUMN "older";`,
      `-- migration-safety: allow rename (wrong rule)\nALTER TABLE "users" DROP COLUMN "bio";`,
    ].join(BP);
    expect(checkMigration(sql).map((v) => [v.rule, v.statement])).toEqual([
      ["drop-column", `ALTER TABLE "posts" DROP COLUMN "older";`],
      [
        "drop-column",
        `-- migration-safety: allow rename (wrong rule)\nALTER TABLE "users" DROP COLUMN "bio";`,
      ],
    ]);
  });

  test("an allow directive without a reason allows nothing, and is reported", () => {
    const sql = `-- migration-safety: allow drop-column\nALTER TABLE "posts" DROP COLUMN "legacy";`;
    expect(rules(sql)).toEqual(["drop-column"]);
    expect(invalidAllowDirectives(sql)).toEqual([
      "-- migration-safety: allow drop-column",
    ]);
  });

  test("an allow directive naming no known rule is reported", () => {
    expect(
      invalidAllowDirectives(
        `-- migration-safety: allow drop-everything (yolo)\nSELECT 1;`,
      ),
    ).toEqual(["-- migration-safety: allow drop-everything (yolo)"]);
  });
});

// Migrations before this one predate the check. Several of them would fail
// it (0002's DROP DEFAULT, 0010's and 0015's new constraints) and they're
// applied everywhere, so they're left as they are rather than annotated.
const FIRST_CHECKED_MIGRATION = 42;

const drizzleDir = new URL("../drizzle/", import.meta.url);
const checkedMigrations = readdirSync(drizzleDir)
  .filter((file) => /^\d{4}_.*\.sql$/.test(file))
  .filter((file) => Number(file.slice(0, 4)) >= FIRST_CHECKED_MIGRATION)
  .sort();

describe("drizzle/ migrations stay safe for a rolling deploy", () => {
  test("the baseline is no later than the next migration", () => {
    const numbers = readdirSync(drizzleDir)
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .map((file) => Number(file.slice(0, 4)));
    expect(FIRST_CHECKED_MIGRATION).toBeLessThanOrEqual(
      Math.max(...numbers) + 1,
    );
  });

  // A failure here means old replicas would break against this schema
  // while the deploy rolls out. Split the change into an expand migration
  // now and a contract one in a later release (see src/migrationSafety.ts),
  // or, if no deployed release uses what it changes any more, mark the
  // statement with `-- migration-safety: allow <rule> (<why>)`.
  test("no migration from the baseline on breaks old replicas", async () => {
    const problems: Record<string, string[]> = {};
    for (const file of checkedMigrations) {
      const source = await Bun.file(new URL(file, drizzleDir)).text();
      const found = [
        ...invalidAllowDirectives(source).map(
          (line) => `invalid directive: ${line}`,
        ),
        ...checkMigration(source).map(
          (v) => `${v.rule}: ${v.statement.split("\n").at(-1)}`,
        ),
      ];
      if (found.length > 0) problems[file] = found;
    }
    expect(problems).toEqual({});
  });
});
