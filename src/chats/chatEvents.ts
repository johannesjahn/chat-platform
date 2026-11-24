import { desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { type ChatEvent, MAX_CHAT_EVENTS } from "../Api.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { chatEvents, users, type NewDbChatEvent } from "../db/schema.ts";
import { newestMessageIdIn } from "./unread.ts";

// Group activity (issue #900): who added whom, renames, role changes and so
// on, shown as rows between a group's messages.
//
// Its own table rather than a new message content type, so it needs no
// rollout in two releases (an old replica can't encode a message type it
// doesn't know, and would fail the whole page), and none of what applies to
// messages — unread counts, search, replies, pins, forwards, un-archiving —
// has to make an exception for it.

// Records events in the transaction that makes the change. Each sits after
// the chat's newest message as of now.
export const recordChatEvents = async (
  db: Pick<DrizzleDb, "insert">,
  chatId: number,
  events: ReadonlyArray<
    Pick<NewDbChatEvent, "type" | "actorId" | "targetId" | "detail">
  >,
): Promise<void> => {
  if (events.length === 0) return;
  const createdAt = new Date();
  await db.insert(chatEvents).values(
    events.map((event) => ({
      ...event,
      chatId,
      afterMessageId: sql`coalesce(${newestMessageIdIn(chatId)}, 0)`,
      createdAt,
    })),
  );
};

const actor = alias(users, "actor");
const target = alias(users, "target");

// The chat's newest events, oldest first. Names are the people's current
// ones; null once the account is gone.
export const listChatEvents = (
  db: DrizzleDb,
  chatId: number,
): Effect.Effect<ChatEvent[]> =>
  dbQuery(() =>
    db
      .select({
        event: chatEvents,
        actor: {
          id: actor.id,
          username: actor.username,
          displayName: actor.displayName,
        },
        target: {
          id: target.id,
          username: target.username,
          displayName: target.displayName,
        },
      })
      .from(chatEvents)
      .leftJoin(actor, eq(actor.id, chatEvents.actorId))
      .leftJoin(target, eq(target.id, chatEvents.targetId))
      .where(eq(chatEvents.chatId, chatId))
      .orderBy(desc(chatEvents.id))
      .limit(MAX_CHAT_EVENTS),
  ).pipe(
    Effect.map((rows) =>
      rows.reverse().map((row) => ({
        id: row.event.id,
        type: row.event.type,
        afterMessageId: row.event.afterMessageId,
        actor: toPerson(row.actor),
        target: toPerson(row.target),
        detail: row.event.detail,
        createdAt: row.event.createdAt.getTime(),
      })),
    ),
  );

const toPerson = (
  row: { id: number; username: string; displayName: string | null } | null,
) => row && { userId: row.id, name: row.displayName ?? row.username };
