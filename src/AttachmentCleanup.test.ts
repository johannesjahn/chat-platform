import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { cleanupOrphanedAttachments } from "./AttachmentCleanup.ts";
import {
  AttachmentStorage,
  InMemoryAttachmentStorageLive,
} from "./AttachmentStorage.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { attachments, chats, messages, posts, users } from "./db/schema.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";

const { getTestDb } = makeTestDbAccessor();

const run = async <A, E>(
  effect: (db: DrizzleDb) => Effect.Effect<A, E, Db | AttachmentStorage>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
  return Effect.runPromise(
    effect(db).pipe(
      Effect.provide(Layer.succeed(Db, db)),
      Effect.provide(InMemoryAttachmentStorageLive),
    ),
  );
};

const insertUser = (db: DrizzleDb) =>
  Effect.promise(() =>
    db
      .insert(users)
      .values({ username: `user-${crypto.randomUUID()}`, passwordHash: "x" })
      .returning(),
  ).pipe(Effect.map((rows) => rows[0]!));

// createdAt is set explicitly (rather than relying on the column default) so
// tests can place a row on either side of AttachmentCleanup's 24h grace
// period without waiting real time.
const insertAttachment = (
  db: DrizzleDb,
  uploaderId: number,
  storageKey: string,
  createdAt: Date,
) =>
  Effect.promise(() =>
    db
      .insert(attachments)
      .values({
        uploaderId,
        filename: "file.bin",
        mimeType: "audio/mpeg",
        size: 10,
        storageKey,
        createdAt,
      })
      .returning(),
  ).pipe(Effect.map((rows) => rows[0]!));

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 60 * 60 * 1000);

test("cleanupOrphanedAttachments removes an unreferenced attachment past the grace period", () =>
  run((db) =>
    Effect.gen(function* () {
      const user = yield* insertUser(db);
      const row = yield* insertAttachment(
        db,
        user.id,
        "attachments/orphan",
        hoursAgo(25),
      );

      yield* cleanupOrphanedAttachments;

      const remaining = yield* Effect.promise(() =>
        db.select().from(attachments).where(eq(attachments.id, row.id)),
      );
      expect(remaining.length).toBe(0);
    }),
  ));

test("cleanupOrphanedAttachments also deletes the object from storage", () =>
  run((db) =>
    Effect.gen(function* () {
      const storage = yield* AttachmentStorage;
      const user = yield* insertUser(db);
      const row = yield* insertAttachment(
        db,
        user.id,
        "attachments/orphan-storage",
        hoursAgo(25),
      );
      yield* storage.upload(
        row.storageKey,
        new Uint8Array([1, 2, 3]),
        "audio/mpeg",
      );
      expect(storage.presignGetUrl(row.storageKey)).not.toBe("");

      yield* cleanupOrphanedAttachments;

      expect(storage.presignGetUrl(row.storageKey)).toBe("");
    }),
  ));

test("cleanupOrphanedAttachments leaves a recently uploaded, still-unreferenced attachment alone", () =>
  run((db) =>
    Effect.gen(function* () {
      const user = yield* insertUser(db);
      const row = yield* insertAttachment(
        db,
        user.id,
        "attachments/recent",
        hoursAgo(1),
      );

      yield* cleanupOrphanedAttachments;

      const remaining = yield* Effect.promise(() =>
        db.select().from(attachments).where(eq(attachments.id, row.id)),
      );
      expect(remaining.length).toBe(1);
    }),
  ));

test("cleanupOrphanedAttachments leaves an attachment referenced by a message alone", () =>
  run((db) =>
    Effect.gen(function* () {
      const user = yield* insertUser(db);
      const row = yield* insertAttachment(
        db,
        user.id,
        "attachments/msg-ref",
        hoursAgo(48),
      );
      const chatRows = yield* Effect.promise(() =>
        db.insert(chats).values({ type: "direct" }).returning(),
      );
      const chat = chatRows[0]!;
      yield* Effect.promise(() =>
        db.insert(messages).values({
          chatId: chat.id,
          senderId: user.id,
          contentType: "attachment",
          content: "file.bin",
          attachmentId: row.id,
        }),
      );

      yield* cleanupOrphanedAttachments;

      const remaining = yield* Effect.promise(() =>
        db.select().from(attachments).where(eq(attachments.id, row.id)),
      );
      expect(remaining.length).toBe(1);
    }),
  ));

test("cleanupOrphanedAttachments leaves an attachment referenced by a post alone", () =>
  run((db) =>
    Effect.gen(function* () {
      const user = yield* insertUser(db);
      const row = yield* insertAttachment(
        db,
        user.id,
        "attachments/post-ref",
        hoursAgo(48),
      );
      yield* Effect.promise(() =>
        db.insert(posts).values({
          authorId: user.id,
          contentType: "attachment",
          content: "file.bin",
          attachmentId: row.id,
        }),
      );

      yield* cleanupOrphanedAttachments;

      const remaining = yield* Effect.promise(() =>
        db.select().from(attachments).where(eq(attachments.id, row.id)),
      );
      expect(remaining.length).toBe(1);
    }),
  ));
