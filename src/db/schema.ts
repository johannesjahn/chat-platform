import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["user", "admin"] })
    .notNull()
    .default("user"),
});

export type DbUser = typeof users.$inferSelect;
export type NewDbUser = typeof users.$inferInsert;

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  contentType: text("content_type", { enum: ["text", "image_url"] }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type DbPost = typeof posts.$inferSelect;
export type NewDbPost = typeof posts.$inferInsert;

export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Bumped whenever a message is sent, so the chat list can sort by recent
  // activity with a plain ORDER BY instead of a per-row message subquery.
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type DbChat = typeof chats.$inferSelect;
export type NewDbChat = typeof chats.$inferInsert;

export const chatParticipants = sqliteTable(
  "chat_participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [unique().on(table.chatId, table.userId)],
);

export type DbChatParticipant = typeof chatParticipants.$inferSelect;
export type NewDbChatParticipant = typeof chatParticipants.$inferInsert;

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  senderId: integer("sender_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  contentType: text("content_type", { enum: ["text", "image_url"] }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type DbMessage = typeof messages.$inferSelect;
export type NewDbMessage = typeof messages.$inferInsert;

// One row per (message, reader) — the read state of a message is tracked
// per user rather than as a single "read" flag, so group chats can later
// show "read by N of M" without a schema change.
export const messageReads = sqliteTable(
  "message_reads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: integer("read_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [unique().on(table.messageId, table.userId)],
);

export type DbMessageRead = typeof messageReads.$inferSelect;
export type NewDbMessageRead = typeof messageReads.$inferInsert;
