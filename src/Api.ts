import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { Authentication } from "./Auth.ts";

// "admin" can edit/delete any post; "user" can only edit/delete their own.
// Registration always creates a "user" — admins are promoted out-of-band.
export const UserRole = Schema.Literal("user", "admin").annotations({
  identifier: "UserRole",
});
export type UserRole = typeof UserRole.Type;

// Public representation of a user — never exposes the password hash.
// `identifier` annotations surface these as named schemas in the OpenAPI spec.
export const User = Schema.Struct({
  id: Schema.Number,
  username: Schema.String,
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

// A generous ceiling — long enough for any real passphrase, but bounded so a
// multi-megabyte payload can't be pushed through the (deliberately
// expensive) Argon2id hash/verify path. Minimum length/complexity is a
// separate concern (issue #45).
export const MAX_PASSWORD_LENGTH = 128;

const Password = Schema.NonEmptyString.pipe(
  Schema.maxLength(MAX_PASSWORD_LENGTH),
);

export const RegisterBody = Schema.Struct({
  username: Username,
  password: Password,
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

// Content types a post's body can hold. Extend this union (and the handler's
// per-type validation, if any is ever needed) to support new post kinds.
export const PostContentType = Schema.Literal("text", "image_url").annotations({
  identifier: "PostContentType",
});
export type PostContentType = typeof PostContentType.Type;

// Generous but bounded — prevents unbounded payloads while comfortably
// fitting a long-form text post or an image URL.
const MAX_POST_CONTENT_LENGTH = 10_000;

const PostContent = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_POST_CONTENT_LENGTH),
);

export const Post = Schema.Struct({
  id: Schema.Number,
  authorId: Schema.Number,
  contentType: PostContentType,
  content: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotations({ identifier: "Post" });
export type Post = typeof Post.Type;

export const CreatePostBody = Schema.Struct({
  contentType: PostContentType,
  content: PostContent,
}).annotations({ identifier: "CreatePostBody" });

export const UpdatePostBody = Schema.Struct({
  contentType: PostContentType,
  content: PostContent,
}).annotations({ identifier: "UpdatePostBody" });

export const DEFAULT_POSTS_LIMIT = 20;
export const MAX_POSTS_LIMIT = 100;

// `offset`/`limit` (rather than `page`/`pageSize`) so a caller can request
// irregularly-sized batches — e.g. an infinite-scroll feed that loads 5 posts
// up front and 3 at a time thereafter — without the batch size having to stay
// constant across requests.
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
  offset: Schema.optional(
    Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, MAX_POSTS_LIMIT),
    ),
  ),
});

export const PostsPage = Schema.Struct({
  posts: Schema.Array(Post),
  offset: Schema.Number,
  limit: Schema.Number,
  total: Schema.Number,
}).annotations({ identifier: "PostsPage" });

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

export const ChatParticipant = Schema.Struct({
  userId: Schema.Number,
  username: Schema.String,
}).annotations({ identifier: "ChatParticipant" });
export type ChatParticipant = typeof ChatParticipant.Type;

// Content types a message's body can hold — mirrors `PostContentType` but
// kept as its own union so messages and posts can diverge later.
export const MessageContentType = Schema.Literal(
  "text",
  "image_url",
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

export const CreateMessageBody = Schema.Struct({
  contentType: MessageContentType,
  content: MessageContent,
}).annotations({ identifier: "CreateMessageBody" });

export const UpdateMessageBody = Schema.Struct({
  contentType: MessageContentType,
  content: MessageContent,
}).annotations({ identifier: "UpdateMessageBody" });

export const MarkReadBody = Schema.Struct({
  messageId: Schema.Number,
}).annotations({ identifier: "MarkReadBody" });

export const DEFAULT_MESSAGES_LIMIT = 30;
export const MAX_MESSAGES_LIMIT = 100;

// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md) — it's inlined into path/query parameters.
export const MessagesPageQuery = Schema.Struct({
  offset: Schema.optional(
    Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.between(1, MAX_MESSAGES_LIMIT),
    ),
  ),
});

export const MessagesPage = Schema.Struct({
  messages: Schema.Array(Message),
  offset: Schema.Number,
  limit: Schema.Number,
  total: Schema.Number,
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
      .middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createPost", "/posts")
      .setPayload(CreatePostBody)
      .addSuccess(Post, { status: 201 })
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

const ChatIdPath = Schema.Struct({ id: Schema.NumberFromString });

const MessageIdPath = Schema.Struct({
  id: Schema.NumberFromString,
  messageId: Schema.NumberFromString,
});

const ChatsGroup = HttpApiGroup.make("chats")
  .add(
    // All chats the current user participates in, newest-activity-first,
    // each carrying its own unread count and last-message preview so the
    // chat list never needs a request per row.
    HttpApiEndpoint.get("listChats", "/chats")
      .addSuccess(Schema.Array(Chat))
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
    // Renames a group chat — the creator only.
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
    // Adds participants to a group chat — the creator only.
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
    // Oldest-first page of a chat's messages — any participant may read.
    HttpApiEndpoint.get("listMessages", "/chats/:id/messages")
      .setPath(ChatIdPath)
      .setUrlParams(MessagesPageQuery)
      .addSuccess(MessagesPage)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
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
    // Deletes a message — the sender only (or an admin). The
    // `message_reads` rows cascade via the FK, so nothing else to clean up.
    HttpApiEndpoint.del("deleteMessage", "/chats/:id/messages/:messageId")
      .setPath(MessageIdPath)
      .addSuccess(Schema.Void)
      .addError(NotFound, { status: 404 })
      .addError(Forbidden, { status: 403 })
      .middleware(Authentication),
  );

export class ChatApi extends HttpApi.make("chat-platform")
  .add(UsersGroup)
  .add(PostsGroup)
  .add(ChatsGroup) {}
