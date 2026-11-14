import { and, count, eq, inArray, notExists, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { type Attachment, type AuthorSummary } from "./Api.ts";
import { loadAuthors } from "./authors.ts";
import { type DrizzleDb } from "./Db.ts";
import { type ReactionSummary } from "./reactions.ts";
import { comments, type DbPost, posts } from "./db/schema.ts";

export const NO_REACTIONS: ReactionSummary[] = [];

// A post's caption (issue #765) only counts on an "attachment" post: an edit
// by a replica that predates captions can turn a captioned attachment into a
// text post without clearing the column, and that leftover never shows.
export const captionOf = (row: {
  readonly contentType: string;
  readonly caption: string | null;
}): string | null => (row.contentType === "attachment" ? row.caption : null);

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
  contentType: row.contentType,
  content: row.content,
  attachment,
  caption: captionOf(row),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  reactions: [...reactions],
  commentCount,
});

// Total comments (top-level *and* replies) per post for a batch of ids, in one
// grouped COUNT over `comments` — mirrors `postReactionInfo`'s shape/rationale
// (computed on read, not stored — see reactions.ts and the `commentCount`
// comment on `Post` in Api.ts). The `comments_post_id_idx` (postId, id) index
// keeps a page's worth cheap. Ids with no comments are simply absent from the
// map; callers default them to 0.
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
  const parent = alias(comments, "parent");
  const rows = await db
    .select({ postId: comments.postId, total: count() })
    .from(comments)
    .where(
      and(
        inArray(comments.postId, [...postIds]),
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
