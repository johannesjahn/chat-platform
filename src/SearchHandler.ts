import { HttpApiBuilder } from "@effect/platform";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import {
  ChatApi,
  DEFAULT_SEARCH_ALL_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  InvalidSearchRequest,
  MIN_USER_SEARCH_QUERY_LENGTH,
  type MessageSearchChat,
  type SearchSnippetSegment,
  type User,
} from "./Api.ts";
import { blockedOrMutedUserIds } from "./blocks.ts";
import { CurrentUser } from "./Auth.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import {
  buildSnippet,
  containsPattern,
  decodeSearchCursor,
  decodeUserSearchCursor,
  encodeSearchCursor,
  encodeUserSearchCursor,
  highlightRanges,
  searchTokens,
  startsWithPattern,
  substringTokens,
  toPrefixTsQuery,
} from "./search.ts";
import { effectiveStatus, toAvatarVariants } from "./UsersHandler.ts";
import {
  chatParticipants,
  chats,
  comments,
  messages,
  posts,
  users,
} from "./db/schema.ts";

// The Postgres text-search config, inlined as a SQL literal rather than a bound
// parameter: it's a fixed, server-controlled constant (never user input), and
// `to_tsquery` takes it as a `regconfig`, which a bound text parameter wouldn't
// resolve to. Must stay equal to `SEARCH_CONFIG` in search.ts (and the config
// baked into the generated columns in migration 0017).
const CONFIG = sql`'english'`;

// Matches nothing, for a query that produced no usable branch at all (e.g.
// `q` is nothing but punctuation). Cheaper and clearer than special-casing an
// empty result in every handler.
const MATCHES_NOTHING = sql`false`;

// The two match branches, as separate predicates (see the long comment at the
// top of search.ts):
//
//   * the word/prefix branch, against the generated `tsvector` (GIN, migration
//     0017) — language-aware: stemming plus a trailing `:*` on every token, so
//     "run" finds "running" and a half-typed "jum" finds "jumps";
//   * the substring branch, `ILIKE '%token%'` per token (GIN trigram,
//     migration 0023) — literal-minded: finds a fragment *inside* a word,
//     which no `tsvector` can express.
//
// They're returned separately, not OR'd, on purpose — see `matchingIds`.
//
// `q` never reaches SQL as text: the tsquery is assembled from
// letters/digits-only tokens and bound as a parameter, and every ILIKE pattern
// is bound with its wildcards escaped.
const matchBranches = (vector: SQL, content: PgColumn, q: string): SQL[] => {
  const branches: SQL[] = [];

  const tsQuery = toPrefixTsQuery(q);
  if (tsQuery !== null)
    branches.push(sql`${vector} @@ to_tsquery(${CONFIG}, ${tsQuery})`);

  // Every token must appear as a substring — an AND, so a two-word query stays
  // as selective here as it is in the tsquery branch. The planner drives the
  // scan off whichever token the trigram index likes best and filters the
  // rest.
  const tokens = substringTokens(q);
  if (tokens.length > 0) {
    const clause = and(
      ...tokens.map((t) => ilike(content, containsPattern(t))),
    );
    if (clause) branches.push(clause);
  }

  return branches;
};

// Restricts a search to the ids matching *any* branch, as a union of
// per-branch subqueries rather than the `OR` the two branches read like.
//
// This is the single most important shape in the file. Written as
// `WHERE tsvector_match OR content ILIKE '…'`, Postgres cannot use either
// index: an OR over two different indexes with `ORDER BY id DESC LIMIT n` on
// top collapses into one backward scan of the primary key that re-evaluates
// both predicates per row — so a term that matches only a handful of rows
// walks the entire table. Split into a union, each arm is planned (and
// index-served) on its own and capped at the page size, and the outer query
// only ever touches the rows that survive. Measured on 20k posts with a rare
// term: 37ms as an OR, 9ms as this union — and the gap widens linearly with
// the table, because the OR plan's per-row `ILIKE` never stops growing.
//
// Every filter (the content-type restriction, the keyset cursor, the
// blocked-author exclusion, the chat-participant access check) has to live
// *inside* each arm: an arm returns only its own newest `limit` ids, so a
// filter applied outside would silently shrink the page instead of pushing it
// deeper.
const matchingIds = (
  idColumn: PgColumn,
  branches: SQL[],
  arm: (branch: SQL) => SQL,
  limit: number,
): SQL => {
  if (branches.length === 0) return MATCHES_NOTHING;
  const arms = branches.map((branch) => sql`(${arm(branch)})`);
  return sql`${idColumn} in (select "id" from (${sql.join(
    arms,
    sql` union `,
  )}) as "matches" order by "id" desc limit ${limit})`;
};

// The generated tsvector columns are deliberately absent from the Drizzle
// schema (a bare `db.select()` would otherwise materialize them on every hot
// read — see migration 0017), so they're referenced by raw, fully-qualified
// SQL here.
const postsVector = sql`"posts"."search_vector"`;
const commentsVector = sql`"comments"."search_vector"`;
const messagesVector = sql`"messages"."search_vector"`;

// The `users` columns every joined-in author/sender selects, folded into the
// API's `User` shape by `toSearchUser`. Mirrors `publicUserColumns` in
// UsersHandler.ts (not exported from there — this is the search projection,
// and keeping it local lets it be aliased into a join without coupling the two
// handlers' column lists).
const userColumns = {
  userId: users.id,
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
} as const;

type UserRow = {
  userId: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarSmallKey: string | null;
  avatarMediumKey: string | null;
  avatarLargeKey: string | null;
  role: "user" | "admin";
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: Date | null;
};

const toSearchUser = (row: UserRow): User => ({
  id: row.userId,
  username: row.username,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl,
  avatarVariants: toAvatarVariants(row),
  role: row.role,
  ...effectiveStatus(row),
});

// Every DB call in this module is a plain read whose failure is a bug, not a
// domain outcome — same `orDie` treatment the other handlers give their
// queries.
const query = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);

// Resolves the opaque id cursor, or fails with a typed 400. Returns `null`
// when no cursor was supplied (first page).
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

// Fetching one row past `limit` is how every page derives `nextCursor`
// without a separate `COUNT(*)` (same trick as `listPosts`, issue #51).
const splitPage = <A>(rows: A[], limit: number) => ({
  page: rows.slice(0, limit),
  hasMore: rows.length > limit,
});

// Authors the viewer has blocked or muted — their posts and comments are
// hidden from search exactly as they're hidden from the feed (issue #219).
// Resolved once per request and shared by both sections.
const hiddenAuthorIds = (db: DrizzleDb, viewerId: number) =>
  query(() => blockedOrMutedUserIds(db, viewerId));

const excludeAuthors = (column: PgColumn, ids: ReadonlyArray<number>) =>
  ids.length > 0 ? notInArray(column, [...ids]) : undefined;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// How well a user row matches, lowest first: an exact username, then a name
// that starts with the query, then a match anywhere inside either name. This
// is the one search that isn't ordered by recency — "find a person" is a
// name-completion task, and a newest-account-first list would bury the obvious
// answer.
const userMatchRank = (q: string) => sql<number>`case
    when lower(${users.username}) = lower(${q}) then 0
    when ${users.username} ilike ${startsWithPattern(q)} then 1
    when ${users.displayName} ilike ${startsWithPattern(q)} then 2
    else 3
  end`;

// The people section keeps `searchUsers`' own floor (issue #48): the user
// directory isn't browsable by everyone, only searchable with a query narrow
// enough to be about someone in particular. Below it a non-admin's people
// results are simply empty — not an error, so the *other* sections of a
// two-character search still answer normally. Admins are exempt, as they are
// on `GET /users/search`.
const peopleSearchAllowed = (q: string, role: "user" | "admin"): boolean =>
  role === "admin" || q.length >= MIN_USER_SEARCH_QUERY_LENGTH;

// A person matches when every token appears somewhere in their username or
// display name — "jo sm" finds "josmith"/"Jo Smith" either way round. Tokens
// of at least three characters are served by the trigram indexes on both
// columns (migration 0023); a shorter one is filtered after them.
const matchesUser = (q: string): SQL => {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return MATCHES_NOTHING;
  const perToken = tokens.map((t) => {
    const pattern = containsPattern(t);
    return or(
      ilike(users.username, pattern),
      ilike(users.displayName, pattern),
    );
  });
  return and(...perToken) ?? MATCHES_NOTHING;
};

// Highlights the fragment inside whichever name actually matched, preferring
// the display name when it's the one that contains it (that's the label the UI
// renders).
const userSnippet = (
  username: string,
  displayName: string | null,
  q: string,
): SearchSnippetSegment[] =>
  displayName !== null && highlightRanges(displayName, q).length > 0
    ? buildSnippet(displayName, q)
    : buildSnippet(username, q);

const searchUsersPage = (
  db: DrizzleDb,
  viewerRole: "user" | "admin",
  q: string,
  limit: number,
  cursor: string | undefined,
) =>
  Effect.gen(function* () {
    if (!peopleSearchAllowed(q, viewerRole))
      return { results: [], limit, nextCursor: null };

    // People are ordered by (rank, name, id) rather than by id, so their
    // cursor has to carry all three — see `encodeUserSearchCursor`.
    let after = null as { rank: number; username: string; id: number } | null;
    if (cursor !== undefined) {
      after = decodeUserSearchCursor(cursor);
      if (after === null)
        return yield* Effect.fail(
          new InvalidSearchRequest({ message: "Invalid cursor" }),
        );
    }
    const rank = userMatchRank(q);
    const sortName = sql<string>`lower(${users.username})`;

    const rows = yield* query(() =>
      db
        .select({ ...userColumns, rank, sortName })
        .from(users)
        .where(
          and(
            matchesUser(q),
            // Keyset resume over the composite sort, as a row comparison so
            // it stays a single predicate (and matches the ORDER BY exactly).
            after !== null
              ? sql`(${rank}, ${sortName}, ${users.id}) > (${after.rank}::int, ${after.username}::text, ${after.id}::int)`
              : undefined,
          ),
        )
        .orderBy(rank, sortName, users.id)
        .limit(limit + 1),
    );

    const { page, hasMore } = splitPage(rows, limit);
    const last = page[page.length - 1];
    return {
      results: page.map((row) => ({
        user: toSearchUser(row),
        snippet: userSnippet(row.username, row.displayName, q),
      })),
      limit,
      nextCursor:
        hasMore && last
          ? encodeUserSearchCursor({
              rank: last.rank,
              username: last.sortName,
              id: last.userId,
            })
          : null,
    };
  });

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

const searchPostsPage = (
  db: DrizzleDb,
  q: string,
  limit: number,
  after: number | null,
  hidden: ReadonlyArray<number>,
) =>
  query(() =>
    db
      .select({
        id: posts.id,
        content: posts.content,
        createdAt: posts.createdAt,
        ...userColumns,
      })
      .from(posts)
      .innerJoin(users, eq(users.id, posts.authorId))
      .where(
        matchingIds(
          posts.id,
          matchBranches(postsVector, posts.content, q),
          (branch) =>
            sql`select ${posts.id} from ${posts} where ${and(
              // Matches the partial trigram index's predicate (migration 0023)
              // and mirrors what the generated tsvector already implies: an
              // image URL or attachment caption isn't searchable content.
              eq(posts.contentType, "text"),
              branch,
              after !== null ? lt(posts.id, after) : undefined,
              excludeAuthors(posts.authorId, hidden),
            )} order by ${posts.id} desc limit ${limit + 1}`,
          limit + 1,
        ),
      )
      .orderBy(desc(posts.id))
      .limit(limit + 1),
  ).pipe(
    Effect.map((rows) => {
      const { page, hasMore } = splitPage(rows, limit);
      const last = page[page.length - 1];
      return {
        results: page.map((row) => ({
          id: row.id,
          author: toSearchUser(row),
          createdAt: row.createdAt.getTime(),
          snippet: buildSnippet(row.content, q),
        })),
        limit,
        nextCursor: hasMore && last ? encodeSearchCursor(last.id) : null,
      };
    }),
  );

// ---------------------------------------------------------------------------
// Comments and replies
// ---------------------------------------------------------------------------

const searchCommentsPage = (
  db: DrizzleDb,
  q: string,
  limit: number,
  after: number | null,
  hidden: ReadonlyArray<number>,
) =>
  query(() =>
    db
      .select({
        id: comments.id,
        postId: comments.postId,
        parentCommentId: comments.parentCommentId,
        content: comments.content,
        createdAt: comments.createdAt,
        ...userColumns,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(
        matchingIds(
          comments.id,
          matchBranches(commentsVector, comments.content, q),
          (branch) =>
            sql`select ${comments.id} from ${comments} where ${and(
              branch,
              after !== null ? lt(comments.id, after) : undefined,
              excludeAuthors(comments.authorId, hidden),
            )} order by ${comments.id} desc limit ${limit + 1}`,
          limit + 1,
        ),
      )
      .orderBy(desc(comments.id))
      .limit(limit + 1),
  ).pipe(
    Effect.map((rows) => {
      const { page, hasMore } = splitPage(rows, limit);
      const last = page[page.length - 1];
      return {
        results: page.map((row) => ({
          id: row.id,
          postId: row.postId,
          parentCommentId: row.parentCommentId,
          author: toSearchUser(row),
          createdAt: row.createdAt.getTime(),
          snippet: buildSnippet(row.content, q),
        })),
        limit,
        nextCursor: hasMore && last ? encodeSearchCursor(last.id) : null,
      };
    }),
  );

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Batches the `MessageSearchChat` context for every chat referenced by a page
// of message hits into two queries (the chats, and all their participants)
// rather than one round trip per hit — keeps a message page at a fixed query
// count regardless of how many results it holds.
const loadMessageSearchChats = (
  db: DrizzleDb,
  chatIds: ReadonlyArray<number>,
): Effect.Effect<MessageSearchChat[]> =>
  Effect.gen(function* () {
    if (chatIds.length === 0) return [];
    const [chatRows, participantRows] = yield* Effect.all(
      [
        query(() =>
          db
            .select({ id: chats.id, type: chats.type, title: chats.title })
            .from(chats)
            .where(inArray(chats.id, [...chatIds])),
        ),
        query(() =>
          db
            .select({
              chatId: chatParticipants.chatId,
              userId: chatParticipants.userId,
              username: users.username,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
              role: chatParticipants.role,
              statusText: users.statusText,
              statusEmoji: users.statusEmoji,
              statusExpiresAt: users.statusExpiresAt,
            })
            .from(chatParticipants)
            .innerJoin(users, eq(users.id, chatParticipants.userId))
            .where(inArray(chatParticipants.chatId, [...chatIds])),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const byChat = new Map<
      number,
      MessageSearchChat["participants"][number][]
    >();
    for (const {
      chatId,
      avatarSmallKey,
      avatarMediumKey,
      avatarLargeKey,
      statusText,
      statusEmoji,
      statusExpiresAt,
      ...rest
    } of participantRows) {
      const list = byChat.get(chatId) ?? [];
      list.push({
        ...rest,
        avatarVariants: toAvatarVariants({
          avatarSmallKey,
          avatarMediumKey,
          avatarLargeKey,
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

const searchMessagesPage = (
  db: DrizzleDb,
  viewerId: number,
  q: string,
  limit: number,
  after: number | null,
) =>
  Effect.gen(function* () {
    // The join on the caller's own participant row, inside each union arm, is
    // the access control: a message in a chat they're not part of can never
    // appear, no matter what it matches. It has to be *inside* the arm, not
    // applied to its result, or an arm could spend its whole page allowance on
    // messages the caller may not see.
    const rows = yield* query(() =>
      db
        .select({
          id: messages.id,
          chatId: messages.chatId,
          content: messages.content,
          createdAt: messages.createdAt,
          ...userColumns,
        })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderId))
        .where(
          matchingIds(
            messages.id,
            matchBranches(messagesVector, messages.content, q),
            (branch) => sql`select ${messages.id} from ${messages}
              inner join ${chatParticipants} on ${and(
                eq(chatParticipants.chatId, messages.chatId),
                eq(chatParticipants.userId, viewerId),
              )}
              where ${and(
                eq(messages.contentType, "text"),
                branch,
                after !== null ? lt(messages.id, after) : undefined,
              )} order by ${messages.id} desc limit ${limit + 1}`,
            limit + 1,
          ),
        )
        .orderBy(desc(messages.id))
        .limit(limit + 1),
    );

    const { page, hasMore } = splitPage(rows, limit);
    const last = page[page.length - 1];
    const searchChats = yield* loadMessageSearchChats(db, [
      ...new Set(page.map((r) => r.chatId)),
    ]);

    return {
      results: page.map((row) => ({
        id: row.id,
        chatId: row.chatId,
        sender: toSearchUser(row),
        createdAt: row.createdAt.getTime(),
        snippet: buildSnippet(row.content, q),
      })),
      chats: searchChats,
      limit,
      nextCursor: hasMore && last ? encodeSearchCursor(last.id) : null,
    };
  });

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const SearchHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "search",
  (handlers) =>
    handlers
      .handle("searchAll", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const limit = urlParams.limit ?? DEFAULT_SEARCH_ALL_LIMIT;
          const q = urlParams.q;
          const hidden = yield* hiddenAuthorIds(db, currentUser.id);

          // The four sections are independent, so they're issued together
          // rather than in sequence: against a real Postgres (a connection
          // pool) the unified search costs about what its slowest section
          // does, not the sum of all four.
          const [usersPage, postsPage, commentsPage, messagesPage] =
            yield* Effect.all(
              [
                searchUsersPage(db, currentUser.role, q, limit, undefined),
                searchPostsPage(db, q, limit, null, hidden),
                searchCommentsPage(db, q, limit, null, hidden),
                searchMessagesPage(db, currentUser.id, q, limit, null),
              ],
              { concurrency: "unbounded" },
            );

          return {
            users: usersPage,
            posts: postsPage,
            comments: commentsPage,
            messages: messagesPage,
          };
        }),
      )
      .handle("searchUsers", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          return yield* searchUsersPage(
            db,
            currentUser.role,
            urlParams.q,
            urlParams.limit ?? DEFAULT_SEARCH_LIMIT,
            urlParams.cursor,
          );
        }),
      )
      .handle("searchPosts", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const after = yield* resolveCursor(urlParams.cursor);
          const hidden = yield* hiddenAuthorIds(db, currentUser.id);
          return yield* searchPostsPage(
            db,
            urlParams.q,
            urlParams.limit ?? DEFAULT_SEARCH_LIMIT,
            after,
            hidden,
          );
        }),
      )
      .handle("searchComments", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const after = yield* resolveCursor(urlParams.cursor);
          const hidden = yield* hiddenAuthorIds(db, currentUser.id);
          return yield* searchCommentsPage(
            db,
            urlParams.q,
            urlParams.limit ?? DEFAULT_SEARCH_LIMIT,
            after,
            hidden,
          );
        }),
      )
      .handle("searchMessages", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const after = yield* resolveCursor(urlParams.cursor);
          return yield* searchMessagesPage(
            db,
            currentUser.id,
            urlParams.q,
            urlParams.limit ?? DEFAULT_SEARCH_LIMIT,
            after,
          );
        }),
      ),
);
