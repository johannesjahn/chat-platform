import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    // Optional profile fields (issue #67) — null means "unset", falling back
    // to `username` (display name) or initials (avatar) in the UI.
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    role: text("role", { enum: ["user", "admin"] })
      .notNull()
      .default("user"),
    // Bumped on password change or forced logout to immediately invalidate
    // every outstanding access + refresh token, rather than waiting for each
    // to hit its own TTL — embedded in issued tokens and compared against this
    // column on every verification (src/Jwt.ts, src/UsersHandler.ts).
    tokenVersion: integer("token_version").notNull().default(0),
  },
  (table) => [
    // Case-insensitive uniqueness: `Alice` and `alice` must not both be
    // registerable, since login rate-limiting and lookups already treat
    // usernames case-insensitively (see issue #175).
    uniqueIndex("users_username_lower_idx").on(sql`lower(${table.username})`),
  ],
);

export type DbUser = typeof users.$inferSelect;
export type NewDbUser = typeof users.$inferInsert;

// One row per issued refresh token, keyed on its JWT `jti` claim. `POST
// /users/refresh` looks up the presented token's jti here and rejects
// anything not found or already revoked. Rotation doesn't delete the old
// row — it sets `revokedAt` and inserts a new row sharing the same
// `familyId` — so a later replay of that same (rotated-away) token can be
// told apart from a token that was never issued, and treated as a sign of
// theft: `POST /users/refresh` responds by revoking every still-active row
// in the family, forcing the whole chain (including whatever legitimate
// token the theft victim rotated to) to re-authenticate. Explicit
// logout/revocation also just sets `revokedAt` rather than deleting.
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    jti: text("jti").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Shared by every token descended from the same login via rotation, so
    // reuse of one member of the chain can revoke the whole chain at once.
    familyId: text("family_id").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
  },
  (table) => [index("refresh_tokens_family_id_idx").on(table.familyId)],
);

export type DbRefreshToken = typeof refreshTokens.$inferSelect;
export type NewDbRefreshToken = typeof refreshTokens.$inferInsert;

// Uploaded files (issue #221) — one row per successful `POST /attachments`
// upload. `storageKey` is the object's key in the S3-compatible bucket (see
// src/AttachmentStorage.ts), not a public URL: a fresh presigned/served URL
// is generated on every read instead of being stored, so it can't go stale
// or leak past its TTL. An attachment is only ever referenced by exactly one
// message/post (via their nullable `attachmentId` FK below) — it isn't a
// shared media library — so there's no back-reference here to what it's
// attached to.
export const attachments = pgTable(
  "attachments",
  {
    id: serial("id").primaryKey(),
    uploaderId: integer("uploader_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    storageKey: text("storage_key").notNull(),
    // Set only for image attachments (issue #248) — populated from the
    // scaled-down variant actually stored, not the original upload, so they
    // always match what `storageKey` serves. Null for non-image attachments
    // (video/audio/pdf) and for rows written before this migration.
    width: integer("width"),
    height: integer("height"),
    // A compact ~20-30 char BlurHash string (https://blurha.sh/) the
    // frontend decodes into a low-res placeholder shown while the real image
    // loads (see AttachmentPreview.tsx), eliminating the pop-in a bare
    // `bg-muted` box left. Same nullability as width/height above.
    blurhash: text("blurhash"),
    createdAt: timestamp("created_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("attachments_uploader_id_idx").on(table.uploaderId)],
);

export type DbAttachment = typeof attachments.$inferSelect;
export type NewDbAttachment = typeof attachments.$inferInsert;

export const posts = pgTable(
  "posts",
  {
    id: serial("id").primaryKey(),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contentType: text("content_type", {
      enum: ["text", "image_url", "attachment"],
    }).notNull(),
    content: text("content").notNull(),
    // Set only when contentType is "attachment" — null'd out (rather than
    // cascading the post's own deletion) if the attachment row it points at
    // is ever removed independently, since a post should outlive that.
    attachmentId: integer("attachment_id").references(() => attachments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // Postgres doesn't auto-index foreign key columns — without this, cascade
  // deletes from `users` and any author-filtered listing scan every post.
  // `attachmentId` is indexed for the same reason: `attachments`' `set null`
  // FK above needs to find referencing posts when an attachment is deleted.
  (table) => [
    index("posts_author_id_idx").on(table.authorId),
    index("posts_attachment_id_idx").on(table.attachmentId),
  ],
);

export type DbPost = typeof posts.$inferSelect;
export type NewDbPost = typeof posts.$inferInsert;

// Comments on posts, plus one level of replies (a reply is just a comment
// whose `parentCommentId` points at another comment). Nesting is capped at
// depth 2 — post → comment → reply — enforced in the application layer at
// create time (see EngagementHandler.ts), not by the schema: a reply's
// parent must itself be a top-level comment (`parentCommentId` null), so a
// reply can never be replied to. Both the post FK and the self FK cascade,
// so deleting a post removes its whole thread and deleting a top-level
// comment removes its replies.
export const comments = pgTable(
  "comments",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    // Null for a top-level comment, set to the parent comment's id for a
    // reply. The `AnyPgColumn` return annotation is required for a
    // self-referencing FK — without it the column type would be inferred
    // circularly.
    parentCommentId: integer("parent_comment_id").references(
      (): AnyPgColumn => comments.id,
      { onDelete: "cascade" },
    ),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // `listComments` filters + orders by (postId, id) for top-level comments;
    // Postgres doesn't auto-index FK columns, so without this every page
    // (and every cascade delete from `posts`) scans the whole table.
    index("comments_post_id_idx").on(table.postId, table.id),
    // `listReplies` filters + orders by (parentCommentId, id); also serves
    // the self-referential cascade delete when a top-level comment is
    // removed.
    index("comments_parent_comment_id_idx").on(table.parentCommentId, table.id),
    index("comments_author_id_idx").on(table.authorId),
  ],
);

export type DbComment = typeof comments.$inferSelect;
export type NewDbComment = typeof comments.$inferInsert;

// One row per (user, target, emoji) reaction. The target is polymorphic:
// exactly one of `postId`/`commentId` is set (enforced by the check
// constraint), so a single table covers reactions on posts, comments, and
// replies alike (replies live in `comments`). `emoji` started as a plain
// binary "like" (issue #67) and was widened to a standard-emoji reaction set
// (issue #215) by adding this column rather than a new table — a user may now
// react to the same target with more than one distinct emoji (one row each),
// but at most once per (target, emoji) pair, per the unique constraints
// below. Deliberately left as free-form `text` rather than a DB-level enum/
// check: the allowed set is enforced at the API layer (`ReactionEmoji` in
// Api.ts) instead, so a future custom-emoji set doesn't need a migration to
// loosen a DB constraint. Reaction counts are computed on read (a grouped
// COUNT over this table, per emoji — see reactions.ts) rather than
// denormalized, so there's no counter column to drift out of sync.
export const likes = pgTable(
  "likes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: integer("post_id").references(() => posts.id, {
      onDelete: "cascade",
    }),
    commentId: integer("comment_id").references(() => comments.id, {
      onDelete: "cascade",
    }),
    // Defaults to the original binary "like" emoji so a row inserted without
    // specifying one (shouldn't happen post-migration, but keeps the column
    // additive/backward-compatible per the expand-contract note in CLAUDE.md)
    // still lands on a sensible value rather than NULL.
    emoji: text("emoji").notNull().default("👍"),
    createdAt: timestamp("created_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // A user can react to a given post / comment with a given emoji at most
    // once. These are backed by composite btrees whose leading `userId` also
    // serves the "which of these did I react to, and with what?" lookups
    // when rendering a page.
    unique("likes_user_post_emoji_unique").on(
      table.userId,
      table.postId,
      table.emoji,
    ),
    unique("likes_user_comment_emoji_unique").on(
      table.userId,
      table.commentId,
      table.emoji,
    ),
    // Grouped COUNT(*) per (target, emoji) filters by postId/commentId; index
    // them so that stays cheap and the cascade deletes don't scan.
    index("likes_post_id_idx").on(table.postId),
    index("likes_comment_id_idx").on(table.commentId),
    // Exactly one target column is set — never both, never neither.
    check(
      "likes_exactly_one_target",
      sql`(${table.postId} IS NOT NULL AND ${table.commentId} IS NULL) OR (${table.postId} IS NULL AND ${table.commentId} IS NOT NULL)`,
    ),
  ],
);

export type DbLike = typeof likes.$inferSelect;
export type NewDbLike = typeof likes.$inferInsert;

export const chats = pgTable("chats", {
  id: serial("id").primaryKey(),
  type: text("type", { enum: ["direct", "group"] }).notNull(),
  // Only set (and editable) for group chats — a direct chat's "name" is
  // always derived client-side from the other participant.
  title: text("title"),
  // Nullable + set null (not cascade): if the creator's account is ever
  // deleted, the chat and everyone else's messages should survive — it just
  // becomes un-renameable/un-manageable rather than vanishing for every
  // other participant.
  createdBy: integer("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Bumped whenever a message is sent, so the chat list can sort by recent
  // activity with a plain ORDER BY instead of a per-row message subquery.
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Monotonically incremented on every participant-visible change to this
  // chat (message sent/edited/deleted, read receipts advancing, rename,
  // participants added) — see `bumpChatVersion` in ChatsHandler.ts. Carried
  // on the `chat_updated` realtime event and in the `Chat` API response so
  // clients can tell exactly when they've missed an event (the version they
  // observe jumps by more than one) instead of only being able to guess from
  // a dropped/delayed socket message (issue #55).
  version: integer("version").notNull().default(1),
});

export type DbChat = typeof chats.$inferSelect;
export type NewDbChat = typeof chats.$inferInsert;

export const chatParticipants = pgTable(
  "chat_participants",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    // Per-chat role (issue #220) — distinct from `users.role` (site-wide
    // admin). Only meaningful for group chats: the creator is seeded as
    // "owner" at creation, added participants default to "member", and
    // "admin" is granted by the owner via `updateParticipantRole`. Direct
    // chats leave every participant at the "member" default since there's
    // nothing to manage. Kept in sync with `chats.createdBy` at every point
    // that reassigns ownership (transferOwnership, and the automatic
    // reassignment in `departParticipant` — see ChatsHandler.ts) so exactly
    // one participant holds "owner" whenever the chat has a non-null
    // `createdBy`.
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
  },
  (table) => [
    unique().on(table.chatId, table.userId),
    // The unique constraint above is backed by a (chatId, userId) btree, so
    // it only serves chatId-first lookups. `listChats` joins on userId
    // directly (every participant row for a given user), which needs its
    // own leading index rather than scanning the chatId-first one.
    index("chat_participants_user_id_idx").on(table.userId),
  ],
);

export type DbChatParticipant = typeof chatParticipants.$inferSelect;
export type NewDbChatParticipant = typeof chatParticipants.$inferInsert;

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    senderId: integer("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contentType: text("content_type", {
      enum: ["text", "image_url", "attachment"],
    }).notNull(),
    content: text("content").notNull(),
    // Mirrors `posts.attachmentId` — set only when contentType is
    // "attachment".
    attachmentId: integer("attachment_id").references(() => attachments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // `listMessages` filters + orders by (chatId, id) for every page fetch,
    // and `createMessage`/`markRead` etc. all look up by chatId too —
    // Postgres doesn't auto-index foreign key columns, so without this every
    // one of those becomes a sequential scan as the table grows.
    index("messages_chat_id_idx").on(table.chatId, table.id),
    // `getUnreadCount`/`getUnreadCountsForChats` filter on
    // `ne(senderId, userId)` alongside the chatId filter above — a
    // dedicated index lets Postgres use a bitmap AND of both instead of
    // falling back to a filter scan over every chatId match.
    index("messages_sender_id_idx").on(table.senderId),
    // Same rationale as `posts_attachment_id_idx` above.
    index("messages_attachment_id_idx").on(table.attachmentId),
  ],
);

export type DbMessage = typeof messages.$inferSelect;
export type NewDbMessage = typeof messages.$inferInsert;

// One row per (message, reader) — the read state of a message is tracked
// per user rather than as a single "read" flag, so group chats can later
// show "read by N of M" without a schema change.
export const messageReads = pgTable(
  "message_reads",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // The unique constraint below is backed by a composite (messageId,
  // userId) btree index, whose leading column already serves `listMessages`'
  // `inArray(messageReads.messageId, ...)` lookups — no separate index
  // needed on messageId alone.
  (table) => [unique().on(table.messageId, table.userId)],
);

export type DbMessageRead = typeof messageReads.$inferSelect;
export type NewDbMessageRead = typeof messageReads.$inferInsert;

// Invite links/codes (issue #220) that let a user join a group chat without
// being added directly by an owner/admin. `code` is the opaque, unguessable
// token carried in the invite URL — looked up directly (see
// `chat_invites_code_idx`) rather than via `chatId`, since redeeming a link
// only ever has the code on hand. An invite is valid to redeem while
// `revokedAt` is null, `expiresAt` is null or in the future, and (if
// `maxUses` is set) `useCount < maxUses` — all enforced in the application
// layer at redemption time (see ChatsHandler.ts), not by constraints here.
export const chatInvites = pgTable(
  "chat_invites",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    // Null means "never expires".
    expiresAt: timestamp("expires_at", { mode: "date" }),
    // Null means "unlimited uses".
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    // Null while still active; set (rather than deleting the row) when an
    // owner/admin revokes the invite, so revoked links leave an audit trail
    // instead of silently vanishing.
    revokedAt: timestamp("revoked_at", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("chat_invites_code_idx").on(table.code),
    // `listChatInvites` filters by chatId; Postgres doesn't auto-index FK
    // columns, so without this every list (and the cascade delete from
    // `chats`) scans the whole table.
    index("chat_invites_chat_id_idx").on(table.chatId),
  ],
);

export type DbChatInvite = typeof chatInvites.$inferSelect;
export type NewDbChatInvite = typeof chatInvites.$inferInsert;
