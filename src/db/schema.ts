import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["user", "admin"] })
    .notNull()
    .default("user"),
});

export type DbUser = typeof users.$inferSelect;
export type NewDbUser = typeof users.$inferInsert;

// One row per issued (and not-yet-rotated/revoked) refresh token, keyed on
// its JWT `jti` claim. `POST /users/refresh` looks up the presented token's
// jti here and rejects anything not found, so a refresh token stops working
// the moment its row is deleted — on rotation (replaced by the new token's
// row) or, later, on explicit logout/revocation.
export const refreshTokens = pgTable("refresh_tokens", {
  jti: text("jti").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type DbRefreshToken = typeof refreshTokens.$inferSelect;
export type NewDbRefreshToken = typeof refreshTokens.$inferInsert;

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  contentType: text("content_type", { enum: ["text", "image_url"] }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type DbPost = typeof posts.$inferSelect;
export type NewDbPost = typeof posts.$inferInsert;

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
  },
  (table) => [unique().on(table.chatId, table.userId)],
);

export type DbChatParticipant = typeof chatParticipants.$inferSelect;
export type NewDbChatParticipant = typeof chatParticipants.$inferInsert;

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  chatId: integer("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  senderId: integer("sender_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  contentType: text("content_type", { enum: ["text", "image_url"] }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
});

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
  (table) => [unique().on(table.messageId, table.userId)],
);

export type DbMessageRead = typeof messageReads.$inferSelect;
export type NewDbMessageRead = typeof messageReads.$inferInsert;
