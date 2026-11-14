import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";
import { Attachment } from "./attachments.ts";
import { AvatarVariants, isMinLength } from "./common.ts";
import {
  Forbidden,
  InvalidChatRequest,
  NotFound,
  TooManyRequests,
} from "./errors.ts";
import {
  ReactionBody,
  ReactionState,
  ReactionSummary,
  requireAllowedImageUrl,
  requireAttachmentId,
  requireCaptionOnlyWithAttachment,
} from "./posts.ts";
import {
  AvatarTooLarge,
  InvalidAvatarUpload,
  UploadAvatarBody,
} from "./users.ts";

// A chat is either a "direct" (exactly two participants, no title — the UI
// derives a name from the other participant) or a "group" chat (2-20
// participants, a title set at creation and changeable by its creator).
export const ChatType = Schema.Literals(["direct", "group"]).annotate({
  identifier: "ChatType",
});

export type ChatType = typeof ChatType.Type;

// Total participants a chat (of either kind) may ever have, creator included.
export const MAX_GROUP_PARTICIPANTS = 20;

const MAX_GROUP_TITLE_LENGTH = 100;

const GroupTitle = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_GROUP_TITLE_LENGTH),
);

// Per-chat role (issue #220) — distinct from `User.role` (site-wide admin).
// Only meaningful for group chats: a direct chat's two participants are
// both always "member". "owner" tracks `Chat.createdBy` 1:1 (see
// db/schema.ts); "admin" is granted by the owner via `updateParticipantRole`
// and, alongside "owner", can rename the group, add/remove participants, and
// delete any message in it.
export const ChatRole = Schema.Literals(["owner", "admin", "member"]).annotate({
  identifier: "ChatRole",
});

export type ChatRole = typeof ChatRole.Type;

export const ChatParticipant = Schema.Struct({
  userId: Schema.Finite,
  username: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  // Same avatar fields as `User` (api/users.ts), mirrored here so a chat's
  // participant list (chat header, member list, chat-list preview) can render
  // the same avatar as everywhere else instead of falling back to initials.
  avatarUrl: Schema.NullOr(Schema.String),
  avatarVariants: Schema.NullOr(AvatarVariants),
  role: ChatRole,
  // Same custom-status fields as `User` (api/users.ts, issue #218), so a chat's
  // participant list (chat header, member list, chat-list preview) can render
  // it without a separate per-user lookup.
  statusText: Schema.NullOr(Schema.String),
  statusEmoji: Schema.NullOr(Schema.String),
  statusExpiresAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "ChatParticipant" });

export type ChatParticipant = typeof ChatParticipant.Type;

// Content types a message's body can hold — mirrors `PostContentType` but
// kept as its own union so messages and posts can diverge later.
export const MessageContentType = Schema.Literals([
  "text",
  "image_url",
  "attachment",
]).annotate({ identifier: "MessageContentType" });

export type MessageContentType = typeof MessageContentType.Type;

// Shorter than a post's cap — chat messages are conversational, not
// long-form content, so a generous-but-bounded limit keeps bubbles sane.
export const MAX_MESSAGE_CONTENT_LENGTH = 4_000;

const MessageContent = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_MESSAGE_CONTENT_LENGTH),
);

// How much of a quoted parent message's content is echoed in a reply's
// `parentMessage` preview (issue #217). Chat bubbles show only a one-line
// snippet of what's being replied to, so the full body (up to
// MAX_MESSAGE_CONTENT_LENGTH) never needs to ride along on every reply — the
// backend truncates to this before sending (see `resolveParentPreviews`
// in chats/messageViews.ts). Kept generous enough to fill a preview line at any
// sensible width.
export const PARENT_MESSAGE_PREVIEW_LENGTH = 120;

// A lightweight quote of the message a reply points at (issue #217) — just
// enough to render "replying to <sender>: <snippet>" above the reply, without
// embedding a full (potentially itself-a-reply) `Message` and recursing.
// `senderName` is the parent sender's resolved display name (displayName ??
// username), joined server-side so the client needn't have that user in hand
// (they might have since left the chat). `content` is truncated to
// PARENT_MESSAGE_PREVIEW_LENGTH; `contentType` lets the client show "Photo"/
// "Attachment" instead of a raw URL/filename for non-text parents.
export const ParentMessagePreview = Schema.Struct({
  id: Schema.Finite,
  senderId: Schema.Finite,
  senderName: Schema.String,
  contentType: MessageContentType,
  content: Schema.String,
  // The quoted message's caption (issue #765), truncated like `content` —
  // null unless it's a captioned attachment, so a quote can show the
  // caption rather than only "Attachment".
  caption: Schema.NullOr(Schema.String),
  // Whether the quoted message is itself a forward (issue #601), so the
  // quote can carry the same "Forwarded" marker as the bubble it points at.
  forwarded: Schema.Boolean,
}).annotate({ identifier: "ParentMessagePreview" });

export type ParentMessagePreview = typeof ParentMessagePreview.Type;

// Where a forwarded message came from (issue #601) — a snapshot taken when
// it was forwarded, so it doesn't follow later renames or deletions.
// `senderName` is the original sender's display name (displayName ??
// username) at that time; `senderId` is null once that account is gone, so
// a client only links the label to a profile that still exists. Forwarding a
// forward copies this through unchanged — it always credits the original
// author, never the person in the middle — so it never nests.
//
// Showing the original sender's name to the target chat is deliberate, as in
// most messengers: anyone in a chat a message is forwarded into can see who
// first wrote it, even if they don't otherwise know them.
export const ForwardedFrom = Schema.Struct({
  senderId: Schema.NullOr(Schema.Finite),
  senderName: Schema.String,
}).annotate({ identifier: "ForwardedFrom" });

export type ForwardedFrom = typeof ForwardedFrom.Type;

export const Message = Schema.Struct({
  id: Schema.Finite,
  chatId: Schema.Finite,
  senderId: Schema.Finite,
  contentType: MessageContentType,
  content: Schema.String,
  // Set only when contentType is "attachment" — see `Attachment`
  // (api/attachments.ts).
  attachment: Schema.NullOr(Attachment),
  // Text sent alongside an attachment (issue #765) — see `Post.caption`.
  caption: Schema.NullOr(Schema.String),
  // The message this one is a reply to (issue #217), as a lightweight preview
  // — null for a normal (non-reply) message, or when the quoted message has
  // since been deleted (the FK is `set null`, see db/schema.ts).
  parentMessage: Schema.NullOr(ParentMessagePreview),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  // Ids of participants (other than the sender) who have read this message —
  // read state is tracked per message/user, not as a single chat-wide flag,
  // so the UI can show WhatsApp/Telegram-style read receipts.
  readByUserIds: Schema.Array(Schema.Finite),
  // Emoji reactions on this message (issue #216) — computed on read (see
  // reactions.ts) rather than stored, same convention as `Post.reactions`/
  // `Comment.reactions`: one entry per emoji with at least one reaction.
  reactions: Schema.Array(ReactionSummary),
  // Pinned and starred flags (issue #223) — computed on read (see
  // pinsStars.ts), not stored on the row. `pinned` is chat-wide: true when
  // this message is currently pinned for every participant to see. `starred`
  // is per-viewer: true when the requesting user has personally bookmarked it
  // (never reflects anyone else's stars). Both default to false.
  pinned: Schema.Boolean,
  starred: Schema.Boolean,
  // Set when this message is a forward (issue #601), null otherwise — see
  // `ForwardedFrom` above.
  forwardedFrom: Schema.NullOr(ForwardedFrom),
  // The idempotency key the message was sent with (`CreateMessageBody.
  // clientId`) — only ever present for the viewer's *own* messages, never
  // anyone else's. It's how the sender's client matches a message arriving
  // through a refetch to the optimistic "sending" bubble it's still showing
  // for it, whichever of the POST response and the realtime refetch lands
  // first.
  clientId: Schema.optional(Schema.String),
}).annotate({ identifier: "Message" });

export type Message = typeof Message.Type;

// The viewer's pending message request for a chat (issue #785): they were
// put in this group by someone they shared no chat with, and haven't
// accepted yet. `addedBy` is who did it (null once that account is gone),
// so declining can offer to block them.
export const MessageRequest = Schema.Struct({
  addedBy: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "MessageRequest" });

export type MessageRequest = typeof MessageRequest.Type;

export const Chat = Schema.Struct({
  id: Schema.Finite,
  type: ChatType,
  title: Schema.NullOr(Schema.String),
  // Null once the creator's account has been deleted (see db/schema.ts) —
  // the chat and its history survive, but creator-only actions (rename, add
  // participants) become unavailable to everyone.
  createdBy: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  // Monotonically increases on every participant-visible change to this chat
  // (see db/schema.ts). Also carried on the `chat_updated` realtime event, so
  // a client can compare the two to tell whether it's missed an update
  // (issue #55) rather than only refetching whenever the next event happens
  // to arrive.
  version: Schema.Finite,
  participants: Schema.Array(ChatParticipant),
  lastMessage: Schema.NullOr(Message),
  // Messages in this chat sent by someone else that the current user hasn't
  // read yet — computed relative to whoever is making the request.
  unreadCount: Schema.Finite,
  // Uploaded-and-cropped group avatar, set via `POST /chats/:id/avatar` and
  // cleared via `DELETE /chats/:id/avatar` — always null for a direct chat
  // (the UI renders the other participant's own avatar instead, same as
  // `title`). Same nested shape as `User.avatarVariants`/
  // `ChatParticipant.avatarVariants` (see `AvatarVariants` in api/common.ts),
  // but unlike those there's no `avatarUrl` counterpart here: a group avatar
  // only ever comes from an upload, not a linked external image.
  avatarVariants: Schema.NullOr(AvatarVariants),
  // Non-null while this chat is a message request for the viewer (issue
  // #785). Until they accept (`POST /chats/:id/accept`) it's left out of
  // their chat list (`GET /chats?requests=true` lists it instead), its
  // `unreadCount` stays 0 and it adds nothing to `/chats/unread-count`.
  // Declining is just leaving (`POST /chats/:id/leave`).
  messageRequest: Schema.NullOr(MessageRequest),
}).annotate({ identifier: "Chat" });

export type Chat = typeof Chat.Type;

export const CreateDirectChatBody = Schema.Struct({
  userId: Schema.Finite,
}).annotate({ identifier: "CreateDirectChatBody" });

export const CreateGroupChatBody = Schema.Struct({
  title: GroupTitle,
  // The creator is added automatically — this is everyone *else*, hence one
  // short of the overall cap.
  participantIds: Schema.Array(Schema.Finite).check(
    isMinLength(1),
    Schema.isMaxLength(MAX_GROUP_PARTICIPANTS - 1),
  ),
}).annotate({ identifier: "CreateGroupChatBody" });

export const UpdateChatBody = Schema.Struct({
  title: GroupTitle,
}).annotate({ identifier: "UpdateChatBody" });

export const AddParticipantsBody = Schema.Struct({
  // A group can never hold more than MAX_GROUP_PARTICIPANTS total, so a
  // single request can never legitimately add more than that minus the
  // existing creator — mirrors CreateGroupChatBody's cap.
  participantIds: Schema.Array(Schema.Finite).check(
    isMinLength(1),
    Schema.isMaxLength(MAX_GROUP_PARTICIPANTS - 1),
  ),
}).annotate({ identifier: "AddParticipantsBody" });

export const TransferOwnershipBody = Schema.Struct({
  userId: Schema.Finite,
}).annotate({ identifier: "TransferOwnershipBody" });

// "owner" is deliberately excluded — appointing an owner goes through
// `POST /chats/:id/owner` (`TransferOwnershipBody`) instead, since that also
// has to move `Chat.createdBy` and demote the previous owner.
export const UpdateParticipantRoleBody = Schema.Struct({
  role: Schema.Literals(["admin", "member"]),
}).annotate({ identifier: "UpdateParticipantRoleBody" });

// Total invites that may exist (active + expired + revoked) for a single
// chat — bounds the table's per-chat growth from repeated
// create/revoke cycles.
export const MAX_INVITES_PER_CHAT = 50;

export const CreateChatInviteBody = Schema.Struct({
  // Omitted means "never expires".
  expiresInHours: Schema.optional(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 24 * 30 }),
    ),
  ),
  // Omitted means "unlimited uses" (still bounded by the chat's own
  // MAX_GROUP_PARTICIPANTS cap at redemption time).
  maxUses: Schema.optional(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: MAX_GROUP_PARTICIPANTS }),
    ),
  ),
}).annotate({ identifier: "CreateChatInviteBody" });

export const ChatInvite = Schema.Struct({
  id: Schema.Finite,
  chatId: Schema.Finite,
  code: Schema.String,
  createdBy: Schema.Finite,
  createdAt: Schema.Finite,
  expiresAt: Schema.NullOr(Schema.Finite),
  maxUses: Schema.NullOr(Schema.Finite),
  useCount: Schema.Finite,
  revokedAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "ChatInvite" });

export type ChatInvite = typeof ChatInvite.Type;

export const CreateMessageBody = Schema.Struct({
  contentType: MessageContentType,
  content: MessageContent,
  // Id of a previously-uploaded attachment (`POST /attachments`) owned by
  // the caller — required exactly when contentType is "attachment".
  attachmentId: Schema.optional(Schema.Finite),
  // Text sent alongside the attachment (issue #765) — see
  // `CreatePostBody.caption`.
  caption: Schema.optional(MessageContent),
  // Id of the message this one replies to (issue #217). Omitted for a normal
  // message. Validated server-side to reference a message in this same chat —
  // a parent from another chat (or a nonexistent one) 404s (see
  // `createMessage` in chats/messageHandlers.ts).
  parentMessageId: Schema.optional(Schema.Finite),
  // Idempotency key (issue #567): a client-generated id, reused when a send is
  // retried. If this sender already stored a message with the same key in
  // this chat, that message is returned instead of creating a duplicate.
  clientId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
})
  .check(
    Schema.makeFilter(requireAllowedImageUrl),
    Schema.makeFilter(requireAttachmentId),
    Schema.makeFilter(requireCaptionOnlyWithAttachment),
  )
  .annotate({ identifier: "CreateMessageBody" });

export const UpdateMessageBody = Schema.Struct({
  contentType: MessageContentType,
  content: MessageContent,
  attachmentId: Schema.optional(Schema.Finite),
  // Same set/clear/keep semantics as `UpdatePostBody.caption`.
  caption: Schema.optional(Schema.NullOr(MessageContent)),
})
  .check(
    Schema.makeFilter(requireAllowedImageUrl),
    Schema.makeFilter(requireAttachmentId),
    Schema.makeFilter(requireCaptionOnlyWithAttachment),
  )
  .annotate({ identifier: "UpdateMessageBody" });

// How many chats one forward may post into (issue #601). Each target is a
// full send — its own insert, notification and, for an attachment, a copy of
// the stored file — so the fan-out is bounded per request.
export const MAX_FORWARD_TARGETS = 10;

export const ForwardMessageBody = Schema.Struct({
  // Chats to post a copy into. Duplicates are collapsed server-side; the
  // source chat itself is allowed (it's just a re-post).
  targetChatIds: Schema.Array(Schema.Int).check(
    isMinLength(1),
    Schema.isMaxLength(MAX_FORWARD_TARGETS),
  ),
  // Idempotency key for the whole forward (see `CreateMessageBody.clientId`).
  // Each target's copy is stored under `${clientId}:${targetChatId}`, so a
  // replay returns the copies already made and only fills in the targets
  // that are missing.
  clientId: Schema.optional(Schema.String.check(Schema.isMaxLength(48))),
}).annotate({ identifier: "ForwardMessageBody" });

// Why one target of a forward didn't get its copy. The rest of the request
// still goes ahead — a forward reports per target rather than failing whole.
// "unavailable" covers both a chat that doesn't exist and one the caller
// isn't (or is no longer) in, so the answer doesn't confirm other chats'
// ids exist.
export const ForwardFailureReason = Schema.Literals([
  "unavailable",
  "blocked",
  "quota_exceeded",
  "invalid_content",
]).annotate({ identifier: "ForwardFailureReason" });

export type ForwardFailureReason = typeof ForwardFailureReason.Type;

export const ForwardTargetResult = Schema.Struct({
  chatId: Schema.Finite,
  // The copy posted into `chatId` — null exactly when `error` is set.
  message: Schema.NullOr(Message),
  error: Schema.NullOr(
    Schema.Struct({ reason: ForwardFailureReason, message: Schema.String }),
  ),
}).annotate({ identifier: "ForwardTargetResult" });

export type ForwardTargetResult = typeof ForwardTargetResult.Type;

export const ForwardMessageResult = Schema.Struct({
  // One entry per distinct target, in the order they were requested.
  results: Schema.Array(ForwardTargetResult),
}).annotate({ identifier: "ForwardMessageResult" });

export type ForwardMessageResult = typeof ForwardMessageResult.Type;

export const MarkReadBody = Schema.Struct({
  messageId: Schema.Finite,
}).annotate({ identifier: "MarkReadBody" });

// Which message to pin, for `POST /chats/:id/pins` (issue #223). Unpinning
// takes the message id in the path (`DELETE /chats/:id/pins/:messageId`)
// instead, so it needs no body. Validated server-side to reference a message
// in this same chat (see chats/pinStarHandlers.ts).
export const PinMessageBody = Schema.Struct({
  messageId: Schema.Finite,
}).annotate({ identifier: "PinMessageBody" });

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
// Cursors are opaque to clients — see `PostsPageQuery` (api/posts.ts).
export const MessagesPageQuery = Schema.Struct({
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_MESSAGES_LIMIT }),
    ),
  ),
});

export const MessagesPage = Schema.Struct({
  messages: Schema.Array(Message),
  limit: Schema.Finite,
  // Whether messages exist before/after the first/last row in this page —
  // derived from fetching one row past `limit` rather than a `COUNT(*)`, same
  // trick as `PostsPage.nextCursor` (issue #51).
  hasEarlier: Schema.Boolean,
  hasNewer: Schema.Boolean,
  // Opaque cursors for the adjacent pages, or null once there's nothing more
  // in that direction to fetch.
  earliestCursor: Schema.NullOr(Schema.String),
  latestCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "MessagesPage" });

const ChatIdPath = Schema.Struct({ id: Schema.Int });

const MessageIdPath = Schema.Struct({
  id: Schema.Int,
  messageId: Schema.Int,
});

const ChatParticipantPath = Schema.Struct({
  id: Schema.Int,
  userId: Schema.Int,
});

const ChatInvitePath = Schema.Struct({
  id: Schema.Int,
  inviteId: Schema.Int,
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
// (api/posts.ts, see CLAUDE.md) — it's inlined into query parameters.
//
// `unread=true` (issue #756) narrows the list to chats with something unread
// for the caller — the chat list's Unread filter — on the server, so an
// older unread chat shows up without paging through every read chat ahead
// of it. Same sort and cursor as the full list.
//
// `requests=true` (issue #785) lists the caller's pending message requests
// instead — chats the default list leaves out until they're accepted.
export const ChatsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_CHATS_LIMIT }),
    ),
  ),
  unread: Schema.optional(Schema.Literals(["true", "false"])),
  requests: Schema.optional(Schema.Literals(["true", "false"])),
});

// The caller's unread total across every chat they're in (issue #756) —
// what the Chats badge and the tab title show. Summed on the server because
// the client only ever has some pages of the chat list loaded.
export const UnreadChatCount = Schema.Struct({
  // Unread messages over every chat: what each chat's `unreadCount` would
  // add up to with the whole list loaded.
  count: Schema.Finite,
  // How many chats have at least one unread message.
  chats: Schema.Finite,
}).annotate({ identifier: "UnreadChatCount" });

export const ChatsPage = Schema.Struct({
  chats: Schema.Array(Chat),
  limit: Schema.Finite,
  // Opaque cursor for the next page, or null once the current page reaches
  // the end of the list — mirrors `MessagesPage.hasMore` but carries the
  // resume point instead of a boolean, since the next request needs it.
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ChatsPage" });

export const ChatsGroup = HttpApiGroup.make("chats")
  .add(
    // All chats the current user participates in, newest-activity-first,
    // each carrying its own unread count and last-message preview so the
    // chat list never needs a request per row. Cursor-paginated (see
    // `ChatsPageQuery`) rather than returning the full set.
    HttpApiEndpoint.get("listChats", "/chats", {
      query: ChatsPageQuery,
      success: ChatsPage,
      error: InvalidChatRequest,
    }).middleware(Authentication),
  )
  .add(
    // The Chats badge and tab title (issue #756) — like
    // `/notifications/unread-count`, cheap enough to fetch on every page
    // load. Registered ahead of `/chats/:id` for the same reason as
    // `/users/by-username` vs `/users/:id`.
    HttpApiEndpoint.get("getUnreadChatCount", "/chats/unread-count", {
      success: UnreadChatCount,
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getChat", "/chats/:id", {
      params: ChatIdPath,
      success: Chat,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Idempotent: returns the existing direct chat with this user if one
    // already exists rather than creating a duplicate.
    HttpApiEndpoint.post("createDirectChat", "/chats/direct", {
      payload: CreateDirectChatBody,
      success: Chat,
      error: [NotFound, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createGroupChat", "/chats/group", {
      payload: CreateGroupChatBody,
      success: Chat.pipe(HttpApiSchema.status(201)),
      // Forbidden: a requested participant is on either side of a block
      // with the caller (issue #757).
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Renames a group chat — the owner or an admin (per-chat role, issue
    // #220; formerly creator-only).
    HttpApiEndpoint.put("updateChat", "/chats/:id", {
      params: ChatIdPath,
      payload: UpdateChatBody,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Uploads and stores a square-cropped group avatar (mirrors
    // `POST /users/me/avatar`) — the owner or an admin. Overwrites any
    // existing group avatar; the old variants are swept from object storage
    // once the row is repointed (see chats/chatHandlers.ts).
    HttpApiEndpoint.post("uploadChatAvatar", "/chats/:id/avatar", {
      params: ChatIdPath,
      payload: UploadAvatarBody,
      success: Chat,
      error: [
        NotFound,
        Forbidden,
        InvalidChatRequest,
        InvalidAvatarUpload,
        AvatarTooLarge,
        TooManyRequests,
      ],
    }).middleware(Authentication),
  )
  .add(
    // Clears a group chat's avatar back to unset (initials fallback) — the
    // owner or an admin. Counterpart to `uploadChatAvatar`; a no-op (still
    // succeeds) if the chat has no uploaded avatar.
    HttpApiEndpoint.delete("deleteChatAvatar", "/chats/:id/avatar", {
      params: ChatIdPath,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Adds participants to a group chat — the owner or an admin. Also 403
    // when a requested user is on either side of a block with the caller
    // (issue #757).
    HttpApiEndpoint.post("addParticipants", "/chats/:id/participants", {
      params: ChatIdPath,
      payload: AddParticipantsBody,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Removes a participant from a group chat — the owner or an admin.
    // Counterpart to `addParticipants`. If this empties the chat, it's
    // deleted entirely (see `deleteChat`'s cascade). If the removed
    // participant was the chat's owner, ownership is transferred
    // automatically to the longest-standing remaining participant so the
    // group doesn't become unmanageable (mirrors `leaveChat`).
    HttpApiEndpoint.delete(
      "removeParticipant",
      "/chats/:id/participants/:userId",
      {
        params: ChatParticipantPath,
        success: Chat,
        error: [NotFound, Forbidden, InvalidChatRequest],
      },
    ).middleware(Authentication),
  )
  .add(
    // Accepts a pending message request (issue #785): the chat joins the
    // caller's list, counts toward their unread total, and shares presence
    // with its members from now on. A no-op for a chat that isn't a request.
    HttpApiEndpoint.post("acceptChatRequest", "/chats/:id/accept", {
      params: ChatIdPath,
      success: Chat,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // A participant removes themselves from a group chat. If this empties
    // the chat, it's deleted entirely. If the leaver was the creator,
    // ownership transfers automatically to the longest-standing remaining
    // participant — see `removeParticipant`.
    HttpApiEndpoint.post("leaveChat", "/chats/:id/leave", {
      params: ChatIdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Deletes a group chat outright — the owner or an admin. The
    // `chats` row's cascading foreign keys (see db/schema.ts) take care of
    // its participants, messages, and read receipts.
    HttpApiEndpoint.delete("deleteChat", "/chats/:id", {
      params: ChatIdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Reassigns a group chat's `createdBy` to another current participant —
    // the creator or an admin, normally. If the chat has no creator (e.g.
    // the previous creator's account was deleted, see `Chat.createdBy`),
    // any current participant may call this to appoint a new owner, so the
    // group doesn't stay permanently unmanageable.
    HttpApiEndpoint.post("transferOwnership", "/chats/:id/owner", {
      params: ChatIdPath,
      payload: TransferOwnershipBody,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Promotes/demotes a participant between "admin" and "member" — the
    // owner only (an admin can't create or demote other admins). The owner's
    // own role can't be changed here; use `transferOwnership` instead
    // (issue #220).
    HttpApiEndpoint.patch(
      "updateParticipantRole",
      "/chats/:id/participants/:userId/role",
      {
        params: ChatParticipantPath,
        payload: UpdateParticipantRoleBody,
        success: Chat,
        error: [NotFound, Forbidden, InvalidChatRequest],
      },
    ).middleware(Authentication),
  )
  .add(
    // Oldest-first page of a chat's messages — any participant may read.
    HttpApiEndpoint.get("listMessages", "/chats/:id/messages", {
      params: ChatIdPath,
      query: MessagesPageQuery,
      success: MessagesPage,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createMessage", "/chats/:id/messages", {
      params: ChatIdPath,
      payload: CreateMessageBody,
      success: Message.pipe(HttpApiSchema.status(201)),
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Posts a copy of a message into up to MAX_FORWARD_TARGETS other chats
    // (issue #601). Each copy is a new message owned by the caller, labelled
    // with the original sender (`Message.forwardedFrom`); an attachment is
    // copied into a new upload the caller owns. The source message must be
    // in a chat the caller is in — otherwise 404, never 403, so ids from
    // other chats aren't confirmed to exist. Targets fail individually
    // (see `ForwardTargetResult`), and each counts as one send.
    HttpApiEndpoint.post(
      "forwardMessage",
      "/chats/:id/messages/:messageId/forward",
      {
        params: MessageIdPath,
        payload: ForwardMessageBody,
        success: ForwardMessageResult,
        error: [NotFound, TooManyRequests],
      },
    ).middleware(Authentication),
  )
  .add(
    // Fire-and-forget: pushes a `typing` realtime event (see Realtime.ts) to
    // every other participant of the chat. No request body and no
    // meaningful response — the server tracks no "is typing" state at all,
    // each call is just a transient nudge, and the client-side indicator
    // times itself out (see web/src/lib/typing.ts) rather than waiting for a
    // corresponding "stopped typing" signal.
    HttpApiEndpoint.post("sendTyping", "/chats/:id/typing", {
      params: ChatIdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Marks every unread message up to and including `messageId` as read by
    // the current user; returns the chat with its recalculated unread count.
    HttpApiEndpoint.post("markRead", "/chats/:id/read", {
      params: ChatIdPath,
      payload: MarkReadBody,
      success: Chat,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Edits a message's content — the sender only (or an admin).
    HttpApiEndpoint.put("updateMessage", "/chats/:id/messages/:messageId", {
      params: MessageIdPath,
      payload: UpdateMessageBody,
      success: Message,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Deletes a message — the sender, the chat's owner/admin, or a
    // site-wide admin (issue #220 extended this from sender-only). The
    // `message_reads` rows cascade via the FK, so nothing else to clean up.
    HttpApiEndpoint.delete("deleteMessage", "/chats/:id/messages/:messageId", {
      params: MessageIdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Idempotent add-reaction on a chat message (issue #216) — reacting with
    // an emoji already reacted with is a no-op, returning the current state.
    // Any participant may react, not just the sender (mirrors `addPostReaction`
    // /`addCommentReaction`). Emits a `reaction_changed` event to every
    // participant of the message's chat.
    HttpApiEndpoint.post(
      "addMessageReaction",
      "/chats/:id/messages/:messageId/reactions",
      {
        params: MessageIdPath,
        payload: ReactionBody,
        success: ReactionState,
        error: [NotFound, Forbidden],
      },
    ).middleware(Authentication),
  )
  .add(
    // Removes one specific emoji reaction from a message — a user may have
    // reacted with more than one emoji, so this only clears the one named in
    // the payload.
    HttpApiEndpoint.delete(
      "removeMessageReaction",
      "/chats/:id/messages/:messageId/reactions",
      {
        params: MessageIdPath,
        payload: ReactionBody,
        success: ReactionState,
        error: [NotFound, Forbidden],
      },
    ).middleware(Authentication),
  )
  .add(
    // The chat's currently-pinned messages (issue #223), newest pin first —
    // any participant may read. Returns full `Message`s (each with `pinned`
    // true), so the pinned panel renders exactly like the main thread.
    HttpApiEndpoint.get("listPinnedMessages", "/chats/:id/pins", {
      params: ChatIdPath,
      success: Schema.Array(Message),
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Pins a message chat-wide (issue #223) — idempotent (re-pinning an
    // already-pinned message is a no-op returning the current state). Any
    // participant may pin, mirroring reactions. Emits a `message_pin_changed`
    // realtime event to every participant. Returns the affected message.
    HttpApiEndpoint.post("pinMessage", "/chats/:id/pins", {
      params: ChatIdPath,
      payload: PinMessageBody,
      success: Message,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Unpins a message (issue #223) — idempotent, and open to any participant
    // like pinning. Emits a `message_pin_changed` event. Returns the affected
    // message (now with `pinned` false).
    HttpApiEndpoint.delete("unpinMessage", "/chats/:id/pins/:messageId", {
      params: MessageIdPath,
      success: Message,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // The current user's own starred messages in this chat (issue #223),
    // newest star first — private, so this only ever returns the caller's
    // bookmarks, never anyone else's.
    HttpApiEndpoint.get("listStarredMessages", "/chats/:id/stars", {
      params: ChatIdPath,
      success: Schema.Array(Message),
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Stars a message as a private bookmark (issue #223) — idempotent, never
    // broadcast (a star is visible only to the user who created it), so no
    // realtime event. Returns the affected message (with `starred` true).
    HttpApiEndpoint.post("starMessage", "/chats/:id/messages/:messageId/star", {
      params: MessageIdPath,
      success: Message,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Removes a private star (issue #223) — idempotent, no realtime event.
    // Returns the affected message (with `starred` false).
    HttpApiEndpoint.delete(
      "unstarMessage",
      "/chats/:id/messages/:messageId/star",
      {
        params: MessageIdPath,
        success: Message,
        error: [NotFound, Forbidden],
      },
    ).middleware(Authentication),
  )
  .add(
    // Mints an invite code for a group chat — the owner or an admin
    // (issue #220). Joining via the code (`joinChatViaInvite`) is open to
    // any authenticated user, so this is the access-control gate: only
    // whoever holds a still-valid code (or link built from it) can join.
    HttpApiEndpoint.post("createChatInvite", "/chats/:id/invites", {
      params: ChatIdPath,
      payload: CreateChatInviteBody,
      success: ChatInvite.pipe(HttpApiSchema.status(201)),
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Lists every invite (active, expired, and revoked) ever created for a
    // group chat — the owner or an admin.
    HttpApiEndpoint.get("listChatInvites", "/chats/:id/invites", {
      params: ChatIdPath,
      success: Schema.Array(ChatInvite),
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Revokes an invite so its code can no longer be redeemed — the owner
    // or an admin.
    HttpApiEndpoint.delete("revokeChatInvite", "/chats/:id/invites/:inviteId", {
      params: ChatInvitePath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Redeems an invite code, adding the current user to its chat as a
    // "member" — any authenticated user (not just existing participants).
    // Idempotent for someone already in the chat: returns the chat as-is
    // rather than erroring. 403 when the caller and the invite's creator
    // are on either side of a block (issue #757).
    HttpApiEndpoint.post("joinChatViaInvite", "/chats/invites/:code/join", {
      params: InviteCodePath,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  );
