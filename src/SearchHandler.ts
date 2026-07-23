import { HttpApiBuilder } from "@effect/platform";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  ChatApi,
  DEFAULT_SEARCH_LIMIT,
  InvalidSearchRequest,
  type Comment,
  type Message,
  type MessageSearchChat,
  type Post,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import {
  commentReactionInfo,
  messageReactionInfo,
  postReactionInfo,
  type ReactionSummary,
} from "./reactions.ts";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  parseSnippet,
  TS_HEADLINE_OPTIONS,
} from "./search.ts";
import { effectiveStatus, toAvatarVariants } from "./UsersHandler.ts";
import {
  chatParticipants,
  chats,
  comments,
  messageReads,
  messages,
  posts,
  users,
} from "./db/schema.ts";

const NO_REACTIONS: ReactionSummary[] = [];

// The Postgres text-search config, inlined as a SQL literal rather than a bound
// parameter: it's a fixed, server-controlled constant (never user input), and
// `websearch_to_tsquery`/`ts_headline` take it as a `regconfig`, which a bound
// text parameter wouldn't resolve to. Must stay equal to `SEARCH_CONFIG` in
// search.ts (and the config baked into the generated columns in migration
// 0016).
const CONFIG = sql`'english'`;

// `websearch_to_tsquery` (not `to_tsquery`/`plainto_tsquery`) parses a
// user-facing query grammar — quoted phrases, `or`, leading `-` to exclude —
// and, crucially, never raises on malformed input (unbalanced quotes, stray
// operators): it just yields the best query it can, so a half-typed search box
// can't turn into a 500. `q` is always a bound parameter, so its contents are
// data, never SQL.
const tsQuery = (q: string) => sql`websearch_to_tsquery(${CONFIG}, ${q})`;

// `ts_headline` re-runs the same query against the row's own text to produce a
// windowed, delimiter-wrapped excerpt around the match (see search.ts for the
// delimiter/parse rationale).
const headline = (column: ReturnType<typeof sql>, q: string) =>
  sql<string>`ts_headline(${CONFIG}, ${column}, ${tsQuery(q)}, ${TS_HEADLINE_OPTIONS})`;

// Resolves the opaque cursor to an id, or fails with a typed 400 — shared by
// all three endpoints. Returns `null` when no cursor was supplied (first page).
const resolveCursor = (cursor: string | undefined) =>
  Effect.gen(function* () {
    if (cursor === undefined) return null;
    const id = decodeSearchCursor(cursor);
    if (id === null)
      return yield* Effect.fail(
        new InvalidSearchRequest({ message: "Invalid cursor" }),
      );
    return id;
  });

const toApiPost = (
  row: typeof posts.$inferSelect,
  reactions: ReadonlyArray<ReactionSummary> = NO_REACTIONS,
): Post => ({
  id: row.id,
  authorId: row.authorId,
  contentType: row.contentType,
  content: row.content,
  // A `tsvector` match only ever comes from `content_type = 'text'` rows (the
  // generated column is empty otherwise — see migration 0016), which never
  // carry an attachment, so this is always null for a search hit.
  attachment: null,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  reactions: [...reactions],
});

const toApiComment = (
  row: typeof comments.$inferSelect,
  reactions: ReadonlyArray<ReactionSummary> = NO_REACTIONS,
): Comment => ({
  id: row.id,
  postId: row.postId,
  parentCommentId: row.parentCommentId,
  authorId: row.authorId,
  content: row.content,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  reactions: [...reactions],
});

const toApiMessage = (
  row: typeof messages.$inferSelect,
  readByUserIds: ReadonlyArray<number>,
  reactions: ReadonlyArray<ReactionSummary> = NO_REACTIONS,
): Message => ({
  id: row.id,
  chatId: row.chatId,
  senderId: row.senderId,
  contentType: row.contentType,
  content: row.content,
  // Same reasoning as `toApiPost`: a message hit is always a text message.
  attachment: null,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  readByUserIds: [...readByUserIds],
  reactions: [...reactions],
});

// Batches the `MessageSearchChat` context for every chat referenced by a page
// of message hits in two queries (the chats, and all their participants) rather
// than one round trip per hit — keeps `searchMessages` at a fixed query count
// regardless of how many results a page holds.
const loadMessageSearchChats = (
  db: DrizzleDb,
  chatIds: ReadonlyArray<number>,
): Effect.Effect<MessageSearchChat[]> =>
  Effect.gen(function* () {
    if (chatIds.length === 0) return [];
    const chatRows = yield* Effect.tryPromise(() =>
      db
        .select({ id: chats.id, type: chats.type, title: chats.title })
        .from(chats)
        .where(inArray(chats.id, [...chatIds])),
    ).pipe(Effect.orDie);
    const participantRows = yield* Effect.tryPromise(() =>
      db
        .select({
          chatId: chatParticipants.chatId,
          userId: chatParticipants.userId,
          username: users.username,
          displayName: users.displayName,
          avatarUrl: users.avatarUrl,
          avatarSmall: users.avatarSmall,
          avatarMedium: users.avatarMedium,
          avatarLarge: users.avatarLarge,
          role: chatParticipants.role,
          statusText: users.statusText,
          statusEmoji: users.statusEmoji,
          statusExpiresAt: users.statusExpiresAt,
        })
        .from(chatParticipants)
        .innerJoin(users, eq(users.id, chatParticipants.userId))
        .where(inArray(chatParticipants.chatId, [...chatIds])),
    ).pipe(Effect.orDie);

    const byChat = new Map<
      number,
      MessageSearchChat["participants"][number][]
    >();
    for (const {
      chatId,
      avatarSmall,
      avatarMedium,
      avatarLarge,
      statusText,
      statusEmoji,
      statusExpiresAt,
      ...rest
    } of participantRows) {
      const list = byChat.get(chatId) ?? [];
      list.push({
        ...rest,
        avatarVariants: toAvatarVariants({
          avatarSmall,
          avatarMedium,
          avatarLarge,
        }),
        ...effectiveStatus({ statusText, statusEmoji, statusExpiresAt }),
      });
      byChat.set(chatId, list);
    }
    return chatRows.map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title,
      participants: byChat.get(c.id) ?? [],
    }));
  });

export const SearchHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "search",
  (handlers) =>
    handlers
      .handle("searchPosts", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const limit = urlParams.limit ?? DEFAULT_SEARCH_LIMIT;
          const after = yield* resolveCursor(urlParams.cursor);
          const q = urlParams.q;

          // A match against the (empty-for-non-text) generated `search_vector`
          // already restricts to text posts, so no explicit content_type
          // filter is needed. Fetch one past `limit` to derive `nextCursor`
          // without a separate COUNT (same trick as listPosts, issue #51).
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: posts.id,
                authorId: posts.authorId,
                contentType: posts.contentType,
                content: posts.content,
                attachmentId: posts.attachmentId,
                createdAt: posts.createdAt,
                updatedAt: posts.updatedAt,
                snippet: headline(sql`${posts.content}`, q),
              })
              .from(posts)
              .where(
                and(
                  sql`"posts"."search_vector" @@ ${tsQuery(q)}`,
                  after !== null ? lt(posts.id, after) : undefined,
                ),
              )
              .orderBy(desc(posts.id))
              .limit(limit + 1),
          ).pipe(Effect.orDie);

          const hasMore = rows.length > limit;
          const page = rows.slice(0, limit);
          const lastRow = page[page.length - 1];
          const nextCursor =
            hasMore && lastRow ? encodeSearchCursor(lastRow.id) : null;

          const reactionInfo = yield* Effect.tryPromise(() =>
            postReactionInfo(
              db,
              page.map((r) => r.id),
              currentUser.id,
            ),
          ).pipe(Effect.orDie);

          return {
            results: page.map((r) => ({
              post: toApiPost(r, reactionInfo.get(r.id)),
              snippet: parseSnippet(r.snippet),
            })),
            limit,
            nextCursor,
          };
        }),
      )
      .handle("searchComments", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const limit = urlParams.limit ?? DEFAULT_SEARCH_LIMIT;
          const after = yield* resolveCursor(urlParams.cursor);
          const q = urlParams.q;

          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: comments.id,
                postId: comments.postId,
                parentCommentId: comments.parentCommentId,
                authorId: comments.authorId,
                content: comments.content,
                createdAt: comments.createdAt,
                updatedAt: comments.updatedAt,
                snippet: headline(sql`${comments.content}`, q),
              })
              .from(comments)
              .where(
                and(
                  sql`"comments"."search_vector" @@ ${tsQuery(q)}`,
                  after !== null ? lt(comments.id, after) : undefined,
                ),
              )
              .orderBy(desc(comments.id))
              .limit(limit + 1),
          ).pipe(Effect.orDie);

          const hasMore = rows.length > limit;
          const page = rows.slice(0, limit);
          const lastRow = page[page.length - 1];
          const nextCursor =
            hasMore && lastRow ? encodeSearchCursor(lastRow.id) : null;

          const reactionInfo = yield* Effect.tryPromise(() =>
            commentReactionInfo(
              db,
              page.map((r) => r.id),
              currentUser.id,
            ),
          ).pipe(Effect.orDie);

          return {
            results: page.map((r) => ({
              comment: toApiComment(r, reactionInfo.get(r.id)),
              snippet: parseSnippet(r.snippet),
            })),
            limit,
            nextCursor,
          };
        }),
      )
      .handle("searchMessages", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const limit = urlParams.limit ?? DEFAULT_SEARCH_LIMIT;
          const after = yield* resolveCursor(urlParams.cursor);
          const q = urlParams.q;

          // The inner join on the caller's own participant row is the access
          // control: a message in a chat they're not part of can never appear,
          // no matter what it matches. `content_type = 'text'` is implied by
          // the empty-vector-for-non-text rule, as in searchPosts.
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: messages.id,
                chatId: messages.chatId,
                senderId: messages.senderId,
                contentType: messages.contentType,
                content: messages.content,
                attachmentId: messages.attachmentId,
                createdAt: messages.createdAt,
                updatedAt: messages.updatedAt,
                snippet: headline(sql`${messages.content}`, q),
              })
              .from(messages)
              .innerJoin(
                chatParticipants,
                and(
                  eq(chatParticipants.chatId, messages.chatId),
                  eq(chatParticipants.userId, currentUser.id),
                ),
              )
              .where(
                and(
                  sql`"messages"."search_vector" @@ ${tsQuery(q)}`,
                  after !== null ? lt(messages.id, after) : undefined,
                ),
              )
              .orderBy(desc(messages.id))
              .limit(limit + 1),
          ).pipe(Effect.orDie);

          const hasMore = rows.length > limit;
          const page = rows.slice(0, limit);
          const lastRow = page[page.length - 1];
          const nextCursor =
            hasMore && lastRow ? encodeSearchCursor(lastRow.id) : null;

          const messageIds = page.map((r) => r.id);
          const readRows =
            messageIds.length === 0
              ? []
              : yield* Effect.tryPromise(() =>
                  db
                    .select({
                      messageId: messageReads.messageId,
                      userId: messageReads.userId,
                    })
                    .from(messageReads)
                    .where(inArray(messageReads.messageId, messageIds)),
                ).pipe(Effect.orDie);
          const readersByMessage = new Map<number, number[]>();
          for (const r of readRows) {
            const list = readersByMessage.get(r.messageId) ?? [];
            list.push(r.userId);
            readersByMessage.set(r.messageId, list);
          }

          const reactionsByMessage = yield* Effect.tryPromise(() =>
            messageReactionInfo(db, messageIds, currentUser.id),
          ).pipe(Effect.orDie);

          const chatIds = [...new Set(page.map((r) => r.chatId))];
          const searchChats = yield* loadMessageSearchChats(db, chatIds);

          return {
            results: page.map((r) => ({
              message: toApiMessage(
                r,
                readersByMessage.get(r.id) ?? [],
                reactionsByMessage.get(r.id),
              ),
              snippet: parseSnippet(r.snippet),
            })),
            chats: searchChats,
            limit,
            nextCursor,
          };
        }),
      ),
);
