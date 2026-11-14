import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Forbidden, NotFound, type ChatRole } from "../Api.ts";
import { blockedPeersAmong } from "../blocks.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import {
  chatParticipants,
  chats,
  messages,
  users,
  type DbChat,
  type DbMessage,
} from "../db/schema.ts";

// Lookups that 404 and the participation/permission checks every chats
// handler starts with. A pending message request (issue #785) is a
// participant but not an *accepted* one: writes others would see go through
// `requireAcceptedParticipant`.

// A participant's per-chat role, or `null` if they aren't (or are no longer)
// a participant of `chatId`.
export const getParticipantRole = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<ChatRole | null> =>
  dbQuery(() =>
    db
      .select({ role: chatParticipants.role })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, userId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]?.role ?? null));

export const getMessageOr404 = (
  db: DrizzleDb,
  chatId: number,
  messageId: number,
): Effect.Effect<DbMessage, NotFound> =>
  Effect.gen(function* () {
    const rows = yield* dbQuery(() =>
      db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.id, messageId)))
        .limit(1),
    );
    const row = rows[0];
    if (!row)
      return yield* Effect.fail(
        new NotFound({
          message: `Message ${messageId} not found in chat ${chatId}`,
        }),
      );
    return row;
  });

export const isParticipant = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<boolean> =>
  dbQuery(() =>
    db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, userId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0));

export const getChatOr404 = (
  db: DrizzleDb,
  id: number,
): Effect.Effect<DbChat, NotFound> =>
  Effect.gen(function* () {
    const rows = yield* dbQuery(() =>
      db.select().from(chats).where(eq(chats.id, id)).limit(1),
    );
    const row = rows[0];
    if (!row)
      return yield* Effect.fail(
        new NotFound({ message: `Chat ${id} not found` }),
      );
    return row;
  });

export const requireParticipant = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
) =>
  Effect.gen(function* () {
    const participant = yield* isParticipant(db, chatId, userId);
    if (!participant)
      return yield* Effect.fail(
        new Forbidden({ message: "You are not a participant in this chat" }),
      );
  });

// Whether `userId` is in the chat for real — a participant who has accepted
// it, not one it's still a message request for (issue #785). One read of
// their participant row.
export const isAcceptedParticipant = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<boolean> =>
  dbQuery(() =>
    db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, userId),
          eq(chatParticipants.requestPending, false),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0));

// Every write other participants would see — a message, a typing ping, a
// reaction, a pin, an edit — needs the chat accepted first (issue #808). A
// pending participant may read the chat to decide, but nothing they do
// reaches anyone else as if they'd joined. Same 403 as a non-participant
// gets, worded for the one case the caller can act on; it confirms nothing
// they don't already know (the request itself shows them the chat).
export const requireAcceptedParticipant = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<void, Forbidden> =>
  Effect.gen(function* () {
    if (yield* isAcceptedParticipant(db, chatId, userId)) return;
    yield* requireParticipant(db, chatId, userId);
    return yield* Effect.fail(
      new Forbidden({
        message: "Accept this message request before taking part in the chat",
      }),
    );
  });

// Fails with 403 if any of `otherIds` is on either side of a *block* with
// `actorId` (issue #757). Group messages aren't gated by blocks (see
// `directChatBlocked`), so without this a group — which may hold just the
// two of them — would get around the DM block. Used by `createGroupChat`
// and `addParticipants` (the actor vs. everyone they're adding) and
// `joinChatViaInvite` (the joiner vs. the invite's creator). The whole
// request is rejected rather than the blocked users silently skipped, so
// the caller never gets a group that isn't what they asked for — and, like
// the DM 403, the message doesn't say who blocked whom.
export const requireNoBlockWith = (
  db: DrizzleDb,
  actorId: number,
  otherIds: ReadonlyArray<number>,
  message: string,
): Effect.Effect<void, Forbidden> =>
  Effect.gen(function* () {
    const blocked = yield* dbQuery(() =>
      blockedPeersAmong(db, actorId, otherIds),
    );
    if (blocked.size > 0) return yield* Effect.fail(new Forbidden({ message }));
  });

// Group-chat management actions (updateChat, addParticipants,
// removeParticipant, deleteChat) are gated on this rather than
// `requireParticipant` — the chat's owner or an admin (per-chat role, issue
// #220; formerly creator-only, issue #66) can act even without re-checking
// plain participation, and a site-wide admin may act on a chat they don't
// participate in at all.
export const requireChatManager = (
  db: DrizzleDb,
  currentUser: { readonly id: number; readonly role: string },
  chat: { readonly id: number; readonly createdBy: number | null },
): Effect.Effect<void, Forbidden> =>
  Effect.gen(function* () {
    if (currentUser.role === "admin") return;
    const role = yield* getParticipantRole(db, chat.id, currentUser.id);
    if (role !== "owner" && role !== "admin")
      return yield* Effect.fail(
        new Forbidden({
          message: "Only the chat owner or an admin can perform this action",
        }),
      );
  });

// Stricter than `requireChatManager`: only the chat's owner (or a site-wide
// admin) may reassign ownership or grant/revoke the "admin" role — an admin
// can moderate a chat day-to-day but can't create peers or displace the
// owner. Mirrors an ownerless chat's existing "any participant may claim it"
// escape hatch (issue #66) via the caller-supplied `canClaim`.
export const requireChatOwner = (
  db: DrizzleDb,
  currentUser: { readonly id: number; readonly role: string },
  chat: { readonly id: number; readonly createdBy: number | null },
): Effect.Effect<void, Forbidden> =>
  Effect.gen(function* () {
    if (currentUser.role === "admin") return;
    const role = yield* getParticipantRole(db, chat.id, currentUser.id);
    if (role !== "owner")
      return yield* Effect.fail(
        new Forbidden({
          // "admin" here means a *site-wide* admin, not this chat's
          // "admin" role (that's exactly who this check excludes) — spelled
          // out so the message doesn't read as self-contradictory to
          // whoever it just rejected.
          message:
            "Only the chat owner (or a site admin) can perform this action",
        }),
      );
  });

export const existingUserIds = (
  db: DrizzleDb,
  ids: ReadonlyArray<number>,
): Effect.Effect<Set<number>> =>
  ids.length === 0
    ? Effect.succeed(new Set())
    : dbQuery(() =>
        db.select({ id: users.id }).from(users).where(inArray(users.id, ids)),
      ).pipe(Effect.map((rows) => new Set(rows.map((r) => r.id))));
