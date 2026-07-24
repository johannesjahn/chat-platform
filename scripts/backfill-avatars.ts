/**
 * One-shot backfill: move uploaded avatars from the legacy inline-base64
 * `users.avatar_small`/`avatar_medium`/`avatar_large` columns into the
 * S3-compatible object store, populating the new `avatar_*_key` columns
 * (issue #289).
 *
 * Usage:  bun run db:migrate            # add the *_key columns first
 *         bun run scripts/backfill-avatars.ts
 *
 * Requires the same DB config as the app (DATABASE_URL for real Postgres,
 * PGlite fallback otherwise) and, for anything beyond a throwaway local run, a
 * configured S3-compatible endpoint (S3_ENDPOINT etc. — see
 * src/AttachmentStorage.ts); with no endpoint set the in-memory fallback
 * "stores" bytes in this short-lived process and they'd vanish on exit, so the
 * script refuses that combination.
 *
 * Idempotent and safe to re-run: it only touches rows that still have a legacy
 * base64 avatar but no `avatar_small_key` yet, and does NOT drop or null the
 * old columns — that's left to a later expand-contract migration once every
 * replica reads the `*_key` columns (see CLAUDE.md / db/schema.ts).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleBunSql } from "drizzle-orm/bun-sql";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Effect } from "effect";
import {
  AttachmentStorage,
  AttachmentStorageLive,
} from "../src/AttachmentStorage.ts";
import { avatarStorageKey, generateAvatarToken } from "../src/avatars.ts";
import type { DrizzleDb } from "../src/Db.ts";
import * as schema from "../src/db/schema.ts";

const { users } = schema;

// Splits a stored `data:<mime>;base64,<payload>` value into its bytes and
// content type. The legacy `uploadAvatar` only ever wrote WebP data URLs, so
// this is deliberately strict — anything else is surfaced as an error to
// investigate rather than silently uploaded under a wrong type.
const decodeDataUrl = (
  value: string,
): { data: Uint8Array; contentType: string } => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) {
    throw new Error(`Not a base64 data URL: ${value.slice(0, 32)}…`);
  }
  return {
    contentType: match[1]!,
    data: new Uint8Array(Buffer.from(match[2]!, "base64")),
  };
};

const connectDb = async (): Promise<DrizzleDb> => {
  if (process.env.DATABASE_URL) {
    return drizzleBunSql(process.env.DATABASE_URL, { schema });
  }
  const client = await PGlite.create(process.env.DB_PATH);
  return drizzlePglite({ client, schema });
};

if (!process.env.S3_ENDPOINT) {
  console.error(
    "[backfill-avatars] S3_ENDPOINT is not set — the in-memory storage " +
      "fallback would drop every uploaded object when this process exits. " +
      "Configure the S3-compatible endpoint before backfilling.",
  );
  process.exit(1);
}

const db = await connectDb();

const program = Effect.gen(function* () {
  const storage = yield* AttachmentStorage;

  const rows = yield* Effect.promise(() =>
    db
      .select({
        id: users.id,
        avatarSmall: users.avatarSmall,
        avatarMedium: users.avatarMedium,
        avatarLarge: users.avatarLarge,
      })
      .from(users)
      .where(and(isNull(users.avatarSmallKey), isNotNull(users.avatarSmall))),
  );

  console.log(`[backfill-avatars] ${rows.length} avatar(s) to migrate.`);
  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    // All three variants are always written together, so a row missing one is
    // malformed — skip (rather than backfill a half avatar) and report it.
    if (!row.avatarSmall || !row.avatarMedium || !row.avatarLarge) {
      console.warn(
        `[backfill-avatars] user ${row.id}: incomplete variant set, skipping.`,
      );
      skipped += 1;
      continue;
    }

    const variants = [
      { data: decodeDataUrl(row.avatarSmall), token: generateAvatarToken() },
      { data: decodeDataUrl(row.avatarMedium), token: generateAvatarToken() },
      { data: decodeDataUrl(row.avatarLarge), token: generateAvatarToken() },
    ];

    yield* Effect.all(
      variants.map((v) =>
        storage.upload(
          avatarStorageKey(v.token),
          v.data.data,
          v.data.contentType,
        ),
      ),
      { concurrency: "unbounded" },
    ).pipe(Effect.orDie);

    // Only the `*_key` columns are set — the legacy base64 columns are left
    // in place for old replicas mid-rollout and dropped by a later migration.
    yield* Effect.promise(() =>
      db
        .update(users)
        .set({
          avatarSmallKey: variants[0]!.token,
          avatarMediumKey: variants[1]!.token,
          avatarLargeKey: variants[2]!.token,
        })
        .where(eq(users.id, row.id)),
    );
    migrated += 1;
  }

  console.log(
    `[backfill-avatars] done — ${migrated} migrated, ${skipped} skipped.`,
  );
});

await Effect.runPromise(program.pipe(Effect.provide(AttachmentStorageLive)));
process.exit(0);
