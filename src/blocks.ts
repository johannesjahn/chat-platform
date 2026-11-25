import { type SQL, and, eq, inArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DrizzleDb } from "./Db.ts";
import { userBlocks } from "./db/schema.ts";

// Shared read helpers for the block/mute privacy controls (issue #219),
// factored out of the handlers the same way pinsStars.ts is: every call site
// that needs to know "who has this user blocked/muted", "is this pair blocked",
// or "which recipients muted this sender" goes through one implementation
// here. See the comment on `userBlocks` in db/schema.ts for the block-vs-mute
// semantics.

// The ids of every user `userId` has blocked *or* muted. Both actions hide the
// target from the blocker, so filtering doesn't distinguish them. Posts and
// comments use `hiddenAuthorIds`, which adds the other direction. Uses the composite
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

// Who is reading. Admins still see people who blocked them (see
// `blockedByCondition`).
export type Viewer = { readonly id: number; readonly role: string };

// SQL condition: the `user_blocks` row is a *block* (never a mute, which must
// stay invisible to the muted person) that hides its blocker from `viewer`
// (issue #901). Matches nothing for an admin: otherwise anyone could put their
// content out of moderators' reach by blocking them.
const blockedByCondition = (viewer: Viewer): SQL =>
  viewer.role === "admin"
    ? sql`false`
    : and(eq(userBlocks.blockedId, viewer.id), eq(userBlocks.type, "block"))!;

// The ids of everyone `viewer` is hidden from: users who blocked them, whose
// profile, posts and comments read as missing to them.
export const blockerIdsOf = async (
  db: DrizzleDb,
  viewer: Viewer,
): Promise<number[]> => {
  const rows = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(blockedByCondition(viewer));
  return rows.map((r) => r.blockerId);
};

// Every author whose content is left out of lists and counts for `viewer`:
// the people they blocked or muted, and the people who blocked them.
export const hiddenAuthorIds = async (
  db: DrizzleDb,
  viewer: Viewer,
): Promise<number[]> => {
  const rows = await db
    .select({
      blockerId: userBlocks.blockerId,
      blockedId: userBlocks.blockedId,
    })
    .from(userBlocks)
    .where(or(eq(userBlocks.blockerId, viewer.id), blockedByCondition(viewer)));
  return [
    ...new Set(
      rows.map((r) => (r.blockerId === viewer.id ? r.blockedId : r.blockerId)),
    ),
  ];
};

// Whether any of `authorIds` blocked `viewer` — the gate on opening something
// directly, which then 404s like a missing one. The viewer's own blocks and
// mutes don't count: they only filter lists.
export const isHiddenFrom = async (
  db: DrizzleDb,
  viewer: Viewer,
  authorIds: ReadonlyArray<number>,
): Promise<boolean> => {
  const rows = await db
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(
      and(
        blockedByCondition(viewer),
        inArray(userBlocks.blockerId, [...authorIds]),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

// Whether a *block* (not a mere mute) exists in either direction between two
// users — the gate on direct messaging (see `directChatClosed` in
// chats/sendPath.ts). Blocking is symmetric for messaging: if A blocked B,
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

// SQL condition: no *block* (a mute doesn't count) in either direction between
// `userId` and the user in column `other` — `directBlockExists`, negated, for
// a query that ranges over users. Who counts as a contact (`contactOf` in
// contacts.ts) is built on it.
export const notBlockedEitherWay = (userId: number, other: AnyPgColumn): SQL =>
  sql`not exists (select 1 from ${userBlocks} where ${and(
    eq(userBlocks.type, "block"),
    or(
      and(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, other)),
      and(eq(userBlocks.blockerId, other), eq(userBlocks.blockedId, userId)),
    ),
  )})`;

// Of `otherIds`, the subset with a *block* (not a mute) in either direction
// with `userId` — the batch form of `directBlockExists`. Gates putting
// someone into a group chat with someone else (issue #757): see
// `requireNoBlockWith` in chats/access.ts. Returns an empty set for an empty
// `otherIds`.
export const blockedPeersAmong = async (
  db: DrizzleDb,
  userId: number,
  otherIds: ReadonlyArray<number>,
): Promise<Set<number>> => {
  if (otherIds.length === 0) return new Set();
  const others = [...otherIds];
  const rows = await db
    .select({
      blockerId: userBlocks.blockerId,
      blockedId: userBlocks.blockedId,
    })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.type, "block"),
        or(
          and(
            eq(userBlocks.blockerId, userId),
            inArray(userBlocks.blockedId, others),
          ),
          and(
            eq(userBlocks.blockedId, userId),
            inArray(userBlocks.blockerId, others),
          ),
        ),
      ),
    );
  return new Set(
    rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)),
  );
};

// Of `recipientIds`, the subset `actorId` has *blocked* — who must not hear of
// anything they do (issue #901).
export const recipientsBlockedBy = async (
  db: DrizzleDb,
  actorId: number,
  recipientIds: ReadonlyArray<number>,
): Promise<Set<number>> => {
  if (recipientIds.length === 0) return new Set();
  const rows = await db
    .select({ blockedId: userBlocks.blockedId })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, actorId),
        eq(userBlocks.type, "block"),
        inArray(userBlocks.blockedId, [...recipientIds]),
      ),
    );
  return new Set(rows.map((r) => r.blockedId));
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
