import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { ChatParticipant } from "../Api.ts";
import { AttachmentStorage } from "../AttachmentStorage.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import {
  chatInvites,
  chatParticipants,
  chats,
  type DbChat,
} from "../db/schema.ts";
import { deleteAvatarObjects } from "../avatars.ts";
import { RealtimeConnections } from "../Realtime.ts";
import { recordChatEvents } from "./chatEvents.ts";
import { getParticipants, notifyChatUpdated } from "./chatState.ts";

// What a participant leaving a chat does to it — shared by `leaveChat` and
// `removeParticipant` (membershipHandlers.ts) and by account deletion
// (users/accountHandlers.ts, issue #895), which must leave every chat the
// same way rather than letting the `users` FK cascades drop the rows.

type TxDb = Pick<DrizzleDb, "select" | "insert" | "update" | "delete">;

// Deletes a chat row (its cascading FKs, see db/schema.ts, take care of the
// rest of the database) and then, best-effort, its group avatar's objects —
// nothing else would ever sweep them once the row stops pointing at them
// (issue #652), and `GET /avatars/:token` serves them publicly. The tokens
// come from the deleted row itself, so an avatar swapped in after the caller
// read the chat is still the one removed. Takes `db` so it runs inside a
// caller's transaction; the returned effect sweeps the objects, to run once
// that has committed.
export const deleteChatRow = async (
  db: Pick<DrizzleDb, "delete">,
  storage: AttachmentStorage["Service"],
  chatId: number,
): Promise<Effect.Effect<void>> => {
  const deleted = await db.delete(chats).where(eq(chats.id, chatId)).returning({
    avatarSmallKey: chats.avatarSmallKey,
    avatarMediumKey: chats.avatarMediumKey,
    avatarLargeKey: chats.avatarLargeKey,
  });
  return Effect.forEach(
    deleted,
    (row) =>
      deleteAvatarObjects(storage, [
        row.avatarSmallKey,
        row.avatarMediumKey,
        row.avatarLargeKey,
      ]),
    { discard: true },
  );
};

// An invite link is its creator asking people in, so it stops working once
// they can't (issue #894): leaving or being removed from the group, or losing
// the admin role, revokes every active link they made in it — set like a
// manual revoke, so the owner's list still shows it. Runs in the same
// transaction as the membership change; `joinChatViaInvite` also rejects a
// link whose creator is no longer a manager, for anything this misses.
export const revokeInvitesBy = (
  db: Pick<DrizzleDb, "update">,
  chatId: number,
  userId: number,
) =>
  db
    .update(chatInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(chatInvites.chatId, chatId),
        eq(chatInvites.createdBy, userId),
        isNull(chatInvites.revokedAt),
      ),
    );

type Departure =
  | { readonly deleted: true; readonly sweepAvatar: Effect.Effect<void> }
  | { readonly deleted: false; readonly chat: DbChat };

// Removes `departingUserId` from `chatRow`, then either deletes the chat
// outright (if that emptied it) or, if the departing user owned a group,
// reassigns `createdBy` to the longest-standing remaining participant so the
// group doesn't become unmanageable (issue #66) — before bumping the version
// either way. Runs inside the caller's transaction, so a concurrent
// departure/removal can't see a half-updated state.
const departInTx = async (
  tx: TxDb,
  storage: AttachmentStorage["Service"],
  chatRow: DbChat,
  departingUserId: number,
  // Who removed them, when they didn't leave by themselves.
  removedBy?: number,
): Promise<Departure> => {
  const departed = await tx
    .delete(chatParticipants)
    .where(
      and(
        eq(chatParticipants.chatId, chatRow.id),
        eq(chatParticipants.userId, departingUserId),
      ),
    )
    .returning({ id: chatParticipants.id });
  await revokeInvitesBy(tx, chatRow.id, departingUserId);

  const remaining = await tx
    .select({
      userId: chatParticipants.userId,
      joinedAt: chatParticipants.joinedAt,
      requestPending: chatParticipants.requestPending,
    })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatRow.id));

  if (remaining.length === 0) {
    const sweepAvatar = await deleteChatRow(tx, storage, chatRow.id);
    return { deleted: true, sweepAvatar };
  }

  // Not a second time if a concurrent request already took them out.
  if (chatRow.type === "group" && departed.length > 0)
    await recordChatEvents(tx, chatRow.id, [
      removedBy === undefined
        ? { type: "member_left", actorId: departingUserId }
        : {
            type: "member_removed",
            actorId: removedBy,
            targetId: departingUserId,
          },
    ]);

  // A direct chat has no owner to hand off: its `createdBy` only records
  // who started it.
  if (chatRow.type === "group" && chatRow.createdBy === departingUserId) {
    // Someone who hasn't accepted the group yet (issue #785) only inherits
    // it if nobody else is left.
    const newOwner = [...remaining].sort(
      (a, b) =>
        Number(a.requestPending) - Number(b.requestPending) ||
        a.joinedAt.getTime() - b.joinedAt.getTime() ||
        a.userId - b.userId,
    )[0]!;
    await tx
      .update(chats)
      .set({ createdBy: newOwner.userId })
      .where(eq(chats.id, chatRow.id));
    // Keep the per-chat role in sync with `createdBy` — see the "role"
    // column comment in db/schema.ts.
    await tx
      .update(chatParticipants)
      .set({ role: "owner" })
      .where(
        and(
          eq(chatParticipants.chatId, chatRow.id),
          eq(chatParticipants.userId, newOwner.userId),
        ),
      );
    if (departed.length > 0)
      await recordChatEvents(tx, chatRow.id, [
        { type: "owner_changed", targetId: newOwner.userId },
      ]);
  }

  const updated = await tx
    .update(chats)
    .set({ version: sql`${chats.version} + 1` })
    .where(eq(chats.id, chatRow.id))
    .returning();

  return { deleted: false, chat: updated[0]! };
};

// `departInTx` in a transaction of its own — `leaveChat` and
// `removeParticipant`.
export const departParticipant = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  chatRow: DbChat,
  departingUserId: number,
  removedBy?: number,
): Effect.Effect<
  | { readonly deleted: true }
  | {
      readonly deleted: false;
      readonly chat: DbChat;
      readonly participants: ReadonlyArray<ChatParticipant>;
    }
> =>
  Effect.gen(function* () {
    const result = yield* dbQuery(() =>
      db.transaction((tx) =>
        departInTx(tx, storage, chatRow, departingUserId, removedBy),
      ),
    );

    if (result.deleted) {
      yield* result.sweepAvatar;
      return { deleted: true as const };
    }
    const participants = yield* getParticipants(db, chatRow.id);
    return { deleted: false as const, chat: result.chat, participants };
  });

// Account deletion (issue #895): takes `userId` out of every chat they're in,
// inside the caller's transaction (the one that then deletes the `users`
// row), exactly as if they had left each one — so no group is left without
// an owner. The returned effect, to run once that has committed, sweeps the
// avatars of chats that emptied and, reading through `db` rather than the
// finished `tx`, sends `chat_updated` to everyone left in
// the others, including the remaining partner of a direct chat, which
// becomes read-only (see `directChatClosed` in sendPath.ts).
export const departAllChats = async (
  db: DrizzleDb,
  tx: TxDb,
  storage: AttachmentStorage["Service"],
  connections: RealtimeConnections["Service"],
  userId: number,
): Promise<Effect.Effect<void>> => {
  const rows = await tx
    .select({ chat: chats })
    .from(chats)
    .innerJoin(chatParticipants, eq(chatParticipants.chatId, chats.id))
    .where(eq(chatParticipants.userId, userId))
    .orderBy(chats.id);

  const departures: Departure[] = [];
  for (const { chat } of rows)
    departures.push(await departInTx(tx, storage, chat, userId));

  return Effect.forEach(
    departures,
    (departure) =>
      departure.deleted
        ? departure.sweepAvatar
        : Effect.gen(function* () {
            const participants = yield* getParticipants(db, departure.chat.id);
            yield* notifyChatUpdated(
              connections,
              departure.chat.id,
              departure.chat.version,
              participants.map((p) => p.userId),
            );
          }),
    { discard: true },
  );
};
