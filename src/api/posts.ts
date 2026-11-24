import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";
import { Attachment } from "./attachments.ts";
import { AvatarVariants, IdParam } from "./common.ts";
import {
  AttachmentInUse,
  Forbidden,
  InvalidCommentRequest,
  InvalidPostsRequest,
  NotFound,
  TooManyRequests,
} from "./errors.ts";

// Generous but bounded — prevents unbounded payloads while comfortably
// fitting a long-form text post.
const MAX_POST_BODY_LENGTH = 10_000;

// May be empty beside an attachment, see `requireBodyOrAttachment`.
const PostBody = Schema.Trimmed.check(Schema.isMaxLength(MAX_POST_BODY_LENGTH));

// Who wrote a post or comment, embedded in `Post.author`/`Comment.author`
// (issue #750) so a feed or a thread can label every row without a
// `GET /users/:id` per author. Just what a byline renders — name, handle and
// avatar, the same fields as on `User` — not the role, status or bio (the
// profile hover card still fetches the full profile on demand). Resolved in
// one batched lookup per response (see authors.ts), never per row.
export const AuthorSummary = Schema.Struct({
  id: Schema.Finite,
  username: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  avatarVariants: Schema.NullOr(AvatarVariants),
}).annotate({ identifier: "AuthorSummary" });

export type AuthorSummary = typeof AuthorSummary.Type;

// The standard emoji reaction set (issue #215, widening the original binary
// "like" from issue #67). A `Schema.Literal` rather than a plain string so
// the OpenAPI spec documents the exact allowed values and invalid input is
// rejected at decode time rather than reaching the DB — see the `emoji`
// column comment in db/schema.ts for why the DB itself stays unconstrained
// (so a future custom-emoji set doesn't need a migration to loosen it).
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"] as const;

export const ReactionEmoji = Schema.Literals(REACTION_EMOJIS).annotate({
  identifier: "ReactionEmoji",
});

export type ReactionEmoji = typeof ReactionEmoji.Type;

// One emoji's aggregate state on a target: how many reactions it has, and
// whether the requesting user is one of them. `Post`/`Comment` each carry an
// array of these — one entry per emoji that has at least one reaction, never
// a zero-filled entry for the rest of the standard set (the frontend's
// "add a reaction" picker already knows the full set independently).
export const ReactionSummary = Schema.Struct({
  emoji: Schema.String,
  count: Schema.Finite,
  reactedByMe: Schema.Boolean,
}).annotate({ identifier: "ReactionSummary" });

export type ReactionSummary = typeof ReactionSummary.Type;

// Cross-field check shared by post/message create+update bodies: there has
// to be something to show.
export const requireBodyOrAttachment = (payload: {
  readonly body: string;
  readonly attachmentId?: number | undefined;
}): string | undefined =>
  payload.body === "" && payload.attachmentId === undefined
    ? "body may only be empty when there is an attachment"
    : undefined;

export const Post = Schema.Struct({
  id: Schema.Finite,
  authorId: Schema.Finite,
  // Additive (issue #750): `authorId` stays, and always equals `author.id`.
  author: AuthorSummary,
  // Empty for an attachment posted without text.
  body: Schema.String,
  attachment: Schema.NullOr(Attachment),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  // Engagement computed on read (see EngagementHandler.ts / PostsHandler.ts)
  // rather than stored — one entry per emoji this post has at least one
  // reaction from, so the feed can render reaction pills (with the current
  // user's own reactions highlighted) without a second request per post.
  reactions: Schema.Array(ReactionSummary),
  // Total comments (top-level comments *and* replies) on this post, computed
  // on read alongside `reactions` (see PostsHandler.ts) rather than stored, so
  // the feed can surface a "Comments · N" count on each card without having to
  // open the thread (issue #306). Additive/backward-compatible: a client that
  // predates this field simply ignores it.
  commentCount: Schema.Finite,
}).annotate({ identifier: "Post" });

export type Post = typeof Post.Type;

export const CreatePostBody = Schema.Struct({
  body: PostBody,
  // Id of a previously-uploaded attachment (`POST /attachments`) owned by
  // the caller.
  attachmentId: Schema.optional(Schema.Finite),
  // Idempotency key (issue #657, mirroring `CreateMessageBody.clientId`): a
  // client-generated id, reused when a create is retried. If this author
  // already stored a post with the same key, that post is returned instead of
  // creating a duplicate.
  clientId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
})
  .check(Schema.makeFilter(requireBodyOrAttachment))
  .annotate({ identifier: "CreatePostBody" });

// Replaces both: leaving `attachmentId` out removes the attachment.
export const UpdatePostBody = Schema.Struct({
  body: PostBody,
  attachmentId: Schema.optional(Schema.Finite),
})
  .check(Schema.makeFilter(requireBodyOrAttachment))
  .annotate({ identifier: "UpdatePostBody" });

export const DEFAULT_POSTS_LIMIT = 20;

export const MAX_POSTS_LIMIT = 100;

// `limit` (rather than `page`/`pageSize`) so a caller can request
// irregularly-sized batches — e.g. an infinite-scroll feed that loads 5 posts
// up front and 3 at a time thereafter — without the batch size having to stay
// constant across requests.
//
// `posts` is ordered newest-first (`id desc`) and never mutates an existing
// row's position (posts aren't reordered by edits, unlike chats), so a plain
// single-column keyset cursor — "give me the next `limit` posts with
// `id < cursor`" — is enough; no OFFSET, so deep pages don't scan and discard
// skipped rows (issue #50). The cursor is opaque to clients: it's the last
// row's id, base64url-encoded (same encoding `Jwt.ts` uses for its segments),
// and only ever round-tripped from a previous page's `nextCursor` rather than
// constructed by hand.
//
// Left plain-optional (rather than `optionalWith` + `default`) because a
// schema default only fills in on *decode* — an HttpApiClient caller encoding
// a request would otherwise be forced to pass both every time. Defaults are
// instead applied by the handler.
//
// Deliberately left un-`identifier`-annotated: the OpenAPI generator only
// emits individual query-parameter entries when this struct is inlined —
// giving it a named `identifier` turns it into a `$ref` to a component
// schema instead, which it silently ignores when extracting parameters
// (see `processParameters` in `OpenApi.ts`), producing an operation with no
// documented/typed query params at all.
export const PostsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_POSTS_LIMIT }),
    ),
  ),
});

export const PostsPage = Schema.Struct({
  posts: Schema.Array(Post),
  limit: Schema.Finite,
  // Opaque cursor for the next page, or null once the current page reaches
  // the end of the list. Derived from fetching one row past `limit` rather
  // than a separate `COUNT(*)` over the full result set — the feed only ever
  // needs to know whether another page exists (issue #51).
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "PostsPage" });

// Response for `GET /users/:id/posts` (issue #316: the profile page shows a
// recent-activity feed instead of being a dead end). Same shape/pagination as
// `PostsPage`, plus `totalCount` — this endpoint is always scoped to one
// author, so a `COUNT(*) WHERE author_id = :id` (backed by
// `posts_author_id_idx`) is cheap in a way a full-feed count isn't (see
// `PostsPage`'s comment), and it powers the "N posts" stat on the profile
// header.
export const UserPostsPage = Schema.Struct({
  posts: Schema.Array(Post),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
  totalCount: Schema.Finite,
}).annotate({ identifier: "UserPostsPage" });

// Shorter than a post's cap — comments are conversational, not long-form.
export const MAX_COMMENT_CONTENT_LENGTH = 2_000;

const CommentContent = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_COMMENT_CONTENT_LENGTH),
);

// A comment on a post, or a reply to a comment (a reply is just a comment
// with `parentCommentId` set — null for a top-level comment). Nesting is
// capped at depth 2, so a reply's parent is always a top-level comment.
// `reactions` mirrors `Post`'s — computed on read, not stored.
//
// A top-level comment deleted while it still has replies stays as a
// placeholder so those replies aren't deleted with it (issue #904):
// `deleted` is true, and it carries no author, content or reactions.
export const Comment = Schema.Struct({
  id: Schema.Finite,
  postId: Schema.Finite,
  parentCommentId: Schema.NullOr(Schema.Finite),
  // Null only on a deleted placeholder.
  authorId: Schema.NullOr(Schema.Finite),
  // Same embedded byline as `Post.author` (issue #750); null only on a
  // deleted placeholder.
  author: Schema.NullOr(AuthorSummary),
  deleted: Schema.Boolean,
  content: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  reactions: Schema.Array(ReactionSummary),
  // How many replies a top-level comment has (always 0 for a reply, since
  // threads are one level deep) — computed on read like `Post.commentCount`.
  // Lets the client offer "View N replies" instead of hiding existing
  // replies until the viewer happens to open the reply composer (#479).
  replyCount: Schema.Finite,
}).annotate({ identifier: "Comment" });

export type Comment = typeof Comment.Type;

export const CreateCommentBody = Schema.Struct({
  content: CommentContent,
}).annotate({ identifier: "CreateCommentBody" });

export const UpdateCommentBody = Schema.Struct({
  content: CommentContent,
}).annotate({ identifier: "UpdateCommentBody" });

// Payload for the add/remove-reaction endpoints (on posts and comments
// alike): which of the standard emojis this reaction is/was.
export const ReactionBody = Schema.Struct({
  emoji: ReactionEmoji,
}).annotate({ identifier: "ReactionBody" });

// Returned by the add/remove-reaction endpoints: the target's full new set of
// per-emoji reaction summaries, so the client can reconcile an optimistic
// toggle without a follow-up read.
export const ReactionState = Schema.Struct({
  reactions: Schema.Array(ReactionSummary),
}).annotate({ identifier: "ReactionState" });

export type ReactionState = typeof ReactionState.Type;

export const DEFAULT_COMMENTS_LIMIT = 20;

export const MAX_COMMENTS_LIMIT = 100;

// Comments (and replies) are ordered oldest-first (`id asc`) within their
// thread and never reorder, so — like `PostsPageQuery` — a single forward
// keyset cursor ("give me the next `limit` with `id > cursor`") is enough.
// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md) — it's inlined into query parameters.
export const CommentsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_COMMENTS_LIMIT }),
    ),
  ),
});

export const CommentsPage = Schema.Struct({
  comments: Schema.Array(Comment),
  limit: Schema.Finite,
  // Opaque cursor for the next page, or null once the thread is exhausted —
  // same fetch-one-past-`limit` trick as `PostsPage.nextCursor`.
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CommentsPage" });

export const PostsGroup = HttpApiGroup.make("posts")
  .add(
    HttpApiEndpoint.get("getPost", "/posts/:id", {
      params: { id: Schema.Int },
      success: Post,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Authenticated, paginated view over all posts.
    HttpApiEndpoint.get("listPosts", "/posts", {
      query: PostsPageQuery,
      success: PostsPage,
      error: InvalidPostsRequest,
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createPost", "/posts", {
      payload: CreatePostBody,
      success: Post.pipe(HttpApiSchema.status(201)),
      // Raised when `attachmentId` doesn't reference an attachment owned by
      // the caller, or one that's already on another post or message (see
      // withClaimedAttachment in attachments.ts).
      error: [NotFound, AttachmentInUse],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.put("updatePost", "/posts/:id", {
      params: { id: Schema.Int },
      payload: UpdatePostBody,
      success: Post,
      error: [NotFound, Forbidden, AttachmentInUse],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.delete("deletePost", "/posts/:id", {
      params: { id: Schema.Int },
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  );

export const CommentsGroup = HttpApiGroup.make("comments")
  .add(
    // Idempotent add-reaction on a post — reacting with an emoji already
    // reacted with is a no-op, returning the current state. Emits a
    // feed-wide `reaction_changed` realtime event.
    HttpApiEndpoint.post("addPostReaction", "/posts/:id/reactions", {
      params: IdParam,
      payload: ReactionBody,
      success: ReactionState,
      error: [NotFound, Forbidden, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Removes one specific emoji reaction — a user may have reacted with more
    // than one emoji on the same target, so this only clears the one named in
    // the payload, not every reaction of theirs on it.
    HttpApiEndpoint.delete("removePostReaction", "/posts/:id/reactions", {
      params: IdParam,
      payload: ReactionBody,
      success: ReactionState,
      error: [NotFound, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Oldest-first page of a post's top-level comments (replies excluded —
    // fetch those per-comment via `listReplies`). Keyset-paginated like
    // `listPosts`.
    HttpApiEndpoint.get("listComments", "/posts/:id/comments", {
      params: IdParam,
      query: CommentsPageQuery,
      success: CommentsPage,
      error: [NotFound, InvalidCommentRequest],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createComment", "/posts/:id/comments", {
      params: IdParam,
      payload: CreateCommentBody,
      success: Comment.pipe(HttpApiSchema.status(201)),
      error: [NotFound, Forbidden, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Oldest-first page of a comment's replies.
    HttpApiEndpoint.get("listReplies", "/comments/:id/replies", {
      params: IdParam,
      query: CommentsPageQuery,
      success: CommentsPage,
      error: [NotFound, InvalidCommentRequest],
    }).middleware(Authentication),
  )
  .add(
    // One comment or reply, with its reactions and reply count — what the
    // notifications page's preview pane (issue #564) needs to show the
    // comment a notification points at inside its thread.
    HttpApiEndpoint.get("getComment", "/comments/:id", {
      params: IdParam,
      success: Comment,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Creates a reply to a top-level comment. Rejects (400) if the target is
    // itself a reply — the depth-2 nesting cap (see EngagementHandler.ts).
    HttpApiEndpoint.post("createReply", "/comments/:id/replies", {
      params: IdParam,
      payload: CreateCommentBody,
      success: Comment.pipe(HttpApiSchema.status(201)),
      error: [NotFound, Forbidden, InvalidCommentRequest, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Add-reaction on a comment or reply (both live in `comments`, so one
    // endpoint covers both). Emits a `reaction_changed` event scoped to the
    // post's comment-room subscribers rather than broadcast feed-wide.
    HttpApiEndpoint.post("addCommentReaction", "/comments/:id/reactions", {
      params: IdParam,
      payload: ReactionBody,
      success: ReactionState,
      error: [NotFound, Forbidden, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.delete("removeCommentReaction", "/comments/:id/reactions", {
      params: IdParam,
      payload: ReactionBody,
      success: ReactionState,
      error: [NotFound, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Edits a comment/reply's content — the author only (or an admin), same
    // `canModify` rule as posts.
    HttpApiEndpoint.patch("updateComment", "/comments/:id", {
      params: IdParam,
      payload: UpdateCommentBody,
      success: Comment,
      error: [NotFound, Forbidden, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Deletes a comment/reply — the author only (or an admin). A top-level
    // comment with replies becomes a `deleted` placeholder and its replies
    // stay (issue #904); it goes for good with its last reply.
    HttpApiEndpoint.delete("deleteComment", "/comments/:id", {
      params: IdParam,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, TooManyRequests],
    }).middleware(Authentication),
  );
