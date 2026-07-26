import { and, eq, inArray, or } from "drizzle-orm";
import type { DrizzleDb } from "./Db.ts";
import { userBlocks } from "./db/schema.ts";

// Shared read helpers for the block/mute privacy controls (issue #219),
// factored out of the handlers the same way pinsStars.ts is: every call site
// that needs to know "who has this user blocked/muted", "is this pair blocked",
// or "which recipients muted this sender" goes through one implementation
// here. See the comment on `userBlocks` in db/schema.ts for the block-vs-mute
// semantics.

// The ids of every user `userId` has blocked *or* muted. Both actions hide the
// target's posts from the blocker's feed (see `listPosts` in PostsHandler.ts),
// so feed filtering doesn't distinguish them. Uses the composite
// (blockerId, blockedId) index's leading column.
export const blockedOrMutedUserIds = async (
  db: DrizzleDb,
  userId: number,
): Promise<number[]> => {
  const rows = await db
    .select({ blockedId: userBlocks.blockedId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, userId));
  return rows.map((r) => r.blockedId);
};

// Whether a *block* (not a mere mute) exists in either direction between two
// users — the gate on direct messaging (see `createMessage` in
// ChatsHandler.ts). Blocking is symmetric for messaging: if A blocked B,
// neither A nor B can message the other in their direct chat. A mute never
// blocks messaging, so it's excluded here.
export const directBlockExists = async (
  db: DrizzleDb,
  userA: number,
  userB: number,
): Promise<boolean> => {
  const rows = await db
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.type, "block"),
        or(
          and(eq(userBlocks.blockerId, userA), eq(userBlocks.blockedId, userB)),
          and(eq(userBlocks.blockerId, userB), eq(userBlocks.blockedId, userA)),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

// Of `recipientIds`, the subset that has blocked or muted `senderId` — i.e.
// the participants whose realtime chat notification for a message from
// `senderId` should be suppressed (issue #219: "mute their chat
// notifications"). Both block and mute suppress notifications. Keys off the
// `blockedId` index. Returns an empty set for an empty `recipientIds`.
export const recipientsMutingSender = async (
  db: DrizzleDb,
  senderId: number,
  recipientIds: ReadonlyArray<number>,
): Promise<Set<number>> => {
  if (recipientIds.length === 0) return new Set();
  const rows = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockedId, senderId),
        inArray(userBlocks.blockerId, [...recipientIds]),
      ),
    );
  return new Set(rows.map((r) => r.blockerId));
};
