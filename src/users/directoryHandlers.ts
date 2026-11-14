import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  max,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import {
  DEFAULT_POSTS_LIMIT,
  InvalidPostsRequest,
  InvalidUsernameLookupRequest,
  InvalidUserSearchRequest,
  MAX_CONTACTS,
  MAX_USERNAME_LOOKUP_COUNT,
  MIN_USER_SEARCH_QUERY_LENGTH,
  NotFound,
} from "../Api.ts";
import { resolveAttachments } from "../attachments.ts";
import { CurrentUser } from "../Auth.ts";
import { blockedOrMutedUserIds } from "../blocks.ts";
import { type DrizzleDb } from "../Db.ts";

import { postReactionInfo } from "../reactions.ts";
import { containsPattern } from "../search.ts";
import {
  chatParticipants,
  chats,
  userBlocks,
  users,
  posts,
} from "../db/schema.ts";
import { type UsersDeps, type UsersHandlers } from "./handlerKit.ts";
import { publicUserColumns, toPublicUser, toUserProfile } from "./userViews.ts";
import {
  decodePostsCursor,
  encodePostsCursor,
  postCommentCounts,
  toApiPost,
  withAuthors,
} from "../posts.ts";

// Caps a single search response regardless of how many usernames match, so
// the payload stays bounded independent of the user base's size.
const USER_SEARCH_RESULTS_LIMIT = 20;

// A user's contacts, for the suggestions shown before a directory search
// (issue #764): everyone they share a chat with, ordered by that chat's
// latest activity (`chats.updated_at`, bumped on every message), newest
// first. It's the relationship `PresenceAudience` shares presence over —
// only an *accepted* chat introduces anyone (a pending message request,
// issue #785, on either side doesn't), and a block in either direction
// hides the pair from each other (a mute doesn't: it never stops messaging
// either). Never includes `userId` itself.
//
// This must only ever return people `userId` already shares a chat with:
// it's what lets the client suggest people for a 1–2 character query
// without reopening the browsable directory that `/users/search`'s
// 3-character floor closed (issue #48).
const contactParticipants = alias(chatParticipants, "contact_participants");

export const contactsOf = (db: DrizzleDb, userId: number, limit: number) =>
  db
    .select(publicUserColumns)
    .from(chatParticipants)
    .innerJoin(chats, eq(chats.id, chatParticipants.chatId))
    .innerJoin(
      contactParticipants,
      eq(contactParticipants.chatId, chatParticipants.chatId),
    )
    .innerJoin(users, eq(users.id, contactParticipants.userId))
    .where(
      and(
        eq(chatParticipants.userId, userId),
        ne(contactParticipants.userId, userId),
        eq(chatParticipants.requestPending, false),
        eq(contactParticipants.requestPending, false),
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
                    eq(userBlocks.blockedId, contactParticipants.userId),
                  ),
                  and(
                    eq(userBlocks.blockerId, contactParticipants.userId),
                    eq(userBlocks.blockedId, userId),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    // `users.id` is the primary key, so the other selected `users` columns
    // are functionally dependent on it and Postgres accepts them ungrouped.
    .groupBy(users.id)
    .orderBy(desc(max(chats.updatedAt)), desc(users.id))
    .limit(limit);

export const directoryHandlers = ({ db, storage }: UsersDeps) =>
  ({
    searchUsers: ({ query: { q } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        // Only admins may browse the full directory — a query shorter
        // than the minimum keeps ILIKE's cost/result-size bounded (issue
        // #48) for anyone else.
        if (
          currentUser.role !== "admin" &&
          q.length < MIN_USER_SEARCH_QUERY_LENGTH
        )
          return yield* Effect.fail(
            new InvalidUserSearchRequest({
              message: `q must be at least ${MIN_USER_SEARCH_QUERY_LENGTH} characters`,
            }),
          );

        const pattern = containsPattern(q);
        const rows = yield* Effect.tryPromise(() =>
          db
            .select({
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
              role: users.role,
              statusText: users.statusText,
              statusEmoji: users.statusEmoji,
              statusExpiresAt: users.statusExpiresAt,
            })
            .from(users)
            // Matches a fragment of either name, not just the username —
            // both columns carry a GIN trigram index (migration 0023), so
            // this stays an index lookup rather than the sequential scan an
            // unanchored ILIKE used to force.
            .where(
              or(
                ilike(users.username, pattern),
                ilike(users.displayName, pattern),
              ),
            )
            .orderBy(users.username)
            .limit(USER_SEARCH_RESULTS_LIMIT),
        ).pipe(Effect.orDie);
        return rows.map(toPublicUser);
      }),
    listContacts: () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const rows = yield* Effect.tryPromise(() =>
          contactsOf(db, currentUser.id, MAX_CONTACTS),
        ).pipe(Effect.orDie);
        return rows.map(toPublicUser);
      }),
    lookupUsersByUsername: ({ query: { usernames } }) =>
      Effect.gen(function* () {
        // The parameter is one comma-separated batch (see
        // `UsernameLookupQuery`); blanks and duplicates are dropped
        // before the cap is applied, so a sloppily-joined list ("a,,a")
        // costs a caller nothing.
        const names = [
          ...new Set(
            usernames
              .split(",")
              .map((name) => name.trim().toLowerCase())
              .filter((name) => name.length > 0),
          ),
        ];
        if (names.length > MAX_USERNAME_LOOKUP_COUNT)
          return yield* Effect.fail(
            new InvalidUsernameLookupRequest({
              message: `usernames must name at most ${MAX_USERNAME_LOOKUP_COUNT} users`,
            }),
          );
        if (names.length === 0) return [];

        const rows = yield* Effect.tryPromise(() =>
          db
            .select(publicUserColumns)
            .from(users)
            // `lower(username)` is exactly the expression the unique
            // index is built on (see db/schema.ts), so this stays an
            // index lookup rather than a scan.
            .where(inArray(sql`lower(${users.username})`, names))
            .orderBy(users.username),
        ).pipe(Effect.orDie);
        // Names with no account are simply missing from the result — the
        // client renders those mentions as plain text.
        return rows.map(toPublicUser);
      }),
    getUser: ({ params: { id } }) =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise(() =>
          db
            .select({
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
              role: users.role,
              statusText: users.statusText,
              statusEmoji: users.statusEmoji,
              statusExpiresAt: users.statusExpiresAt,
              bio: users.bio,
            })
            .from(users)
            .where(eq(users.id, id))
            .limit(1),
        ).pipe(Effect.orDie);
        if (!rows[0])
          return yield* Effect.fail(
            new NotFound({ message: `User ${id} not found` }),
          );
        return toUserProfile(rows[0]);
      }),
    listUserPosts: ({ params: { id }, query: urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const limit = urlParams.limit ?? DEFAULT_POSTS_LIMIT;

        const targetRows = yield* Effect.tryPromise(() =>
          db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, id))
            .limit(1),
        ).pipe(Effect.orDie);
        if (!targetRows[0])
          return yield* Effect.fail(
            new NotFound({ message: `User ${id} not found` }),
          );

        let after: number | null = null;
        if (urlParams.cursor !== undefined) {
          after = decodePostsCursor(urlParams.cursor);
          if (after === null)
            return yield* Effect.fail(
              new InvalidPostsRequest({ message: "Invalid cursor" }),
            );
        }

        // Same "fetch one row past `limit`" trick as `listPosts` to derive
        // `nextCursor` without a separate query (issue #51's rationale) —
        // `totalCount` below is the one place this endpoint does pay for a
        // dedicated `COUNT(*)`, since it's scoped to a single author and
        // backed by `posts_author_id_idx` rather than scanning all posts.
        const fetched = yield* Effect.tryPromise(() =>
          db
            .select()
            .from(posts)
            .where(
              and(
                eq(posts.authorId, id),
                after !== null ? lt(posts.id, after) : undefined,
              ),
            )
            .orderBy(desc(posts.id))
            .limit(limit + 1),
        ).pipe(Effect.orDie);
        const hasMore = fetched.length > limit;
        const page = fetched.slice(0, limit);
        const lastRow = page[page.length - 1];
        const nextCursor =
          hasMore && lastRow ? encodePostsCursor(lastRow.id) : null;
        // Every row has the same author here, but going through the shared
        // batch keeps one code path for `Post.author` (issue #750).
        const authored = yield* withAuthors(db, page);
        const rows = authored.map((a) => a.row);

        const reactionInfo = yield* Effect.tryPromise(() =>
          postReactionInfo(
            db,
            rows.map((r) => r.id),
            currentUser.id,
          ),
        ).pipe(Effect.orDie);
        const commentCounts = yield* Effect.tryPromise(async () =>
          postCommentCounts(
            db,
            rows.map((r) => r.id),
            await blockedOrMutedUserIds(db, currentUser.id),
          ),
        ).pipe(Effect.orDie);
        const attachments = yield* resolveAttachments(
          db,
          storage,
          rows.map((r) => r.attachmentId),
        );
        const totalRows = yield* Effect.tryPromise(() =>
          db
            .select({ total: count() })
            .from(posts)
            .where(eq(posts.authorId, id)),
        ).pipe(Effect.orDie);

        return {
          posts: authored.map(({ row: r, author }) =>
            toApiPost(
              r,
              author,
              reactionInfo.get(r.id),
              r.attachmentId !== null
                ? (attachments.get(r.attachmentId) ?? null)
                : null,
              commentCounts.get(r.id) ?? 0,
            ),
          ),
          limit,
          nextCursor,
          totalCount: Number(totalRows[0]?.total ?? 0),
        };
      }),
  }) satisfies UsersHandlers;
