import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { MUTED_FOREVER_MS } from "../Api.ts";
import { Db } from "../Db.ts";
import { chatParticipants } from "../db/schema.ts";
import { makeTestRun } from "../testApi.ts";
import { registerAndLogin } from "./testKit.ts";

// Muting, archiving and pinning a chat (issue #900).

const run = makeTestRun();

type Account = Effect.Success<ReturnType<typeof registerAndLogin>>;

const send = (from: Account, chatId: number, content = "hi") =>
  from.client.chats.createMessage({
    params: { id: chatId },
    payload: { contentType: "text", content },
  });

const aliceAndBob = Effect.gen(function* () {
  const alice = yield* registerAndLogin("alice", "pw-testpass");
  const bob = yield* registerAndLogin("bob", "pw-testpass");
  const chat = yield* alice.client.chats.createDirectChat({
    payload: { userId: bob.user.id },
  });
  const prefs = (payload: {
    mute?: "8h" | "1w" | "always" | null;
    archived?: boolean;
    pinned?: boolean;
  }) =>
    alice.client.chats.updateChatPreferences({
      params: { id: chat.id },
      payload,
    });
  const listed = (query: { archived?: "true"; unread?: "true" } = {}) =>
    alice.client.chats
      .listChats({ query })
      .pipe(Effect.map((page) => page.chats.map((c) => c.id)));
  return { alice, bob, chat, prefs, listed };
});

test("a muted chat keeps its own unread count but leaves the total, for the muter only", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, chat, prefs, listed } = yield* aliceAndBob;
      expect(chat).toMatchObject({
        mutedUntil: null,
        archived: false,
        pinned: false,
      });
      yield* send(bob, chat.id);

      const before = Date.now();
      const muted = yield* prefs({ mute: "8h" });
      expect(muted.unreadCount).toBe(1);
      expect(muted.mutedUntil! - before).toBeGreaterThanOrEqual(8 * 3_600_000);
      expect(muted.mutedUntil! - before).toBeLessThan(8 * 3_600_000 + 60_000);
      expect(yield* alice.client.chats.getUnreadChatCount()).toEqual({
        count: 0,
        chats: 0,
      });
      expect(yield* listed({ unread: "true" })).toEqual([chat.id]);
      const bobView = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(bobView.mutedUntil).toBeNull();

      expect((yield* prefs({ mute: "always" })).mutedUntil).toBe(
        MUTED_FOREVER_MS,
      );
      expect((yield* prefs({ mute: null })).mutedUntil).toBeNull();
      expect((yield* alice.client.chats.getUnreadChatCount()).count).toBe(1);
    }),
  ));

test("a mute that has run out counts as none", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, chat, prefs } = yield* aliceAndBob;
      yield* send(bob, chat.id);
      yield* prefs({ mute: "1w" });
      const db = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(chatParticipants)
          .set({ mutedUntil: new Date(Date.now() - 1000) })
          .where(
            and(
              eq(chatParticipants.chatId, chat.id),
              eq(chatParticipants.userId, alice.user.id),
            ),
          ),
      );
      const view = yield* alice.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(view.mutedUntil).toBeNull();
      expect((yield* alice.client.chats.getUnreadChatCount()).count).toBe(1);
    }),
  ));

test("an archived chat is its own list and out of the total until a new message", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, chat, prefs, listed } = yield* aliceAndBob;
      yield* send(bob, chat.id);

      expect((yield* prefs({ archived: true })).archived).toBe(true);
      expect(yield* listed()).toEqual([]);
      expect(yield* listed({ unread: "true" })).toEqual([]);
      expect(yield* listed({ archived: "true" })).toEqual([chat.id]);
      expect((yield* alice.client.chats.getUnreadChatCount()).count).toBe(0);
      // Bob's list is his own.
      const bobList = yield* bob.client.chats.listChats({ query: {} });
      expect(bobList.chats[0]).toMatchObject({ id: chat.id, archived: false });

      yield* send(bob, chat.id, "still there?");
      expect(yield* listed()).toEqual([chat.id]);
      expect(yield* listed({ archived: "true" })).toEqual([]);
      expect((yield* alice.client.chats.getUnreadChatCount()).count).toBe(2);

      yield* prefs({ archived: true });
      expect((yield* prefs({ archived: false })).archived).toBe(false);
      expect(yield* listed()).toEqual([chat.id]);
    }),
  ));

test("reading an archived chat leaves it archived", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, chat, prefs } = yield* aliceAndBob;
      const message = yield* send(bob, chat.id);
      yield* prefs({ archived: true });
      const read = yield* alice.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: message.id },
      });
      expect(read).toMatchObject({ archived: true, unreadCount: 0 });
    }),
  ));

test("pinning and archiving undo each other", () =>
  run(
    Effect.gen(function* () {
      const { prefs } = yield* aliceAndBob;
      yield* prefs({ archived: true });
      expect(yield* prefs({ pinned: true })).toMatchObject({
        archived: false,
        pinned: true,
      });
      expect(yield* prefs({ archived: true })).toMatchObject({
        archived: true,
        pinned: false,
      });
      expect(yield* prefs({ archived: true, pinned: true })).toMatchObject({
        archived: true,
        pinned: false,
      });
      // An empty update changes nothing.
      expect((yield* prefs({})).archived).toBe(true);
    }),
  ));

test("pinned chats come first, across pages", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const ids: number[] = [];
      for (const name of ["bob", "carol", "dave", "erin", "frank"]) {
        const other = yield* registerAndLogin(name, "pw-testpass");
        const chat = yield* alice.client.chats.createDirectChat({
          payload: { userId: other.user.id },
        });
        yield* send(alice, chat.id);
        ids.push(chat.id);
      }
      const [bob, carol, dave, erin, frank] = ids;
      // Pin order doesn't matter: pinned chats sort by activity too.
      for (const id of [carol!, bob!, dave!])
        yield* alice.client.chats.updateChatPreferences({
          params: { id },
          payload: { pinned: true },
        });

      // Pages of two, so one cursor lands on a pinned row and the next on
      // an unpinned one.
      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* alice.client.chats.listChats({
          query: { limit: 2, ...(cursor ? { cursor } : {}) },
        });
        seen.push(...page.chats.map((c) => c.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual([dave!, carol!, bob!, frank!, erin!]);
    }),
  ));

test("preferences need an accepted participant", () =>
  run(
    Effect.gen(function* () {
      const { chat } = yield* aliceAndBob;
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const outsider = yield* carol.client.chats
        .updateChatPreferences({
          params: { id: chat.id },
          payload: { pinned: true },
        })
        .pipe(Effect.flip);
      expect(outsider._tag).toBe("Forbidden");

      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const request = yield* carol.client.chats.createGroupChat({
        payload: { title: "hello", participantIds: [dave.user.id] },
      });
      const pending = yield* dave.client.chats
        .updateChatPreferences({
          params: { id: request.id },
          payload: { archived: true },
        })
        .pipe(Effect.flip);
      expect(pending._tag).toBe("Forbidden");
    }),
  ));
