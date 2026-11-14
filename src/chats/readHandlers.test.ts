import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../Db.ts";
import { messageReads } from "../db/schema.ts";
import { makeTestRun } from "../testApi.ts";
import {
  buryUnreadDirectChat,
  medianMs,
  registerAndLogin,
  seedMessages,
} from "./testKit.ts";

const run = makeTestRun();

test("markRead marks messages up to a point as read and updates unreadCount + readByUserIds", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const m1 = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "one" },
      });
      const m2 = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "two" },
      });
      yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "three" },
      });

      const {
        chats: [bobChatBefore],
      } = yield* bob.client.chats.listChats({ query: {} });
      expect(bobChatBefore!.unreadCount).toBe(3);

      const afterRead = yield* bob.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: m2.id },
      });
      expect(afterRead.unreadCount).toBe(1);

      const page = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      const firstMessage = page.messages.find((m) => m.id === m1.id);
      expect(firstMessage?.readByUserIds).toEqual([bob.user.id]);
      const thirdMessage = page.messages.find(
        (m) => m.id !== m1.id && m.id !== m2.id,
      );
      expect(thirdMessage?.readByUserIds).toEqual([]);
    }),
  ));

test(
  "listChats doesn't slow down with already-read history, and markRead copes with a 50k-message chat (issues #659, #648)",
  () =>
    run(
      Effect.gen(function* () {
        const alice = yield* registerAndLogin("alice", "pw-testpass");
        const bob = yield* registerAndLogin("bob", "pw-testpass");
        // Carol's chat with Bob is the baseline: the same shape as Alice's
        // (one chat, a read last message to hydrate) without the history.
        const carol = yield* registerAndLogin("carol", "pw-testpass");
        const chat = yield* alice.client.chats.createDirectChat({
          payload: { userId: bob.user.id },
        });
        const baselineChat = yield* carol.client.chats.createDirectChat({
          payload: { userId: bob.user.id },
        });

        const sendAndRead = (
          reader: typeof alice,
          chatId: number,
          content: string,
        ) =>
          Effect.gen(function* () {
            const message = yield* bob.client.chats.createMessage({
              params: { id: chatId },
              payload: { contentType: "text", content },
            });
            return yield* reader.client.chats.markRead({
              params: { id: chatId },
              payload: { messageId: message.id },
            });
          });

        yield* sendAndRead(carol, baselineChat.id, "the only one");
        yield* seedMessages(chat.id, bob.user.id, 50_000);
        // Past the ~21.8k messages that used to blow the bind-parameter limit.
        const read = yield* sendAndRead(alice, chat.id, "the newest one");
        expect(read.unreadCount).toBe(0);
        expect(read.lastMessage?.readByUserIds).toEqual([alice.user.id]);

        // Warm up, then sample the two lists alternately and compare medians,
        // so one GC pause can't fail the test and both see the same load from
        // the rest of the (parallel) suite — sampled minutes apart, a busy
        // moment on one side read as a slowdown (issue #811).
        yield* carol.client.chats.listChats({ query: {} });
        yield* alice.client.chats.listChats({ query: {} });
        const baselineSamples: number[] = [];
        const historySamples: number[] = [];
        for (let i = 0; i < 7; i++) {
          let startedAt = performance.now();
          yield* carol.client.chats.listChats({ query: {} });
          baselineSamples.push(performance.now() - startedAt);
          startedAt = performance.now();
          yield* alice.client.chats.listChats({ query: {} });
          historySamples.push(performance.now() - startedAt);
        }
        const baseline = medianMs(baselineSamples);
        const withHistory = medianMs(historySamples);
        // Within ~2× of the baseline; the couple of ms of slack only absorbs
        // timer noise at these ms scales — anti-joining the whole history
        // again costs tens of ms.
        expect(withHistory).toBeLessThan(Math.max(2 * baseline, baseline + 2));
      }),
    ),
  // Seeding and reading a 50k-message chat is heavy work by design; under
  // CI's parallel, coverage-instrumented run it can pass the suite-wide 15s
  // on CPU alone. What it guards is the timing ratio checked above, not this.
  60_000,
);

test("markRead only moves the read watermark forward, and a repeat with nothing new is a no-op", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Crew",
          participantIds: [bob.user.id, carol.user.id],
        },
      });
      // A message request sends no receipts (issue #808), so accept it.
      for (const member of [bob, carol])
        yield* member.client.chats.acceptChatRequest({
          params: { id: chat.id },
        });
      const send = (content: string) =>
        alice.client.chats.createMessage({
          params: { id: chat.id },
          payload: { contentType: "text", content },
        });
      const m1 = yield* send("one");
      const m2 = yield* send("two");
      const m3 = yield* send("three");

      const read = yield* bob.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: m3.id },
      });
      expect(read.unreadCount).toBe(0);

      // Re-reading the newest message, or an older one, changes nothing:
      // no version bump (so no `chat_updated`), and nothing becomes unread.
      const repeat = yield* bob.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: m3.id },
      });
      expect(repeat.version).toBe(read.version);
      const older = yield* bob.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: m1.id },
      });
      expect(older.version).toBe(read.version);
      expect(older.unreadCount).toBe(0);

      yield* carol.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: m2.id },
      });
      const page = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      const readers = new Map(
        page.messages.map((m) => [m.id, m.readByUserIds]),
      );
      const bothReaders = [bob.user.id, carol.user.id].sort((a, b) => a - b);
      expect(readers.get(m1.id)).toEqual(bothReaders);
      expect(readers.get(m2.id)).toEqual(bothReaders);
      expect(readers.get(m3.id)).toEqual([bob.user.id]);

      // Expand phase: the previous release still reads receipts from
      // `message_reads`, so markRead keeps writing exactly the newly read rows.
      const db = yield* Db;
      const rows = yield* Effect.tryPromise(() =>
        db
          .select({ messageId: messageReads.messageId })
          .from(messageReads)
          .where(eq(messageReads.userId, carol.user.id)),
      ).pipe(Effect.orDie);
      expect(rows.map((r) => r.messageId).sort((a, b) => a - b)).toEqual([
        m1.id,
        m2.id,
      ]);
    }),
  ));

test("migration 0035 back-fills each participant's read watermark from message_reads", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const m1 = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "one" },
      });
      const m2 = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "two" },
      });
      yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "three" },
      });

      // The state a pre-0035 database is in: read rows, no watermark.
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.insert(messageReads).values([
          { messageId: m1.id, userId: bob.user.id },
          { messageId: m2.id, userId: bob.user.id },
        ]),
      ).pipe(Effect.orDie);
      const before = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(before.unreadCount).toBe(3);

      const migration = yield* Effect.promise(() =>
        Bun.file(
          new URL("../../drizzle/0035_read_watermark.sql", import.meta.url),
        ).text(),
      );
      const backfill = migration.split("--> statement-breakpoint")[1]!;
      yield* Effect.tryPromise(() => db.execute(sql.raw(backfill))).pipe(
        Effect.orDie,
      );

      const after = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(after.unreadCount).toBe(1);
      const aliceView = yield* alice.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(aliceView.unreadCount).toBe(0);
    }),
  ));

// Issue #686: the read watermark lives on the participant row, so leaving
// or being removed used to take it with it, and a rejoin counted the whole
// history as unread. A joiner now starts at the chat's newest message.
test("rejoining a group keeps its history read, and only later messages count as unread", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      // Strangers' groups start as message requests (issue #785).
      yield* bob.client.chats.acceptChatRequest({ params: { id: chat.id } });
      let last = 0;
      for (let i = 0; i < 5; i++)
        last = (yield* alice.client.chats.createMessage({
          params: { id: chat.id },
          payload: { contentType: "text", content: `m${i}` },
        })).id;
      const read = yield* bob.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: last },
      });
      expect(read.unreadCount).toBe(0);

      yield* alice.client.chats.removeParticipant({
        params: { id: chat.id, userId: bob.user.id },
      });
      yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: [bob.user.id] },
      });
      // No other chat with Alice now, so it's a request again.
      yield* bob.client.chats.acceptChatRequest({ params: { id: chat.id } });
      const rejoined = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(rejoined.unreadCount).toBe(0);

      yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "after rejoin" },
      });
      const after = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(after.unreadCount).toBe(1);
    }),
  ));

test("joining a group with history, by invite or by being added, starts with nothing unread", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      yield* bob.client.chats.acceptChatRequest({ params: { id: chat.id } });
      for (let i = 0; i < 3; i++)
        yield* alice.client.chats.createMessage({
          params: { id: chat.id },
          payload: { contentType: "text", content: `m${i}` },
        });

      // Bob leaves on his own and comes back through an invite.
      yield* bob.client.chats.leaveChat({ params: { id: chat.id } });
      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      const joined = yield* bob.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
      expect(joined.unreadCount).toBe(0);

      // Carol is brand new to the group.
      const added = yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: [carol.user.id] },
      });
      expect(added.participants.map((p) => p.userId)).toContain(carol.user.id);
      yield* carol.client.chats.acceptChatRequest({ params: { id: chat.id } });
      const carolView = yield* carol.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(carolView.unreadCount).toBe(0);
      // Starting with nothing unread isn't a read receipt for the backlog.
      const backlog = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      for (const m of backlog.messages) expect(m.readByUserIds).toEqual([]);

      yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "welcome" },
      });
      for (const member of [bob, carol]) {
        const view = yield* member.client.chats.getChat({
          params: { id: chat.id },
        });
        expect(view.unreadCount).toBe(1);
      }
    }),
  ));

test("markRead 404s for a missing chat or a message from a different chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      const chatAB = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const messageInAB = yield* alice.client.chats.createMessage({
        params: { id: chatAB.id },
        payload: { contentType: "text", content: "hi bob" },
      });

      const missingChat = yield* alice.client.chats
        .markRead({
          params: { id: 9999 },
          payload: { messageId: messageInAB.id },
        })
        .pipe(Effect.flip);
      expect(missingChat._tag).toBe("NotFound");

      const chatAC = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const messageInAC = yield* alice.client.chats.createMessage({
        params: { id: chatAC.id },
        payload: { contentType: "text", content: "hi carol" },
      });

      // messageInAC exists, but not in chatAB.
      const wrongChat = yield* bob.client.chats
        .markRead({
          params: { id: chatAB.id },
          payload: { messageId: messageInAC.id },
        })
        .pipe(Effect.flip);
      expect(wrongChat._tag).toBe("NotFound");
    }),
  ));

test("getUnreadChatCount counts unread chats beyond the first page of the list", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, dm } = yield* buryUnreadDirectChat;

      // The precondition the bug needs: page 1 alone sums to nothing.
      const firstPage = yield* alice.client.chats.listChats({ query: {} });
      expect(firstPage.chats.some((c) => c.id === dm.id)).toBe(false);
      expect(firstPage.chats.every((c) => c.unreadCount === 0)).toBe(true);

      expect(yield* alice.client.chats.getUnreadChatCount()).toEqual({
        count: 3,
        chats: 1,
      });
      // Your own messages are never unread to you.
      expect(yield* bob.client.chats.getUnreadChatCount()).toEqual({
        count: 0,
        chats: 0,
      });

      // Reading part of it lowers the total; reading all of it clears it.
      const dmPage = yield* alice.client.chats.listMessages({
        params: { id: dm.id },
        query: {},
      });
      const [first, , last] = dmPage.messages;
      yield* alice.client.chats.markRead({
        params: { id: dm.id },
        payload: { messageId: first!.id },
      });
      expect(yield* alice.client.chats.getUnreadChatCount()).toEqual({
        count: 2,
        chats: 1,
      });
      yield* alice.client.chats.markRead({
        params: { id: dm.id },
        payload: { messageId: last!.id },
      });
      expect(yield* alice.client.chats.getUnreadChatCount()).toEqual({
        count: 0,
        chats: 0,
      });
    }),
  ));

test("getUnreadChatCount sums across chats and only counts chats you're in", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const withAlice = yield* bob.client.chats.createDirectChat({
        payload: { userId: alice.user.id },
      });
      const group = yield* carol.client.chats.createGroupChat({
        payload: {
          title: "Trio",
          participantIds: [alice.user.id, bob.user.id],
        },
      });
      yield* alice.client.chats.acceptChatRequest({ params: { id: group.id } });
      yield* bob.client.chats.acceptChatRequest({ params: { id: group.id } });
      const withoutAlice = yield* bob.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const sends = [
        [bob.client, withAlice.id],
        [carol.client, group.id],
        [bob.client, group.id],
        [carol.client, withoutAlice.id],
      ] as const;
      for (const [client, id] of sends) {
        yield* client.chats.createMessage({
          params: { id },
          payload: { contentType: "text", content: "hi" },
        });
      }

      expect(yield* alice.client.chats.getUnreadChatCount()).toEqual({
        count: 3,
        chats: 2,
      });
    }),
  ));
