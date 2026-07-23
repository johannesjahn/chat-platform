import { and, count, eq, inArray } from "drizzle-orm";
import type { DrizzleDb } from "./Db.ts";
import { likes } from "./db/schema.ts";

// Per-emoji reaction counts are computed on read rather than stored in a
// denormalized counter column (see the comment on `likes` in db/schema.ts): a
// grouped COUNT over `likes` (per target, per emoji) for the visible ids,
// plus a second query for which (target, emoji) pairs the current user
// reacted with. Both are keyed off the target FK columns, which are indexed,
// so a page's worth stays cheap. Kept here (rather than in a handler) so both
// PostsHandler and EngagementHandler share one implementation.

export type ReactionSummary = {
  readonly emoji: string;
  readonly count: number;
  readonly reactedByMe: boolean;
};

// Only emojis with at least one reaction are included — there's no need to
// zero-fill every emoji in the standard set (see REACTION_EMOJIS in Api.ts),
// since the frontend's "add a reaction" picker already knows that full list
// independently of what's actually been used on a given target. Sorted by
// count (most-reacted first), then emoji, for a stable render order that
// doesn't reshuffle as counts change by ties.
const buildSummaries = (
  counts: ReadonlyArray<{ readonly emoji: string; readonly total: number }>,
  mineEmojis: ReadonlySet<string>,
): ReactionSummary[] =>
  counts
    .map((row) => ({
      emoji: row.emoji,
      count: row.total,
      reactedByMe: mineEmojis.has(row.emoji),
    }))
    .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));

// Per-emoji reaction summaries for a batch of post ids, in one grouped count
// query and one "which (post, emoji) pairs did I react to" query. Every
// requested id is present in the result (an empty array if it has no
// reactions at all).
export const postReactionInfo = async (
  db: DrizzleDb,
  postIds: ReadonlyArray<number>,
  userId: number,
): Promise<Map<number, ReactionSummary[]>> => {
  const result = new Map<number, ReactionSummary[]>();
  if (postIds.length === 0) return result;
  const ids = [...postIds];

  const counts = await db
    .select({ postId: likes.postId, emoji: likes.emoji, total: count() })
    .from(likes)
    .where(inArray(likes.postId, ids))
    .groupBy(likes.postId, likes.emoji);
  const mine = await db
    .select({ postId: likes.postId, emoji: likes.emoji })
    .from(likes)
    .where(and(eq(likes.userId, userId), inArray(likes.postId, ids)));

  const mineByPost = new Map<number, Set<string>>();
  for (const row of mine) {
    if (row.postId === null) continue;
    const set = mineByPost.get(row.postId) ?? new Set<string>();
    set.add(row.emoji);
    mineByPost.set(row.postId, set);
  }
  const countsByPost = new Map<
    number,
    Array<{ emoji: string; total: number }>
  >();
  for (const row of counts) {
    if (row.postId === null) continue;
    const arr = countsByPost.get(row.postId) ?? [];
    arr.push({ emoji: row.emoji, total: Number(row.total) });
    countsByPost.set(row.postId, arr);
  }
  for (const id of ids) {
    result.set(
      id,
      buildSummaries(
        countsByPost.get(id) ?? [],
        mineByPost.get(id) ?? new Set(),
      ),
    );
  }
  return result;
};

// Same as `postReactionInfo`, for comment (and reply) ids — reactions on
// comments and replies share the one `likes` table.
export const commentReactionInfo = async (
  db: DrizzleDb,
  commentIds: ReadonlyArray<number>,
  userId: number,
): Promise<Map<number, ReactionSummary[]>> => {
  const result = new Map<number, ReactionSummary[]>();
  if (commentIds.length === 0) return result;
  const ids = [...commentIds];

  const counts = await db
    .select({ commentId: likes.commentId, emoji: likes.emoji, total: count() })
    .from(likes)
    .where(inArray(likes.commentId, ids))
    .groupBy(likes.commentId, likes.emoji);
  const mine = await db
    .select({ commentId: likes.commentId, emoji: likes.emoji })
    .from(likes)
    .where(and(eq(likes.userId, userId), inArray(likes.commentId, ids)));

  const mineByComment = new Map<number, Set<string>>();
  for (const row of mine) {
    if (row.commentId === null) continue;
    const set = mineByComment.get(row.commentId) ?? new Set<string>();
    set.add(row.emoji);
    mineByComment.set(row.commentId, set);
  }
  const countsByComment = new Map<
    number,
    Array<{ emoji: string; total: number }>
  >();
  for (const row of counts) {
    if (row.commentId === null) continue;
    const arr = countsByComment.get(row.commentId) ?? [];
    arr.push({ emoji: row.emoji, total: Number(row.total) });
    countsByComment.set(row.commentId, arr);
  }
  for (const id of ids) {
    result.set(
      id,
      buildSummaries(
        countsByComment.get(id) ?? [],
        mineByComment.get(id) ?? new Set(),
      ),
    );
  }
  return result;
};

// Same as `postReactionInfo`, for chat message ids (issue #216) — messages
// share the `likes` table with posts and comments/replies (see the `likes`
// comment in db/schema.ts).
export const messageReactionInfo = async (
  db: DrizzleDb,
  messageIds: ReadonlyArray<number>,
  userId: number,
): Promise<Map<number, ReactionSummary[]>> => {
  const result = new Map<number, ReactionSummary[]>();
  if (messageIds.length === 0) return result;
  const ids = [...messageIds];

  const counts = await db
    .select({ messageId: likes.messageId, emoji: likes.emoji, total: count() })
    .from(likes)
    .where(inArray(likes.messageId, ids))
    .groupBy(likes.messageId, likes.emoji);
  const mine = await db
    .select({ messageId: likes.messageId, emoji: likes.emoji })
    .from(likes)
    .where(and(eq(likes.userId, userId), inArray(likes.messageId, ids)));

  const mineByMessage = new Map<number, Set<string>>();
  for (const row of mine) {
    if (row.messageId === null) continue;
    const set = mineByMessage.get(row.messageId) ?? new Set<string>();
    set.add(row.emoji);
    mineByMessage.set(row.messageId, set);
  }
  const countsByMessage = new Map<
    number,
    Array<{ emoji: string; total: number }>
  >();
  for (const row of counts) {
    if (row.messageId === null) continue;
    const arr = countsByMessage.get(row.messageId) ?? [];
    arr.push({ emoji: row.emoji, total: Number(row.total) });
    countsByMessage.set(row.messageId, arr);
  }
  for (const id of ids) {
    result.set(
      id,
      buildSummaries(
        countsByMessage.get(id) ?? [],
        mineByMessage.get(id) ?? new Set(),
      ),
    );
  }
  return result;
};

// Convenience single-target lookups for the add/remove-reaction endpoints,
// which need exactly one target's state to return. Fall back to an empty
// array if the target somehow has no rows (e.g. removing the last reaction of
// its emoji).
export const postReactionInfoOne = async (
  db: DrizzleDb,
  postId: number,
  userId: number,
): Promise<ReactionSummary[]> =>
  (await postReactionInfo(db, [postId], userId)).get(postId) ?? [];

export const commentReactionInfoOne = async (
  db: DrizzleDb,
  commentId: number,
  userId: number,
): Promise<ReactionSummary[]> =>
  (await commentReactionInfo(db, [commentId], userId)).get(commentId) ?? [];

export const messageReactionInfoOne = async (
  db: DrizzleDb,
  messageId: number,
  userId: number,
): Promise<ReactionSummary[]> =>
  (await messageReactionInfo(db, [messageId], userId)).get(messageId) ?? [];
