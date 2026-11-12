import { inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { AuthorSummary } from "./Api.ts";
import { toAvatarVariants } from "./avatars.ts";
import type { DrizzleDb } from "./Db.ts";
import { users } from "./db/schema.ts";

// The embedded `author` on every `Post`/`Comment` response (issue #750): one
// `WHERE id IN (...)` over the distinct author ids of a whole page, so a feed
// or a thread costs a single extra query however many authors it has — never
// a lookup per row, and never a client-side `GET /users/:id` per author.
//
// Posts and comments cascade with their author (db/schema.ts), so an id is
// only ever missing here when the account was deleted between reading the
// rows and this lookup; callers drop such a row from a list (it's about to
// vanish anyway) and treat a single one as not found.
export const authorSummaries = async (
  db: DrizzleDb,
  authorIds: ReadonlyArray<number>,
): Promise<Map<number, AuthorSummary>> => {
  const result = new Map<number, AuthorSummary>();
  const ids = [...new Set(authorIds)];
  if (ids.length === 0) return result;
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      avatarSmallKey: users.avatarSmallKey,
      avatarMediumKey: users.avatarMediumKey,
      avatarLargeKey: users.avatarLargeKey,
    })
    .from(users)
    .where(inArray(users.id, ids));
  for (const row of rows)
    result.set(row.id, {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      avatarVariants: toAvatarVariants(row),
    });
  return result;
};

// `authorSummaries` as an Effect — a failed read is a bug, not a domain
// outcome, so it dies like the handlers' other queries.
export const loadAuthors = (
  db: DrizzleDb,
  authorIds: ReadonlyArray<number>,
): Effect.Effect<Map<number, AuthorSummary>> =>
  Effect.tryPromise(() => authorSummaries(db, authorIds)).pipe(Effect.orDie);

// One row's author, or `onMissing`'s error (see `authorSummaries` for when
// that can happen).
export const loadAuthor = <E>(
  db: DrizzleDb,
  authorId: number,
  onMissing: () => E,
): Effect.Effect<AuthorSummary, E> =>
  loadAuthors(db, [authorId]).pipe(
    Effect.flatMap((authors) => {
      const author = authors.get(authorId);
      return author ? Effect.succeed(author) : Effect.fail(onMissing());
    }),
  );
