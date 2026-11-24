import {
  and,
  count,
  eq,
  inArray,
  isNull,
  notExists,
  notInArray,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { type Attachment, type AuthorSummary } from "./Api.ts";
import { loadAuthors } from "./authors.ts";
import { type DrizzleDb } from "./Db.ts";
import { type ReactionSummary } from "./reactions.ts";
import { comments, type DbPost, posts } from "./db/schema.ts";

export const NO_REACTIONS: ReactionSummary[] = [];

// `author` is the post's embedded byline (issue #750), resolved by the caller
// in one batch per response — see authors.ts.
export const toApiPost = (
  row: typeof posts.$inferSelect,
  author: AuthorSummary,
  reactions: ReadonlyArray<ReactionSummary> = NO_REACTIONS,
  attachment: Attachment | null = null,
  commentCount = 0,
) => ({
  id: row.id,
  authorId: row.authorId,
  author,
  body: row.body,
  attachment,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  reactions: [...reactions],
  commentCount,
});

// Total comments (top-level *and* replies) per post for a batch of ids. Read
// from the stored `posts.comment_count` (issue #835) unless the viewer hides
// someone — then counted live, in one grouped COUNT over `comments` using the
// `comments_post_id_idx` (postId, id) index. Ids with no comments are simply
// absent from the map; callers default them to 0.
//
// `hiddenAuthorIds` (the viewer's `blockedOrMutedUserIds`, issue #661) makes
// the count match what the thread endpoints show that viewer: a hidden
// author's comments and replies aren't counted, nor are other people's replies
// under a hidden author's top-level comment, since that comment — the only way
// to reach them — is hidden too.
export const postCommentCounts = async (
  db: DrizzleDb,
  postIds: ReadonlyArray<number>,
  hiddenAuthorIds: ReadonlyArray<number> = [],
): Promise<Map<number, number>> => {
  const result = new Map<number, number>();
  if (postIds.length === 0) return result;
  // Nobody hidden: the stored count is exactly what the thread shows (issue
  // #835 — it's kept by a trigger on `comments`, see posts.comment_count).
  if (hiddenAuthorIds.length === 0) {
    const stored = await db
      .select({ id: posts.id, commentCount: posts.commentCount })
      .from(posts)
      .where(inArray(posts.id, [...postIds]));
    for (const row of stored) {
      if (row.commentCount > 0) result.set(row.id, row.commentCount);
    }
    return result;
  }
  const parent = alias(comments, "parent");
  const rows = await db
    .select({ postId: comments.postId, total: count() })
    .from(comments)
    .where(
      and(
        inArray(comments.postId, [...postIds]),
        // A deleted placeholder (issue #904) isn't a comment; the stored
        // count leaves it out too.
        isNull(comments.deletedAt),
        hiddenAuthorIds.length > 0
          ? and(
              notInArray(comments.authorId, [...hiddenAuthorIds]),
              notExists(
                db
                  .select({ id: parent.id })
                  .from(parent)
                  .where(
                    and(
                      eq(parent.id, comments.parentCommentId),
                      inArray(parent.authorId, [...hiddenAuthorIds]),
                    ),
                  ),
              ),
            )
          : undefined,
      ),
    )
    .groupBy(comments.postId);
  for (const row of rows) result.set(row.postId, Number(row.total));
  return result;
};

// Keyset cursor for `listPosts` over its `id desc` sort — see
// `PostsPageQuery` in Api.ts for why this is a cursor rather than an offset.
// Posts are never reordered by edits, so the last row's id alone is enough
// (no tie-breaker column needed, unlike `listChats`'s cursor). Exported —
// `listUserPosts` in UsersHandler.ts shares the same cursor format since it
// sorts posts the same way, just pre-filtered to one author.
export const encodePostsCursor = (id: number): string =>
  Buffer.from(String(id)).toString("base64url");

export const decodePostsCursor = (cursor: string): number | null => {
  const id = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isInteger(id) ? id : null;
};

// Every post in `rows` paired with its embedded author, fetched in a single
// batch; a row whose author is already gone is dropped (see authors.ts).
export const withAuthors = (db: DrizzleDb, rows: ReadonlyArray<DbPost>) =>
  loadAuthors(
    db,
    rows.map((r) => r.authorId),
  ).pipe(
    Effect.map((authors) =>
      rows.flatMap((row) => {
        const author = authors.get(row.authorId);
        return author ? [{ row, author }] : [];
      }),
    ),
  );
