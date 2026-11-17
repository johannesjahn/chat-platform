import { type SQL, and, eq, ne } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { notBlockedEitherWay } from "./blocks.ts";

// The one definition of who a user's *contacts* are (issues #660, #764,
// #785, #810): everyone they share an accepted chat with, minus anyone on
// either side of a block. A pending message request introduces nobody, on
// either side, until it's accepted; a mute never hides anyone (it doesn't
// stop messaging either). Presence (`PresenceAudience`) and the contact
// suggestions (`contactsOf` in users/directoryHandlers.ts) both go through it.

// Two `chat_participants` rows, `mine` and `theirs`, joined on the same chat.
type ParticipantRow = {
  readonly userId: AnyPgColumn;
  readonly requestPending: AnyPgColumn;
};

// SQL condition: `mine` is `userId`'s row, and `theirs` is a contact's row in
// the same chat. The caller joins `theirs` to `mine` on `chatId`.
export const contactOf = (
  userId: number,
  mine: ParticipantRow,
  theirs: ParticipantRow,
): SQL =>
  and(
    eq(mine.userId, userId),
    ne(theirs.userId, userId),
    eq(mine.requestPending, false),
    eq(theirs.requestPending, false),
    notBlockedEitherWay(userId, theirs.userId),
  )!;
