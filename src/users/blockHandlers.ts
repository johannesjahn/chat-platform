import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { InvalidBlockRequest, NotFound } from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { userBlocks, users } from "../db/schema.ts";
import { type UsersDeps, type UsersHandlers } from "./handlerKit.ts";
import { publicUserColumns, toPublicUser } from "./userViews.ts";
import { dbQuery } from "../Db.ts";

export const blockHandlers = ({ db }: UsersDeps) =>
  ({
    listBlocks: () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const rows = yield* dbQuery(() =>
          db
            .select({
              ...publicUserColumns,
              blockType: userBlocks.type,
              blockedAt: userBlocks.createdAt,
            })
            .from(userBlocks)
            .innerJoin(users, eq(users.id, userBlocks.blockedId))
            // Newest relationship first — the order the settings card lists
            // them in. `id` (not `createdAt`) so re-issuing block↔mute on an
            // existing pair, which keeps the original row, doesn't reorder.
            .orderBy(desc(userBlocks.id))
            .where(eq(userBlocks.blockerId, currentUser.id)),
        );
        return rows.map(({ blockType, blockedAt, ...userRow }) => ({
          user: toPublicUser(userRow),
          type: blockType,
          createdAt: blockedAt.getTime(),
        }));
      }),
    setBlock: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        if (id === currentUser.id)
          return yield* Effect.fail(
            new InvalidBlockRequest({
              message: "You can't block or mute yourself",
            }),
          );

        // The target must exist — otherwise the FK would reject the insert
        // as a die; surface a clean 404 instead.
        const targetRows = yield* dbQuery(() =>
          db
            .select(publicUserColumns)
            .from(users)
            .where(eq(users.id, id))
            .limit(1),
        );
        const target = targetRows[0];
        if (!target)
          return yield* Effect.fail(
            new NotFound({ message: `User ${id} not found` }),
          );

        // Upsert on the (blocker, blocked) unique constraint: a first block/
        // mute inserts, and re-issuing the other action on the same target
        // updates the existing row's `type` in place (keeping its original
        // `createdAt`) rather than stacking a second relationship.
        const inserted = yield* dbQuery(() =>
          db
            .insert(userBlocks)
            .values({
              blockerId: currentUser.id,
              blockedId: id,
              type: payload.type,
            })
            .onConflictDoUpdate({
              target: [userBlocks.blockerId, userBlocks.blockedId],
              set: { type: payload.type },
            })
            .returning({
              type: userBlocks.type,
              createdAt: userBlocks.createdAt,
            }),
        );
        const row = inserted[0];
        if (!row)
          return yield* Effect.die(new Error("UPSERT returned no rows"));

        return {
          user: toPublicUser(target),
          type: row.type,
          createdAt: row.createdAt.getTime(),
        };
      }),
    removeBlock: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        // Idempotent — deleting a non-existent relationship is a no-op that
        // still succeeds, so unblocking/unmuting never 404s.
        yield* dbQuery(() =>
          db
            .delete(userBlocks)
            .where(
              and(
                eq(userBlocks.blockerId, currentUser.id),
                eq(userBlocks.blockedId, id),
              ),
            ),
        );
      }),
  }) satisfies UsersHandlers;
