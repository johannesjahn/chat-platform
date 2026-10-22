import { and, eq, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";
import { Db } from "./Db.ts";
import { chatParticipants, userBlocks } from "./db/schema.ts";

// Who gets to see a user's presence (online/offline) and custom status
// (issue #660). Both used to be broadcast to every socket in the deployment,
// so each transition cost O(online users) and every new connection was
// handed one frame per online user — O(online²) across a reconnect wave —
// and presence reached people who had blocked, or been blocked by, the user.
//
// The audience is a user's *contacts*: everyone who shares at least one chat
// with them, minus anyone on either side of a block (a mute is softer — it
// never hides presence, same as it never stops messaging; see `userBlocks`
// in db/schema.ts). It's the set of people who can actually see the user
// anywhere presence is rendered — chat lists, conversation headers, the
// feed's "online now" rail. Both directions of the relationship are the same
// query, so it serves the push side (whose sockets to notify about `userId`)
// and the snapshot side (whose presence to hand `userId` on connect) alike.
export class PresenceAudience extends Context.Service<
  PresenceAudience,
  {
    // Ids of `userId`'s contacts, never including `userId` itself.
    readonly contactsOf: (
      userId: number,
    ) => Effect.Effect<ReadonlyArray<number>>;
  }
>()("PresenceAudience") {}

const others = alias(chatParticipants, "others");

export const PresenceAudienceLive = Layer.effect(
  PresenceAudience,
  Effect.gen(function* () {
    const db = yield* Db;

    // Self-join on chat_participants: `chat_participants_user_id_idx` finds
    // the user's chats, the (chatId, userId) unique index their co-members.
    const contactsOf: PresenceAudience["Service"]["contactsOf"] = (userId) =>
      Effect.tryPromise(() =>
        db
          .selectDistinct({ userId: others.userId })
          .from(chatParticipants)
          .innerJoin(others, eq(others.chatId, chatParticipants.chatId))
          .where(
            and(
              eq(chatParticipants.userId, userId),
              ne(others.userId, userId),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(userBlocks)
                  .where(
                    and(
                      eq(userBlocks.type, "block"),
                      or(
                        and(
                          eq(userBlocks.blockerId, userId),
                          eq(userBlocks.blockedId, others.userId),
                        ),
                        and(
                          eq(userBlocks.blockerId, others.userId),
                          eq(userBlocks.blockedId, userId),
                        ),
                      ),
                    ),
                  ),
              ),
            ),
          ),
      ).pipe(
        Effect.map((rows) => rows.map((row) => row.userId)),
        // Best-effort like the push itself (see Realtime.ts): a failed
        // lookup suppresses this one presence/status update rather than
        // failing a `/ws` connection or the mutation that triggered it.
        Effect.catch((error) =>
          Effect.logWarning(
            "PresenceAudience: contact lookup failed, presence update suppressed",
          ).pipe(
            Effect.annotateLogs({ userId, error: String(error) }),
            Effect.as([] as ReadonlyArray<number>),
          ),
        ),
      );

    return { contactsOf };
  }),
);

// A fixed contact graph, for tests that drive RealtimeConnections without a
// database. `pairs` are symmetric, like sharing a chat.
export const staticPresenceAudience = (
  pairs: ReadonlyArray<readonly [number, number]>,
) =>
  Layer.succeed(PresenceAudience, {
    contactsOf: (userId) =>
      Effect.succeed([
        ...new Set(
          pairs.flatMap(([a, b]) =>
            a === userId ? [b] : b === userId ? [a] : [],
          ),
        ),
      ]),
  });
