import { and, desc, eq, inArray } from "drizzle-orm";
import type { DrizzleDb } from "./Db.ts";
import { messages, pinnedMessages, starredMessages } from "./db/schema.ts";

// Pinned (chat-wide, issue #223) and starred (user-private) flags are computed
// on read rather than denormalized onto `messages`, the same convention as
// reactions (see reactions.ts): a message's `pinned`/`starred` are looked up
// per page of messages from the `pinned_messages`/`starred_messages` tables,
// both keyed off the indexed `messageId` FK columns so a page's worth stays
// cheap. Kept here (rather than in ChatsHandler) so every message-building call
// site shares one implementation.

export type PinStarState = {
  readonly pinned: boolean;
  readonly starred: boolean;
};

const UNPINNED_UNSTARRED: PinStarState = { pinned: false, starred: false };

// Whether each of `messageIds` is currently pinned (visible to everyone) and
// whether `userId` has personally starred it. Every requested id is present in
// the returned map (defaulting to both-false), so callers can index it without
// a null check.
export const messagePinStarInfo = async (
  db: DrizzleDb,
  messageIds: ReadonlyArray<number>,
  userId: number,
): Promise<Map<number, PinStarState>> => {
  const result = new Map<number, PinStarState>();
  if (messageIds.length === 0) return result;
  const ids = [...messageIds];

  const pinnedRows = await db
    .select({ messageId: pinnedMessages.messageId })
    .from(pinnedMessages)
    .where(inArray(pinnedMessages.messageId, ids));
  const starredRows = await db
    .select({ messageId: starredMessages.messageId })
    .from(starredMessages)
    .where(
      and(
        eq(starredMessages.userId, userId),
        inArray(starredMessages.messageId, ids),
      ),
    );

  const pinned = new Set(pinnedRows.map((r) => r.messageId));
  const starred = new Set(starredRows.map((r) => r.messageId));
  for (const id of ids) {
    result.set(id, {
      pinned: pinned.has(id),
      starred: starred.has(id),
    });
  }
  return result;
};

// Convenience single-message lookup for the create/edit/pin/star endpoints,
// which build exactly one message's response.
export const messagePinStarInfoOne = async (
  db: DrizzleDb,
  messageId: number,
  userId: number,
): Promise<PinStarState> =>
  (await messagePinStarInfo(db, [messageId], userId)).get(messageId) ??
  UNPINNED_UNSTARRED;

// The ids of every message currently pinned in `chatId`, newest pin first —
// the order `listPinnedMessages` renders them in (a recently-pinned message
// surfaces at the top of the pinned panel). Returns just ids; the caller
// hydrates them into full `Message` responses the same way `listMessages`
// does.
export const pinnedMessageIds = async (
  db: DrizzleDb,
  chatId: number,
): Promise<number[]> => {
  const rows = await db
    .select({ messageId: pinnedMessages.messageId })
    .from(pinnedMessages)
    .where(eq(pinnedMessages.chatId, chatId))
    .orderBy(desc(pinnedMessages.id));
  return rows.map((r) => r.messageId);
};

// The ids of every message `userId` has starred in `chatId`, newest star
// first — the order `listStarredMessages` renders them in. Joins through to
// `messages` and filters on its `chatId` so a user's stars in *other* chats
// don't leak into this chat's list.
export const starredMessageIdsInChat = async (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Promise<number[]> => {
  const rows = await db
    .select({ messageId: starredMessages.messageId })
    .from(starredMessages)
    .innerJoin(messages, eq(messages.id, starredMessages.messageId))
    .where(and(eq(starredMessages.userId, userId), eq(messages.chatId, chatId)))
    .orderBy(desc(starredMessages.id));
  return rows.map((r) => r.messageId);
};
