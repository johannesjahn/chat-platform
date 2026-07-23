import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Multipart,
  OpenApi,
} from "@effect/platform";
import { Option, Schema } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { Authentication } from "./Auth.ts";

// "admin" can edit/delete any post; "user" can only edit/delete their own.
// Registration always creates a "user" — admins are promoted out-of-band.
export const UserRole = Schema.Literal("user", "admin").annotations({
  identifier: "UserRole",
});
export type UserRole = typeof UserRole.Type;

// Hosting domains an image URL (avatar or post/message `image_url` content)
// is allowed to point at (issue #47): rendered directly as an `<img src>`,
// so without this an author could embed a `javascript:`/`data:` URL, track
// viewers via an arbitrary third-party host, or serve mixed (non-https)
// content. Matches the domain itself or any subdomain, e.g. "i.imgur.com"
// matches "imgur.com".
export const ALLOWED_IMAGE_HOST_DOMAINS = [
  "picsum.photos",
  "imgur.com",
  "unsplash.com",
  "gravatar.com",
  "githubusercontent.com",
  "imgbb.com",
  "ibb.co",
  "cloudinary.com",
  "googleusercontent.com",
  "discordapp.com",
  "discordapp.net",
  "staticflickr.com",
  "wikimedia.org",
  "pexels.com",
  "pixabay.com",
] as const;

const isAllowedImageHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return ALLOWED_IMAGE_HOST_DOMAINS.some(
    (domain) => lower === domain || lower.endsWith(`.${domain}`),
  );
};

// A well-formed `https://` URL (rejects `data:`, `javascript:`, plain
// `http:`, and unparseable strings) whose host is on the allowlist above.
export const isAllowedImageUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && isAllowedImageHost(url.hostname);
};

const AVATAR_URL_FILTER_MESSAGE =
  "avatarUrl must be an https:// URL from an allowed image-hosting domain";

// Bounded mainly to keep the request small — no real URL is anywhere close.
const MAX_AVATAR_URL_LENGTH = 2048;

const AvatarUrl = Schema.String.pipe(
  Schema.maxLength(MAX_AVATAR_URL_LENGTH),
  Schema.filter((value) =>
    isAllowedImageUrl(value) ? undefined : AVATAR_URL_FILTER_MESSAGE,
  ),
);

// Self-contained `data:image/webp;base64,...` URLs for the 3 fixed sizes an
// uploaded-and-cropped avatar is stored/served at (issue #269) — see
// `processAvatar`/`AVATAR_VARIANT_PX` in ImageProcessing.ts for how they're
// produced, and the comment on `users.avatarSmall` (db/schema.ts) for why
// they're embedded directly rather than resolved via a presigned URL like
// `Attachment.url`. Mutually exclusive with `avatarUrl` on `User` below —
// exactly one of the two is ever non-null.
const AvatarVariants = Schema.Struct({
  small: Schema.String,
  medium: Schema.String,
  large: Schema.String,
}).annotations({ identifier: "AvatarVariants" });

// Public representation of a user — never exposes the password hash.
// `identifier` annotations surface these as named schemas in the OpenAPI spec.
export const User = Schema.Struct({
  id: Schema.Number,
  username: Schema.String,
  // Optional profile fields (issue #67) — null when unset. The UI falls back
  // to `username` for display and initials-only for the avatar (see
  // web/src/components/Avatar.tsx).
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  // Set instead of `avatarUrl` when the user has uploaded/cropped an avatar
  // via `POST /users/me/avatar` (issue #269) rather than linked an external
  // image. The frontend picks whichever size variant matches where it's
  // rendering the avatar (see `AVATAR_SIZES` in Avatar.tsx) and otherwise
  // falls back to `avatarUrl`, then initials.
  avatarVariants: Schema.NullOr(AvatarVariants),
  role: UserRole,
}).annotations({ identifier: "User" });
export type User = typeof User.Type;

// Sensible cap on username length (issue #46) — mirrors common site limits
// (Discord uses 32, GitHub 39) and keeps the value small enough to embed in
// JWT claims and UI without an unbounded storage/DoS risk.
export const MAX_USERNAME_LENGTH = 32;

const Username = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_USERNAME_LENGTH),
);

// Mirrors MAX_USERNAME_LENGTH's rationale but roomier, since a display name
// may hold a full "First Last" rather than a single token.
export const MAX_DISPLAY_NAME_LENGTH = 64;

const DisplayName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_DISPLAY_NAME_LENGTH),
);

// A generous ceiling — long enough for any real passphrase, but bounded so a
// multi-megabyte payload can't be pushed through the (deliberately
// expensive) Argon2id hash/verify path.
export const MAX_PASSWORD_LENGTH = 128;

// Floor for newly chosen passwords (issue #45) — rules out trivial
// one-character passwords without imposing composition rules (NIST no
// longer recommends those; length is the stronger lever).
export const MIN_PASSWORD_LENGTH = 8;

const Password = Schema.NonEmptyString.pipe(
  Schema.maxLength(MAX_PASSWORD_LENGTH),
);

// Only applied where a password is being newly *set* (registration, password
// change) — `Password` alone remains the decode schema for login and
// `currentPassword`, so accounts created before this floor existed can still
// authenticate with their existing (possibly shorter) password.
const NewPassword = Password.pipe(Schema.minLength(MIN_PASSWORD_LENGTH));

export const RegisterBody = Schema.Struct({
  username: Username,
  password: NewPassword,
}).annotations({ identifier: "RegisterBody" });

export const LoginBody = Schema.Struct({
  username: Username,
  password: Password,
}).annotations({ identifier: "LoginBody" });

export const LoginResponse = Schema.Struct({
  user: User,
  accessToken: Schema.String,
  refreshToken: Schema.String,
}).annotations({ identifier: "LoginResponse" });
export type LoginResponse = typeof LoginResponse.Type;

// A well-formed token signed by this server is well under this (see
// Jwt.ts) — anything longer is necessarily garbage, not worth spending a
// verify() on.
const MAX_REFRESH_TOKEN_LENGTH = 1024;

const RefreshTokenValue = Schema.String.pipe(
  Schema.maxLength(MAX_REFRESH_TOKEN_LENGTH),
);

export const RefreshBody = Schema.Struct({
  refreshToken: RefreshTokenValue,
}).annotations({ identifier: "RefreshBody" });

// A refresh exchanges a valid refresh token for a new token pair — the
// refresh token is rotated too rather than reused, so a client always holds
// exactly one live refresh token at a time.
export const RefreshResponse = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
}).annotations({ identifier: "RefreshResponse" });

export const LogoutBody = Schema.Struct({
  refreshToken: RefreshTokenValue,
  // When true, revokes every refresh token belonging to the presented
  // token's user (all sessions/devices) instead of just this one.
  allSessions: Schema.optional(Schema.Boolean),
}).annotations({ identifier: "LogoutBody" });

export const ChangePasswordBody = Schema.Struct({
  currentPassword: Password,
  newPassword: NewPassword,
}).annotations({ identifier: "ChangePasswordBody" });

// Full-replace body (mirrors `UpdatePostBody`/`UpdateChatBody`'s convention)
// rather than a partial patch — `displayName`/`avatarUrl` are nullable so a
// caller can explicitly clear either back to "unset". Username is not
// editable here — it's assigned at registration and immutable thereafter.
export const UpdateProfileBody = Schema.Struct({
  displayName: Schema.NullOr(DisplayName),
  avatarUrl: Schema.NullOr(AvatarUrl),
}).annotations({ identifier: "UpdateProfileBody" });

// Deleting an account is irreversible, so — like `changePassword` — it
// requires re-proving the current password rather than trusting the bearer
// token alone.
export const DeleteAccountBody = Schema.Struct({
  password: Password,
}).annotations({ identifier: "DeleteAccountBody" });

export const UpdateUserRoleBody = Schema.Struct({
  role: UserRole,
}).annotations({ identifier: "UpdateUserRoleBody" });

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class UsernameTaken extends Schema.TaggedError<UsernameTaken>()(
  "UsernameTaken",
  { message: Schema.String },
) {}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  { message: Schema.String },
) {}

// Raised when a caller has exceeded an endpoint's rate limit (see
// RateLimiter.ts). `message` is deliberately generic across every bucket an
// endpoint checks (e.g. login's per-IP vs. per-account buckets) so it can't
// be used to tell them apart.
export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()(
  "TooManyRequests",
  { message: Schema.String, retryAfterSeconds: Schema.Number },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

// Raised for chat domain-rule violations that aren't a 404/403 — messaging
// yourself, exceeding the group participant cap, editing a direct chat's
// title, duplicate participants, etc.
export class InvalidChatRequest extends Schema.TaggedError<InvalidChatRequest>()(
  "InvalidChatRequest",
  { message: Schema.String },
) {}

// Raised for a malformed `listPosts` pagination cursor — mirrors
// `InvalidChatRequest`'s role for `listChats`/`listMessages`.
export class InvalidPostsRequest extends Schema.TaggedError<InvalidPostsRequest>()(
  "InvalidPostsRequest",
  { message: Schema.String },
) {}

// Raised for comment/reply domain-rule violations that aren't a 404/403 — a
// malformed pagination cursor, or an attempt to reply to a reply (the depth-2
// nesting cap, enforced at create time — see EngagementHandler.ts).
export class InvalidCommentRequest extends Schema.TaggedError<InvalidCommentRequest>()(
  "InvalidCommentRequest",
  { message: Schema.String },
) {}

// Uploaded file metadata (issue #221) — attached to a post/message via
// `attachmentId` in Create/UpdatePostBody/CreateMessageBody/UpdateMessageBody
// below. `url` is a fresh, short-lived presigned (or `data:`, in the
// no-S3-configured dev fallback — see AttachmentStorage.ts) link resolved on
// every read, never stored, so it can't go stale or outlive its own access
// check.
export const Attachment = Schema.Struct({
  id: Schema.Number,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  url: Schema.String,
  // Set only for image attachments — the dimensions of the scaled-down
  // variant actually stored/served (not the original upload) and a BlurHash
  // string (https://blurha.sh/) the frontend decodes into a low-res
  // placeholder shown while the full image loads (issue #248). Null for
  // non-image attachments and for rows uploaded before this was added.
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
  blurhash: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Attachment" });
export type Attachment = typeof Attachment.Type;

// Mime types `POST /attachments` accepts — deliberately curated rather than
// "anything" (issue #221 only asks for previews of these families), and
// mainly to avoid ever storing/serving something like `text/html` or
// `image/svg+xml` from the bucket's origin, which could be used for stored
// XSS against whoever opens the presigned/data URL.
//
// PDF uploads are disabled: `application/pdf` intentionally isn't listed
// here. Attachment rows created before this change may still have
// `mimeType: "application/pdf"` and keep rendering fine (see
// attachmentKind/AttachmentPreview) — only new uploads are blocked.
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
] as const;

// A generous ceiling for chat/post media while still bounding worst-case
// storage and upload time per request.
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export class UnsupportedAttachmentType extends Schema.TaggedError<UnsupportedAttachmentType>()(
  "UnsupportedAttachmentType",
  { message: Schema.String },
) {}

export class AttachmentTooLarge extends Schema.TaggedError<AttachmentTooLarge>()(
  "AttachmentTooLarge",
  { message: Schema.String },
) {}

// Raised when an upload would push a user's total stored-attachment bytes
// past ATTACHMENT_QUOTA_MAX_BYTES (see AttachmentsHandler.ts) — bounds total
// storage per user, distinct from AttachmentTooLarge (one file's size) and
// the upload rate limiter (uploads per minute), neither of which caps how
// much a user can accumulate over time (issue #256).
export class AttachmentQuotaExceeded extends Schema.TaggedError<AttachmentQuotaExceeded>()(
  "AttachmentQuotaExceeded",
  { message: Schema.String },
) {}

// Raised by `POST /users/me/avatar` (issue #269) for anything wrong with the
// upload other than its size: an unsupported content type, bytes that don't
// decode as an image, a source image smaller than MIN_AVATAR_SOURCE_PX in
// either dimension, or a crop rectangle that doesn't fit within the actual
// decoded image bounds. `message` carries the specific reason (see
// UsersHandler.ts) — unlike the generic messages elsewhere in this file,
// there's no enumeration/timing concern here worth flattening it for.
export class InvalidAvatarUpload extends Schema.TaggedError<InvalidAvatarUpload>()(
  "InvalidAvatarUpload",
  { message: Schema.String },
) {}

export class AvatarTooLarge extends Schema.TaggedError<AvatarTooLarge>()(
  "AvatarTooLarge",
  { message: Schema.String },
) {}

// Content types a post's body can hold. Extend this union (and the handler's
// per-type validation, if any is ever needed) to support new post kinds.
export const PostContentType = Schema.Literal(
  "text",
  "image_url",
  "attachment",
).annotations({
  identifier: "PostContentType",
});
export type PostContentType = typeof PostContentType.Type;

// Generous but bounded — prevents unbounded payloads while comfortably
// fitting a long-form text post or an image URL.
const MAX_POST_CONTENT_LENGTH = 10_000;

const PostContent = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_POST_CONTENT_LENGTH),
);

// `content` is rendered directly as an `<img src>` (MessageBubble.tsx,
// PostCard.tsx) when `contentType` is "image_url" — validated against the
// same host allowlist as `avatarUrl` (see `ALLOWED_IMAGE_HOST_DOMAINS`
// above), for the same reasons (issue #47).
const IMAGE_URL_FILTER_MESSAGE =
  "content must be an https:// URL from an allowed image-hosting domain";

// Cross-field check shared by post/message create+update bodies: only
// applies when `contentType` is "image_url" — text content is unaffected.
const requireAllowedImageUrl = (body: {
  readonly contentType: string;
  readonly content: string;
}): string | undefined =>
  body.contentType === "image_url" && !isAllowedImageUrl(body.content)
    ? IMAGE_URL_FILTER_MESSAGE
    : undefined;

// The standard emoji reaction set (issue #215, widening the original binary
// "like" from issue #67). A `Schema.Literal` rather than a plain string so
// the OpenAPI spec documents the exact allowed values and invalid input is
// rejected at decode time rather than reaching the DB — see the `emoji`
// column comment in db/schema.ts for why the DB itself stays unconstrained
// (so a future custom-emoji set doesn't need a migration to loosen it).
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"] as const;
export const ReactionEmoji = Schema.Literal(...REACTION_EMOJIS).annotations({
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
  count: Schema.Number,
  reactedByMe: Schema.Boolean,
}).annotations({ identifier: "ReactionSummary" });
export type ReactionSummary = typeof ReactionSummary.Type;

// Cross-field check shared by post/message create+update bodies:
// `attachmentId` must be set exactly when `contentType` is "attachment" —
// never alongside "text"/"image_url", and never missing for "attachment".
const requireAttachmentId = (body: {
  readonly contentType: string;
  readonly attachmentId?: number | undefined;
}): string | undefined => {
  if (body.contentType === "attachment" && body.attachmentId === undefined)
    return `attachmentId is required when contentType is "attachment"`;
  if (body.contentType !== "attachment" && body.attachmentId !== undefined)
    return `attachmentId may only be set when contentType is "attachment"`;
  return undefined;
};

export const Post = Schema.Struct({
  id: Schema.Number,
  authorId: Schema.Number,
  contentType: PostContentType,
  content: Schema.String,
  // Set only when contentType is "attachment" — see `Attachment` above.
  attachment: Schema.NullOr(Attachment),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  // Engagement computed on read (see EngagementHandler.ts / PostsHandler.ts)
  // rather than stored — one entry per emoji this post has at least one
  // reaction from, so the feed can render reaction pills (with the current
  // user's own reactions highlighted) without a second request per post.
  reactions: Schema.Array(ReactionSummary),
}).annotations({ identifier: "Post" });
export type Post = typeof Post.Type;

export const CreatePostBody = Schema.Struct({
  contentType: PostContentType,
  content: PostContent,
  // Id of a previously-uploaded attachment (`POST /attachments`) owned by
  // the caller — required exactly when contentType is "attachment".
  attachmentId: Schema.optional(Schema.Number),
})
  .pipe(
    Schema.filter(requireAllowedImageUrl),
    Schema.filter(requireAttachmentId),
  )
  .annotations({ identifier: "CreatePostBody" });

export const UpdatePostBody = Schema.Struct({
  contentType: PostContentType,
  content: PostContent,
  attachmentId: Schema.optional(Schema.Number),
})
  .pipe(
    Schema.filter(requireAllowedImageUrl),
    Schema.filter(requireAttachmentId),
  )
  .annotations({ identifier: "UpdatePostBody" });

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
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, MAX_POSTS_LIMIT),
    ),
  ),
});

export const PostsPage = Schema.Struct({
  posts: Schema.Array(Post),
  limit: Schema.Number,
  // Opaque cursor for the next page, or null once the current page reaches
  // the end of the list. Derived from fetching one row past `limit` rather
  // than a separate `COUNT(*)` over the full result set — the feed only ever
  // needs to know whether another page exists (issue #51).
  nextCursor: Schema.NullOr(Schema.String),
}).annotations({ identifier: "PostsPage" });

// Shorter than a post's cap — comments are conversational, not long-form.
export const MAX_COMMENT_CONTENT_LENGTH = 2_000;

const CommentContent = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_COMMENT_CONTENT_LENGTH),
);

// A comment on a post, or a reply to a comment (a reply is just a comment
// with `parentCommentId` set — null for a top-level comment). Nesting is
// capped at depth 2, so a reply's parent is always a top-level comment.
// `reactions` mirrors `Post`'s — computed on read, not stored.
export const Comment = Schema.Struct({
  id: Schema.Number,
  postId: Schema.Number,
  parentCommentId: Schema.NullOr(Schema.Number),
  authorId: Schema.Number,
  content: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  reactions: Schema.Array(ReactionSummary),
}).annotations({ identifier: "Comment" });
export type Comment = typeof Comment.Type;

export const CreateCommentBody = Schema.Struct({
  content: CommentContent,
}).annotations({ identifier: "CreateCommentBody" });

export const UpdateCommentBody = Schema.Struct({
  content: CommentContent,
}).annotations({ identifier: "UpdateCommentBody" });

// Payload for the add/remove-reaction endpoints (on posts and comments
// alike): which of the standard emojis this reaction is/was.
export const ReactionBody = Schema.Struct({
  emoji: ReactionEmoji,
}).annotations({ identifier: "ReactionBody" });

// Returned by the add/remove-reaction endpoints: the target's full new set of
// per-emoji reaction summaries, so the client can reconcile an optimistic
// toggle without a follow-up read.
export const ReactionState = Schema.Struct({
  reactions: Schema.Array(ReactionSummary),
}).annotations({ identifier: "ReactionState" });
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
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, MAX_COMMENTS_LIMIT),
    ),
  ),
});

export const CommentsPage = Schema.Struct({
  comments: Schema.Array(Comment),
  limit: Schema.Number,
  // Opaque cursor for the next page, or null once the thread is exhausted —
  // same fetch-one-past-`limit` trick as `PostsPage.nextCursor`.
  nextCursor: Schema.NullOr(Schema.String),
}).annotations({ identifier: "CommentsPage" });

// A chat is either a "direct" (exactly two participants, no title — the UI
// derives a name from the other participant) or a "group" chat (2-20
// participants, a title set at creation and changeable by its creator).
export const ChatType = Schema.Literal("direct", "group").annotations({
  identifier: "ChatType",
});
export type ChatType = typeof ChatType.Type;

// Total participants a chat (of either kind) may ever have, creator included.
export const MAX_GROUP_PARTICIPANTS = 20;
const MAX_GROUP_TITLE_LENGTH = 100;

const GroupTitle = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_GROUP_TITLE_LENGTH),
);

// Per-chat role (issue #220) — distinct from `User.role` (site-wide admin).
// Only meaningful for group chats: a direct chat's two participants are
// both always "member". "owner" tracks `Chat.createdBy` 1:1 (see
// db/schema.ts); "admin" is granted by the owner via `updateParticipantRole`
// and, alongside "owner", can rename the group, add/remove participants, and
// delete any message in it.
export const ChatRole = Schema.Literal("owner", "admin", "member").annotations({
  identifier: "ChatRole",
});
export type ChatRole = typeof ChatRole.Type;

export const ChatParticipant = Schema.Struct({
  userId: Schema.Number,
  username: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  role: ChatRole,
}).annotations({ identifier: "ChatParticipant" });
export type ChatParticipant = typeof ChatParticipant.Type;

// Content types a message's body can hold — mirrors `PostContentType` but
// kept as its own union so messages and posts can diverge later.
export const MessageContentType = Schema.Literal(
  "text",
  "image_url",
  "attachment",
).annotations({ identifier: "MessageContentType" });
export type MessageContentType = typeof MessageContentType.Type;

// Shorter than a post's cap — chat messages are conversational, not
// long-form content, so a generous-but-bounded limit keeps bubbles sane.
export const MAX_MESSAGE_CONTENT_LENGTH = 4_000;

const MessageContent = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_MESSAGE_CONTENT_LENGTH),
);

export const Message = Schema.Struct({
  id: Schema.Number,
  chatId: Schema.Number,
  senderId: Schema.Number,
  contentType: MessageContentType,
  content: Schema.String,
  // Set only when contentType is "attachment" — see `Attachment` above.
  attachment: Schema.NullOr(Attachment),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  // Ids of participants (other than the sender) who have read this message —
  // read state is tracked per message/user, not as a single chat-wide flag,
  // so the UI can show WhatsApp/Telegram-style read receipts.
  readByUserIds: Schema.Array(Schema.Number),
}).annotations({ identifier: "Message" });
export type Message = typeof Message.Type;

export const Chat = Schema.Struct({
  id: Schema.Number,
  type: ChatType,
  title: Schema.NullOr(Schema.String),
  // Null once the creator's account has been deleted (see db/schema.ts) —
  // the chat and its history survive, but creator-only actions (rename, add
  // participants) become unavailable to everyone.
  createdBy: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  // Monotonically increases on every participant-visible change to this chat
  // (see db/schema.ts). Also carried on the `chat_updated` realtime event, so
  // a client can compare the two to tell whether it's missed an update
  // (issue #55) rather than only refetching whenever the next event happens
  // to arrive.
  version: Schema.Number,
  participants: Schema.Array(ChatParticipant),
  lastMessage: Schema.NullOr(Message),
  // Messages in this chat sent by someone else that the current user hasn't
  // read yet — computed relative to whoever is making the request.
  unreadCount: Schema.Number,
}).annotations({ identifier: "Chat" });
export type Chat = typeof Chat.Type;

export const CreateDirectChatBody = Schema.Struct({
  userId: Schema.Number,
}).annotations({ identifier: "CreateDirectChatBody" });

export const CreateGroupChatBody = Schema.Struct({
  title: GroupTitle,
  // The creator is added automatically — this is everyone *else*, hence one
  // short of the overall cap.
  participantIds: Schema.Array(Schema.Number).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_GROUP_PARTICIPANTS - 1),
  ),
}).annotations({ identifier: "CreateGroupChatBody" });

export const UpdateChatBody = Schema.Struct({
  title: GroupTitle,
}).annotations({ identifier: "UpdateChatBody" });

export const AddParticipantsBody = Schema.Struct({
  // A group can never hold more than MAX_GROUP_PARTICIPANTS total, so a
  // single request can never legitimately add more than that minus the
  // existing creator — mirrors CreateGroupChatBody's cap.
  participantIds: Schema.Array(Schema.Number).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_GROUP_PARTICIPANTS - 1),
  ),
}).annotations({ identifier: "AddParticipantsBody" });

export const TransferOwnershipBody = Schema.Struct({
  userId: Schema.Number,
}).annotations({ identifier: "TransferOwnershipBody" });

// "owner" is deliberately excluded — appointing an owner goes through
// `POST /chats/:id/owner` (`TransferOwnershipBody`) instead, since that also
// has to move `Chat.createdBy` and demote the previous owner.
export const UpdateParticipantRoleBody = Schema.Struct({
  role: Schema.Literal("admin", "member"),
}).annotations({ identifier: "UpdateParticipantRoleBody" });

// Total invites that may exist (active + expired + revoked) for a single
// chat — bounds the table's per-chat growth from repeated
// create/revoke cycles.
export const MAX_INVITES_PER_CHAT = 50;

export const CreateChatInviteBody = Schema.Struct({
  // Omitted means "never expires".
  expiresInHours: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.between(1, 24 * 30)),
  ),
  // Omitted means "unlimited uses" (still bounded by the chat's own
  // MAX_GROUP_PARTICIPANTS cap at redemption time).
  maxUses: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.between(1, MAX_GROUP_PARTICIPANTS)),
  ),
}).annotations({ identifier: "CreateChatInviteBody" });

export const ChatInvite = Schema.Struct({
  id: Schema.Number,
  chatId: Schema.Number,
  code: Schema.String,
  createdBy: Schema.Number,
  createdAt: Schema.Number,
  expiresAt: Schema.NullOr(Schema.Number),
  maxUses: Schema.NullOr(Schema.Number),
  useCount: Schema.Number,
  revokedAt: Schema.NullOr(Schema.Number),
}).annotations({ identifier: "ChatInvite" });
export type ChatInvite = typeof ChatInvite.Type;

export const CreateMessageBody = Schema.Struct({
  contentType: MessageContentType,
  content: MessageContent,
  // Id of a previously-uploaded attachment (`POST /attachments`) owned by
  // the caller — required exactly when contentType is "attachment".
  attachmentId: Schema.optional(Schema.Number),
})
  .pipe(
    Schema.filter(requireAllowedImageUrl),
    Schema.filter(requireAttachmentId),
  )
  .annotations({ identifier: "CreateMessageBody" });

export const UpdateMessageBody = Schema.Struct({
  contentType: MessageContentType,
  content: MessageContent,
  attachmentId: Schema.optional(Schema.Number),
})
  .pipe(
    Schema.filter(requireAllowedImageUrl),
    Schema.filter(requireAttachmentId),
  )
  .annotations({ identifier: "UpdateMessageBody" });

export const MarkReadBody = Schema.Struct({
  messageId: Schema.Number,
}).annotations({ identifier: "MarkReadBody" });

export const DEFAULT_MESSAGES_LIMIT = 30;
export const MAX_MESSAGES_LIMIT = 100;

// `messages` is ordered oldest-first (`id asc`) within a chat. Unlike
// `PostsPageQuery`'s single forward cursor, the chat view needs to page in
// both directions — backward for "load earlier" (infinite-scroll-to-top) and
// forward to catch up on newly-arrived messages without re-fetching the whole
// window — plus land directly on the newest messages on first open without a
// separate `COUNT(*)` to compute an OFFSET into. So this takes an optional
// `before` *or* `after` cursor instead of `offset`: neither set returns the
// newest page, `before` returns the `limit` messages immediately preceding
// that cursor, and `after` returns the `limit` messages immediately
// following it (issue #50). At most one of `before`/`after` may be set.
// Cursors are opaque to clients — see `PostsPageQuery` above.
export const MessagesPageQuery = Schema.Struct({
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, MAX_MESSAGES_LIMIT),
    ),
  ),
});

export const MessagesPage = Schema.Struct({
  messages: Schema.Array(Message),
  limit: Schema.Number,
  // Whether messages exist before/after the first/last row in this page —
  // derived from fetching one row past `limit` rather than a `COUNT(*)`, same
  // trick as `PostsPage.nextCursor` (issue #51).
  hasEarlier: Schema.Boolean,
  hasNewer: Schema.Boolean,
  // Opaque cursors for the adjacent pages, or null once there's nothing more
  // in that direction to fetch.
  earliestCursor: Schema.NullOr(Schema.String),
  latestCursor: Schema.NullOr(Schema.String),
}).annotations({ identifier: "MessagesPage" });

// Below this, a search isn't narrow enough to be worth running — keeps the
// query cost and result size from growing with the user base (issue #48).
export const MIN_USER_SEARCH_QUERY_LENGTH = 3;

// A query longer than the longest possible username can never usefully
// narrow an ILIKE match — bounded mainly to keep the request small.
export const MAX_USER_SEARCH_QUERY_LENGTH = 64;

// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md) — it's inlined into query parameters.
export const UserSearchQuery = Schema.Struct({
  q: Schema.Trim.pipe(
    Schema.minLength(MIN_USER_SEARCH_QUERY_LENGTH),
    Schema.maxLength(MAX_USER_SEARCH_QUERY_LENGTH),
  ),
});

// Mime types `POST /users/me/avatar` accepts (issue #269) — narrower than
// `ALLOWED_ATTACHMENT_MIME_TYPES`: no GIF (animated avatars are explicitly
// out of scope for the initial cut) and no video/audio.
export const ALLOWED_AVATAR_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

// Avatars don't need anywhere near MAX_ATTACHMENT_SIZE_BYTES's budget — a
// single photo, not arbitrary chat media.
export const MAX_AVATAR_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

// Multipart payload: the image file plus the square crop rectangle chosen by
// the frontend's crop UI, in the pixel coordinates of the (EXIF-rotated)
// uploaded image — see `processAvatar` in ImageProcessing.ts, which
// re-validates it against the actual decoded image rather than trusting
// these values. Left un-`identifier`-annotated like `UploadAttachmentBody`
// below. `maxFileSize` here is the same coarse in-stream backstop
// `UploadAttachmentBody` uses — set looser than MAX_AVATAR_UPLOAD_SIZE_BYTES
// so an ordinary too-large upload trips the handler's precise, typed
// AvatarTooLarge (413) check instead of a generic 400 from the multipart
// parser itself.
const UploadAvatarBody = HttpApiSchema.Multipart(
  Schema.Struct({
    file: Multipart.SingleFileSchema,
    x: Schema.NumberFromString.pipe(Schema.int(), Schema.nonNegative()),
    y: Schema.NumberFromString.pipe(Schema.int(), Schema.nonNegative()),
    size: Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
  }),
  { maxFileSize: Option.some(MAX_AVATAR_UPLOAD_SIZE_BYTES * 2) },
);

const UsersGroup = HttpApiGroup.make("users")
  .add(
    // Replaces the old unpaginated "list every user" endpoint (issue #48):
    // the full directory isn't exposed to every authenticated user anymore,
    // only search results for a query of at least
    // `MIN_USER_SEARCH_QUERY_LENGTH` characters.
    HttpApiEndpoint.get("searchUsers", "/users/search")
      .setUrlParams(UserSearchQuery)
      .addSuccess(Schema.Array(User))
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getUser", "/users/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(User)
      .addError(NotFound, { status: 404 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("register", "/users/register")
      .setPayload(RegisterBody)
      .addSuccess(User, { status: 201 })
      .addError(UsernameTaken, { status: 409 })
      .addError(TooManyRequests, { status: 429 }),
  )
  .add(
    HttpApiEndpoint.post("login", "/users/login")
      .setPayload(LoginBody)
      .addSuccess(LoginResponse)
      .addError(InvalidCredentials, { status: 401 })
      .addError(TooManyRequests, { status: 429 }),
  )
  .add(
    HttpApiEndpoint.post("refresh", "/users/refresh")
      .setPayload(RefreshBody)
      .addSuccess(RefreshResponse)
      .addError(InvalidCredentials, { status: 401 })
      .addError(TooManyRequests, { status: 429 }),
  )
  .add(
    // Revokes the presented refresh token (or, with `allSessions`, every
    // refresh token for its user) by deleting its store row. Idempotent and
    // unauthenticated like `refresh` — an already-invalid/expired token has
    // nothing to revoke, so it still succeeds rather than erroring.
    HttpApiEndpoint.post("logout", "/users/logout")
      .setPayload(LogoutBody)
      .addSuccess(Schema.Void),
  )
  .add(
    // Changes the current user's own password after verifying the current
    // one. Bumps token_version so every other outstanding token (access +
    // refresh, all sessions/devices) is revoked immediately — mirroring
    // `logout`'s `allSessions` option — while reissuing a fresh access +
    // refresh pair for the session making this request, so it isn't logged
    // out by its own password change.
    HttpApiEndpoint.post("changePassword", "/users/me/password")
      .setPayload(ChangePasswordBody)
      .addSuccess(RefreshResponse)
      .addError(InvalidCredentials, { status: 401 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Updates the current user's own profile — display name and avatar URL
    // (issue #67). Full-replace like `updatePost`/`updateChat`. Username is
    // not editable through this endpoint.
    HttpApiEndpoint.put("updateProfile", "/users/me")
      .setPayload(UpdateProfileBody)
      .addSuccess(User)
      .middleware(Authentication),
  )
  .add(
    // Uploads and stores a square-cropped avatar (issue #269), overwriting
    // any existing uploaded avatar and clearing `avatarUrl` — the two are
    // mutually exclusive (see UsersHandler.ts). `updateProfile` above is the
    // inverse: setting `avatarUrl` (or clearing it) always clears an
    // uploaded avatar back to unset.
    HttpApiEndpoint.post("uploadAvatar", "/users/me/avatar")
      .setPayload(UploadAvatarBody)
      .addSuccess(User)
      .addError(InvalidAvatarUpload, { status: 400 })
      .addError(AvatarTooLarge, { status: 413 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Permanently deletes the current user's own account after re-verifying
    // their password (irreversible, so — like `changePassword` — the bearer
    // token alone isn't enough). The `users` row's cascading/`set null` FKs
    // (see db/schema.ts) take care of everything the account owns.
    HttpApiEndpoint.del("deleteAccount", "/users/me")
      .setPayload(DeleteAccountBody)
      .addSuccess(Schema.Void)
      .addError(InvalidCredentials, { status: 401 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Promotes/demotes another user's role — admin only (issue #67: role
    // changes previously required direct DB access). Bumps the target's
    // token_version so an already-issued token can't keep acting under its
    // old role past this call — mirrors `changePassword`'s reasoning.
    HttpApiEndpoint.patch("updateUserRole", "/users/:id/role")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(UpdateUserRoleBody)
      .addSuccess(User)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  );

const PostsGroup = HttpApiGroup.make("posts")
  .add(
    HttpApiEndpoint.get("getPost", "/posts/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Post)
      .addError(NotFound, { status: 404 })
      .middleware(Authentication),
  )
  .add(
    // Authenticated, paginated view over all posts.
    HttpApiEndpoint.get("listPosts", "/posts")
      .setUrlParams(PostsPageQuery)
      .addSuccess(PostsPage)
      .addError(InvalidPostsRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createPost", "/posts")
      .setPayload(CreatePostBody)
      .addSuccess(Post, { status: 201 })
      // Raised when `attachmentId` doesn't reference an attachment owned by
      // the caller (see getOwnedAttachmentOr404 in attachments.ts).
      .addError(NotFound, { status: 404 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.put("updatePost", "/posts/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(UpdatePostBody)
      .addSuccess(Post)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.del("deletePost", "/posts/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  );

// Comments, replies, and reactions on posts/comments. Kept in its own group
// (rather than folded into `posts`) since it spans two path roots
// (`/posts/:id/...` and `/comments/:id/...`) and its own handler — the group
// name is just an organizational label, it doesn't have to match the path.
const IdParam = Schema.Struct({ id: Schema.NumberFromString });

const CommentsGroup = HttpApiGroup.make("comments")
  .add(
    // Idempotent add-reaction on a post — reacting with an emoji already
    // reacted with is a no-op, returning the current state. Emits a
    // feed-wide `reaction_changed` realtime event.
    HttpApiEndpoint.post("addPostReaction", "/posts/:id/reactions")
      .setPath(IdParam)
      .setPayload(ReactionBody)
      .addSuccess(ReactionState)
      .addError(NotFound, { status: 404 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Removes one specific emoji reaction — a user may have reacted with more
    // than one emoji on the same target, so this only clears the one named in
    // the payload, not every reaction of theirs on it.
    HttpApiEndpoint.del("removePostReaction", "/posts/:id/reactions")
      .setPath(IdParam)
      .setPayload(ReactionBody)
      .addSuccess(ReactionState)
      .addError(NotFound, { status: 404 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Oldest-first page of a post's top-level comments (replies excluded —
    // fetch those per-comment via `listReplies`). Keyset-paginated like
    // `listPosts`.
    HttpApiEndpoint.get("listComments", "/posts/:id/comments")
      .setPath(IdParam)
      .setUrlParams(CommentsPageQuery)
      .addSuccess(CommentsPage)
      .addError(NotFound, { status: 404 })
      .addError(InvalidCommentRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createComment", "/posts/:id/comments")
      .setPath(IdParam)
      .setPayload(CreateCommentBody)
      .addSuccess(Comment, { status: 201 })
      .addError(NotFound, { status: 404 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Oldest-first page of a comment's replies.
    HttpApiEndpoint.get("listReplies", "/comments/:id/replies")
      .setPath(IdParam)
      .setUrlParams(CommentsPageQuery)
      .addSuccess(CommentsPage)
      .addError(NotFound, { status: 404 })
      .addError(InvalidCommentRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Creates a reply to a top-level comment. Rejects (400) if the target is
    // itself a reply — the depth-2 nesting cap (see EngagementHandler.ts).
    HttpApiEndpoint.post("createReply", "/comments/:id/replies")
      .setPath(IdParam)
      .setPayload(CreateCommentBody)
      .addSuccess(Comment, { status: 201 })
      .addError(NotFound, { status: 404 })
      .addError(InvalidCommentRequest, { status: 400 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Add-reaction on a comment or reply (both live in `comments`, so one
    // endpoint covers both). Emits a `reaction_changed` event scoped to the
    // post's comment-room subscribers rather than broadcast feed-wide.
    HttpApiEndpoint.post("addCommentReaction", "/comments/:id/reactions")
      .setPath(IdParam)
      .setPayload(ReactionBody)
      .addSuccess(ReactionState)
      .addError(NotFound, { status: 404 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.del("removeCommentReaction", "/comments/:id/reactions")
      .setPath(IdParam)
      .setPayload(ReactionBody)
      .addSuccess(ReactionState)
      .addError(NotFound, { status: 404 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Edits a comment/reply's content — the author only (or an admin), same
    // `canModify` rule as posts.
    HttpApiEndpoint.patch("updateComment", "/comments/:id")
      .setPath(IdParam)
      .setPayload(UpdateCommentBody)
      .addSuccess(Comment)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Deletes a comment/reply — the author only (or an admin). A top-level
    // comment's replies and every like on it cascade via the FKs.
    HttpApiEndpoint.del("deleteComment", "/comments/:id")
      .setPath(IdParam)
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  );

const ChatIdPath = Schema.Struct({ id: Schema.NumberFromString });

const MessageIdPath = Schema.Struct({
  id: Schema.NumberFromString,
  messageId: Schema.NumberFromString,
});

const ChatParticipantPath = Schema.Struct({
  id: Schema.NumberFromString,
  userId: Schema.NumberFromString,
});

const ChatInvitePath = Schema.Struct({
  id: Schema.NumberFromString,
  inviteId: Schema.NumberFromString,
});

const InviteCodePath = Schema.Struct({
  code: Schema.String,
});

export const DEFAULT_CHATS_LIMIT = 30;
export const MAX_CHATS_LIMIT = 100;

// `listChats` sorts by `updated_at desc, id desc`, and a chat's `updated_at`
// bumps to "now" on every new message — so an OFFSET-based page (like
// PostsPageQuery/MessagesPageQuery) would see rows shift out from under an
// in-flight offset as chats jump to the top mid-scroll, producing skipped or
// duplicated rows across pages. A keyset cursor instead resumes from
// "everything strictly after the last row I saw", which stays correct
// regardless of what changes ahead of it (issue #49). The cursor is opaque
// to clients: it's `<lastRow.updatedAt>:<lastRow.id>`, base64url-encoded, and
// only ever round-tripped from a previous page's `nextCursor` rather than
// constructed by hand.
//
// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md) — it's inlined into query parameters.
export const ChatsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, MAX_CHATS_LIMIT),
    ),
  ),
});

export const ChatsPage = Schema.Struct({
  chats: Schema.Array(Chat),
  limit: Schema.Number,
  // Opaque cursor for the next page, or null once the current page reaches
  // the end of the list — mirrors `MessagesPage.hasMore` but carries the
  // resume point instead of a boolean, since the next request needs it.
  nextCursor: Schema.NullOr(Schema.String),
}).annotations({ identifier: "ChatsPage" });

const ChatsGroup = HttpApiGroup.make("chats")
  .add(
    // All chats the current user participates in, newest-activity-first,
    // each carrying its own unread count and last-message preview so the
    // chat list never needs a request per row. Cursor-paginated (see
    // `ChatsPageQuery`) rather than returning the full set.
    HttpApiEndpoint.get("listChats", "/chats")
      .setUrlParams(ChatsPageQuery)
      .addSuccess(ChatsPage)
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getChat", "/chats/:id")
      .setPath(ChatIdPath)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    // Idempotent: returns the existing direct chat with this user if one
    // already exists rather than creating a duplicate.
    HttpApiEndpoint.post("createDirectChat", "/chats/direct")
      .setPayload(CreateDirectChatBody)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createGroupChat", "/chats/group")
      .setPayload(CreateGroupChatBody)
      .addSuccess(Chat, { status: 201 })
      .addError(NotFound, { status: 404 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Renames a group chat — the owner or an admin (per-chat role, issue
    // #220; formerly creator-only).
    HttpApiEndpoint.put("updateChat", "/chats/:id")
      .setPath(ChatIdPath)
      .setPayload(UpdateChatBody)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Adds participants to a group chat — the owner or an admin.
    HttpApiEndpoint.post("addParticipants", "/chats/:id/participants")
      .setPath(ChatIdPath)
      .setPayload(AddParticipantsBody)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Removes a participant from a group chat — the owner or an admin.
    // Counterpart to `addParticipants`. If this empties the chat, it's
    // deleted entirely (see `deleteChat`'s cascade). If the removed
    // participant was the chat's owner, ownership is transferred
    // automatically to the longest-standing remaining participant so the
    // group doesn't become unmanageable (mirrors `leaveChat`).
    HttpApiEndpoint.del("removeParticipant", "/chats/:id/participants/:userId")
      .setPath(ChatParticipantPath)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // A participant removes themselves from a group chat. If this empties
    // the chat, it's deleted entirely. If the leaver was the creator,
    // ownership transfers automatically to the longest-standing remaining
    // participant — see `removeParticipant`.
    HttpApiEndpoint.post("leaveChat", "/chats/:id/leave")
      .setPath(ChatIdPath)
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Deletes a group chat outright — the owner or an admin. The
    // `chats` row's cascading foreign keys (see db/schema.ts) take care of
    // its participants, messages, and read receipts.
    HttpApiEndpoint.del("deleteChat", "/chats/:id")
      .setPath(ChatIdPath)
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Reassigns a group chat's `createdBy` to another current participant —
    // the creator or an admin, normally. If the chat has no creator (e.g.
    // the previous creator's account was deleted, see `Chat.createdBy`),
    // any current participant may call this to appoint a new owner, so the
    // group doesn't stay permanently unmanageable.
    HttpApiEndpoint.post("transferOwnership", "/chats/:id/owner")
      .setPath(ChatIdPath)
      .setPayload(TransferOwnershipBody)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Promotes/demotes a participant between "admin" and "member" — the
    // owner only (an admin can't create or demote other admins). The owner's
    // own role can't be changed here; use `transferOwnership` instead
    // (issue #220).
    HttpApiEndpoint.patch(
      "updateParticipantRole",
      "/chats/:id/participants/:userId/role",
    )
      .setPath(ChatParticipantPath)
      .setPayload(UpdateParticipantRoleBody)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Oldest-first page of a chat's messages — any participant may read.
    HttpApiEndpoint.get("listMessages", "/chats/:id/messages")
      .setPath(ChatIdPath)
      .setUrlParams(MessagesPageQuery)
      .addSuccess(MessagesPage)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createMessage", "/chats/:id/messages")
      .setPath(ChatIdPath)
      .setPayload(CreateMessageBody)
      .addSuccess(Message, { status: 201 })
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    // Fire-and-forget: pushes a `typing` realtime event (see Realtime.ts) to
    // every other participant of the chat. No request body and no
    // meaningful response — the server tracks no "is typing" state at all,
    // each call is just a transient nudge, and the client-side indicator
    // times itself out (see web/src/lib/typing.ts) rather than waiting for a
    // corresponding "stopped typing" signal.
    HttpApiEndpoint.post("sendTyping", "/chats/:id/typing")
      .setPath(ChatIdPath)
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    // Marks every unread message up to and including `messageId` as read by
    // the current user; returns the chat with its recalculated unread count.
    HttpApiEndpoint.post("markRead", "/chats/:id/read")
      .setPath(ChatIdPath)
      .setPayload(MarkReadBody)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    // Edits a message's content — the sender only (or an admin).
    HttpApiEndpoint.put("updateMessage", "/chats/:id/messages/:messageId")
      .setPath(MessageIdPath)
      .setPayload(UpdateMessageBody)
      .addSuccess(Message)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    // Deletes a message — the sender, the chat's owner/admin, or a
    // site-wide admin (issue #220 extended this from sender-only). The
    // `message_reads` rows cascade via the FK, so nothing else to clean up.
    HttpApiEndpoint.del("deleteMessage", "/chats/:id/messages/:messageId")
      .setPath(MessageIdPath)
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    // Mints an invite code for a group chat — the owner or an admin
    // (issue #220). Joining via the code (`joinChatViaInvite`) is open to
    // any authenticated user, so this is the access-control gate: only
    // whoever holds a still-valid code (or link built from it) can join.
    HttpApiEndpoint.post("createChatInvite", "/chats/:id/invites")
      .setPath(ChatIdPath)
      .setPayload(CreateChatInviteBody)
      .addSuccess(ChatInvite, { status: 201 })
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  )
  .add(
    // Lists every invite (active, expired, and revoked) ever created for a
    // group chat — the owner or an admin.
    HttpApiEndpoint.get("listChatInvites", "/chats/:id/invites")
      .setPath(ChatIdPath)
      .addSuccess(Schema.Array(ChatInvite))
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    // Revokes an invite so its code can no longer be redeemed — the owner
    // or an admin.
    HttpApiEndpoint.del("revokeChatInvite", "/chats/:id/invites/:inviteId")
      .setPath(ChatInvitePath)
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  )
  .add(
    // Redeems an invite code, adding the current user to its chat as a
    // "member" — any authenticated user (not just existing participants).
    // Idempotent for someone already in the chat: returns the chat as-is
    // rather than erroring.
    HttpApiEndpoint.post("joinChatViaInvite", "/chats/invites/:code/join")
      .setPath(InviteCodePath)
      .addSuccess(Chat)
      .addError(NotFound, { status: 404 })
      .addError(InvalidChatRequest, { status: 400 })
      .middleware(Authentication),
  );

// Multipart upload payload (issue #221) — a single "file" field, persisted
// to a temp path by the framework (see Multipart.PersistedFile) before the
// handler reads it. `maxFileSize` here is a coarse, in-stream backstop
// against an attacker just sending gigabytes of data — enforced while the
// body is still streaming in, before it ever hits disk. It's deliberately
// looser than `MAX_ATTACHMENT_SIZE_BYTES`'s precise, typed
// `AttachmentTooLarge` check the handler runs afterward on the persisted
// file — set equal to it, an ordinary too-large upload would trip this
// coarse limit first and surface as a generic 400 (rejected by the
// multipart parser itself, before the handler's payload schema even exists
// to attach a typed error to) instead of the typed 413.
const UploadAttachmentBody = HttpApiSchema.Multipart(
  Schema.Struct({ file: Multipart.SingleFileSchema }),
  { maxFileSize: Option.some(MAX_ATTACHMENT_SIZE_BYTES * 2) },
);

const AttachmentsGroup = HttpApiGroup.make("attachments")
  .add(
    HttpApiEndpoint.post("uploadAttachment", "/attachments")
      .setPayload(UploadAttachmentBody)
      .addSuccess(Attachment, { status: 201 })
      .addError(UnsupportedAttachmentType, { status: 415 })
      .addError(AttachmentTooLarge, { status: 413 })
      .addError(AttachmentQuotaExceeded, { status: 413 })
      .addError(TooManyRequests, { status: 429 })
      .middleware(Authentication),
  )
  .add(
    // Scoped to the caller's own uploads (see getOwnedAttachmentOr404 in
    // attachments.ts) — folds "doesn't exist" and "exists but isn't mine"
    // into the same 404 rather than a 403, mirroring that helper. A
    // message/post that already referenced this attachment just loses it
    // (the FK is `set null` on delete — see db/schema.ts), it doesn't block
    // the delete.
    HttpApiEndpoint.del("deleteAttachment", "/attachments/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .middleware(Authentication),
  );

export const VersionResponse = Schema.Struct({
  version: Schema.String,
}).annotations({ identifier: "VersionResponse" });
export type VersionResponse = typeof VersionResponse.Type;

const MetaGroup = HttpApiGroup.make("meta").add(
  // Unauthenticated on purpose — the frontend displays this in its footer
  // before (and regardless of) login.
  HttpApiEndpoint.get("getVersion", "/version").addSuccess(VersionResponse),
);

export const WsTicketResponse = Schema.Struct({
  ticket: Schema.String,
}).annotations({ identifier: "WsTicketResponse" });
export type WsTicketResponse = typeof WsTicketResponse.Type;

const RealtimeGroup = HttpApiGroup.make("realtime").add(
  // Mints a short-lived, single-use ticket (see WsTicket.ts) for the raw
  // `/ws` route to redeem on upgrade — the browser `WebSocket` handshake
  // can't carry the normal `Authorization: Bearer` header, so this lets it
  // authenticate without putting the long-lived access token itself in a URL
  // (see issue #26).
  HttpApiEndpoint.post("createWsTicket", "/realtime/ws-ticket")
    .addSuccess(WsTicketResponse, { status: 201 })
    .middleware(Authentication),
);

export class ChatApi extends HttpApi.make("chat-platform")
  .add(UsersGroup)
  .add(PostsGroup)
  .add(CommentsGroup)
  .add(ChatsGroup)
  .add(AttachmentsGroup)
  .add(MetaGroup)
  .add(RealtimeGroup)
  .annotate(OpenApi.Version, packageJson.version) {}
