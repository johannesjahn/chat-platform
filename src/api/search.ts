import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";
import { ChatParticipant, ChatType } from "./chats.ts";
import { isMinLength } from "./common.ts";
import { InvalidSearchRequest } from "./errors.ts";
import { User } from "./users.ts";

// ---------------------------------------------------------------------------
// Search (issue #224, overhauled)
//
// One unified endpoint (`GET /search`) returns the top matches across all four
// searchable things at once — people, posts, comments/replies, and the
// caller's chat messages — so the results page renders from a single round
// trip instead of one request per section. Four keyset-paginated per-type
// endpoints back the "see all of this kind" tabs, each resuming exactly where
// the unified page left off.
//
// Matching is deliberately *not* whole-word-only: a row matches when either
// its indexed `tsvector` matches the query's tokens as words/prefixes (so
// "run" finds "running" and "jum" finds "jumps" mid-type) *or* every token
// appears as a raw substring anywhere in the text (so "ragmen" finds
// "fragmentary"). Both branches are index-served — a GIN index over the
// generated `tsvector` (migration 0017) and GIN trigram indexes (migration
// 0023) respectively — so neither degrades into a sequential scan as the
// tables grow. See src/search.ts for the query analysis and
// src/SearchHandler.ts for how the two branches are combined (a union of
// per-branch subqueries, not an `OR` — the difference is what keeps both
// indexes usable).
//
// Content results are ordered newest-match-first (`id desc`) with the same
// opaque single-column cursor as `listPosts`, rather than by relevance rank:
// recency keyset-paginates cleanly and predictably (no OFFSET, no re-ranking
// the whole match set per page), and the highlighted snippet already gives the
// user the relevance context inline. People results are the one exception —
// they're ranked by match quality (exact username, then prefix, then anywhere)
// and then alphabetically, which is what a "find a person" list has to do to
// be useful; their cursor carries that whole sort tuple.
//
// Every result row is a purpose-built projection — the matched text's id, its
// author/chat context, its timestamp and the snippet — not a full
// `Post`/`Comment`/`Message`. A results list renders none of the reactions,
// comment counts, read receipts or quoted parents those carry, and each of
// them costs an extra query per page, so the search response deliberately
// doesn't pay for them.
// ---------------------------------------------------------------------------

// Short enough to still be a useful search (a two-letter prefix is already
// selective once stemmed), but a floor so a single-character `q` can't ask
// Postgres to match half the table. Mirrors MIN_USER_SEARCH_QUERY_LENGTH's
// rationale (issue #48), a touch lower since search is index-served.
export const MIN_SEARCH_QUERY_LENGTH = 2;

// Bounds the request; no real search phrase approaches this, and a longer
// string can only be noise the tokenizer would discard anyway.
export const MAX_SEARCH_QUERY_LENGTH = 100;

export const DEFAULT_SEARCH_LIMIT = 20;

export const MAX_SEARCH_LIMIT = 50;

// The unified endpoint returns a *preview* of each section — enough rows to
// show what kind of matches exist, with the per-type endpoints taking over
// from there — so its per-section limit is much smaller than a full page's.
export const DEFAULT_SEARCH_ALL_LIMIT = 5;

export const MAX_SEARCH_ALL_LIMIT = 10;

// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// (api/posts.ts, see CLAUDE.md) — it's inlined into query parameters. `q` is
// trimmed and length-bounded here; its *contents* are never interpreted as SQL
// — the handler only ever passes it (or tokens derived from it) as bound
// parameters.
export const SearchQuery = Schema.Struct({
  q: Schema.Trim.check(
    isMinLength(MIN_SEARCH_QUERY_LENGTH),
    Schema.isMaxLength(MAX_SEARCH_QUERY_LENGTH),
  ),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT }),
    ),
  ),
});

// Same query text, but no cursor: the unified endpoint is always the *first*
// page of every section (pagination is the per-type endpoints' job), and its
// `limit` applies per section rather than to a single list.
export const SearchAllQuery = Schema.Struct({
  q: Schema.Trim.check(
    isMinLength(MIN_SEARCH_QUERY_LENGTH),
    Schema.isMaxLength(MAX_SEARCH_QUERY_LENGTH),
  ),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_ALL_LIMIT }),
    ),
  ),
});

// One run of a matched snippet. The backend splits the matched text into an
// ordered list of runs, each flagged `match` or not (see `buildSnippet` in
// src/search.ts), so the frontend can render the highlight as escaped React
// text (a `<mark>` around matched runs) — never as raw HTML — keeping user
// content that happens to contain markup inert (no stored XSS via the
// snippet).
export const SearchSnippetSegment = Schema.Struct({
  text: Schema.String,
  match: Schema.Boolean,
}).annotate({ identifier: "SearchSnippetSegment" });

export type SearchSnippetSegment = typeof SearchSnippetSegment.Type;

// People. The snippet highlights the matched fragment inside whichever name
// matched (display name if it did, else the username), so a hit in the middle
// of a name is visible rather than leaving the user guessing why the row is
// there.
export const UserSearchResult = Schema.Struct({
  user: User,
  snippet: Schema.Array(SearchSnippetSegment),
}).annotate({ identifier: "UserSearchResult" });

export const UserSearchPage = Schema.Struct({
  results: Schema.Array(UserSearchResult),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "UserSearchPage" });

// Posts. `author` is joined in rather than left for the client to resolve —
// a results list always renders the name and avatar, and resolving them
// client-side would mean a second request before the list can paint.
export const PostSearchResult = Schema.Struct({
  id: Schema.Finite,
  author: User,
  createdAt: Schema.Finite,
  snippet: Schema.Array(SearchSnippetSegment),
}).annotate({ identifier: "PostSearchResult" });

export const PostSearchPage = Schema.Struct({
  results: Schema.Array(PostSearchResult),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "PostSearchPage" });

// Comments and replies (a reply is a comment with a `parentCommentId` — both
// are searched, and the flag lets the UI label which is which). `postId` is
// carried so the frontend can deep-link to the thread the match lives in
// without a second lookup.
export const CommentSearchResult = Schema.Struct({
  id: Schema.Finite,
  postId: Schema.Finite,
  parentCommentId: Schema.NullOr(Schema.Finite),
  author: User,
  createdAt: Schema.Finite,
  snippet: Schema.Array(SearchSnippetSegment),
}).annotate({ identifier: "CommentSearchResult" });

export const CommentSearchPage = Schema.Struct({
  results: Schema.Array(CommentSearchResult),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CommentSearchPage" });

// Lightweight chat context for a message hit — just enough for the results
// list to render the same name/avatar the chat list does (group title, or the
// other participant of a direct chat) and link through, without paying for a
// full `Chat` (last message, unread count, version) per row. Deduplicated per
// page into `MessageSearchPage.chats`, keyed by `id`.
export const MessageSearchChat = Schema.Struct({
  id: Schema.Finite,
  type: ChatType,
  title: Schema.NullOr(Schema.String),
  participants: Schema.Array(ChatParticipant),
}).annotate({ identifier: "MessageSearchChat" });

export type MessageSearchChat = typeof MessageSearchChat.Type;

export const MessageSearchResult = Schema.Struct({
  id: Schema.Finite,
  // Carries `chatId`; resolve its `MessageSearchChat` from the page's `chats`.
  chatId: Schema.Finite,
  sender: User,
  createdAt: Schema.Finite,
  snippet: Schema.Array(SearchSnippetSegment),
}).annotate({ identifier: "MessageSearchResult" });

export const MessageSearchPage = Schema.Struct({
  results: Schema.Array(MessageSearchResult),
  // Every chat referenced by a result in `results`, deduplicated — only chats
  // the current user still participates in are ever searched (the handler
  // joins on their participant rows), so a hit can never leak a message from a
  // chat they're not in.
  chats: Schema.Array(MessageSearchChat),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "MessageSearchPage" });

// The unified response: the first page of every section, each in exactly the
// shape its own endpoint returns — including `nextCursor`, so switching to a
// section's tab continues from here instead of re-fetching what's already on
// screen.
export const SearchAllPage = Schema.Struct({
  users: UserSearchPage,
  posts: PostSearchPage,
  comments: CommentSearchPage,
  messages: MessageSearchPage,
}).annotate({ identifier: "SearchAllPage" });

export const SearchGroup = HttpApiGroup.make("search")
  .add(
    // Everything at once: the top matches for people, posts, comments and the
    // caller's messages in a single request. The four queries run
    // concurrently server-side, so the whole thing costs about what its
    // slowest section does.
    HttpApiEndpoint.get("searchAll", "/search", {
      query: SearchAllQuery,
      success: SearchAllPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // People, best match first (see the section comment above). Keeps
    // `GET /users/search`'s own floor (issue #48): a non-admin's query must
    // be at least `MIN_USER_SEARCH_QUERY_LENGTH` characters, or this section
    // comes back empty — empty rather than a 400, so a two-character search
    // still answers normally for every other section.
    HttpApiEndpoint.get("searchUsers", "/search/users", {
      query: SearchQuery,
      success: UserSearchPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // Text posts, newest match first.
    HttpApiEndpoint.get("searchPosts", "/search/posts", {
      query: SearchQuery,
      success: PostSearchPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // Comments and replies, newest match first.
    HttpApiEndpoint.get("searchComments", "/search/comments", {
      query: SearchQuery,
      success: CommentSearchPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // Messages in chats the current user participates in (access-scoped by a
    // join on their participant rows), newest match first. A chat that's
    // still a message request for them (issue #808) isn't searched until
    // they accept it.
    HttpApiEndpoint.get("searchMessages", "/search/messages", {
      query: SearchQuery,
      success: MessageSearchPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  );
