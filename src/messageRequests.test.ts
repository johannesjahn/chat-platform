// Message requests (issue #785): a group created by, or an add made by,
// someone the recipient shares no chat with waits for their consent.
import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { Db } from "./Db.ts";
import { users } from "./db/schema.ts";
import { makeTestRun } from "./testApi.ts";

const run = makeTestRun();

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

const registerAndLogin = (username: string) =>
  Effect.gen(function* () {
    const password = "pw-testpass";
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    const client = yield* HttpApiClient.make(ChatApi, {
      baseUrl: "http://localhost",
      transformClient: (inner) =>
        HttpClient.mapRequest(
          inner,
          HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        ),
    });
    return { user, client };
  });

type Member = Effect.Success<ReturnType<typeof registerAndLogin>>;

const say = (from: Member, chatId: number, content: string) =>
  from.client.chats.createMessage({
    params: { id: chatId },
    payload: { contentType: "text", content },
  });

const listIds = (member: Member, requests: boolean) =>
  member.client.chats
    .listChats({ query: { requests: requests ? "true" : "false" } })
    .pipe(Effect.map((page) => page.chats.map((c) => c.id)));

test("a stranger's group is a request: out of the list, no unread, no notification", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("spammer");
      const alice = yield* registerAndLogin("alice");
      const group = yield* spammer.client.chats.createGroupChat({
        payload: { title: "Deals", participantIds: [alice.user.id] },
      });
      // The creator's own view isn't a request.
      expect(group.messageRequest).toBeNull();
      yield* say(spammer, group.id, "buy now");
      yield* say(spammer, group.id, "@alice buy now");

      expect(yield* listIds(alice, false)).toEqual([]);
      const requests = yield* alice.client.chats.listChats({
        query: { requests: "true" },
      });
      expect(requests.chats.map((c) => c.id)).toEqual([group.id]);
      expect(requests.chats[0]!.messageRequest).toEqual({
        addedBy: spammer.user.id,
      });
      expect(requests.chats[0]!.unreadCount).toBe(0);

      const view = yield* alice.client.chats.getChat({
        params: { id: group.id },
      });
      expect(view.unreadCount).toBe(0);
      expect(view.messageRequest).toEqual({ addedBy: spammer.user.id });
      expect(yield* alice.client.chats.getUnreadChatCount()).toEqual({
        count: 0,
        chats: 0,
      });
      expect(
        yield* alice.client.chats.listChats({ query: { unread: "true" } }),
      ).toMatchObject({ chats: [] });
      expect(
        yield* alice.client.notifications.getUnreadNotificationCount(),
      ).toEqual({ count: 0 });
    }),
  ));

test("accepting a request moves it into the list and starts counting unread", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("stranger");
      const alice = yield* registerAndLogin("alice");
      const group = yield* spammer.client.chats.createGroupChat({
        payload: { title: "Hello", participantIds: [alice.user.id] },
      });
      yield* say(spammer, group.id, "hi there");

      const accepted = yield* alice.client.chats.acceptChatRequest({
        params: { id: group.id },
      });
      expect(accepted.messageRequest).toBeNull();
      // What arrived while it was a request is there to read now.
      expect(accepted.unreadCount).toBe(1);
      expect(accepted.version).toBeGreaterThan(group.version);
      expect(yield* listIds(alice, false)).toEqual([group.id]);
      expect(yield* listIds(alice, true)).toEqual([]);

      // Accepting twice is a no-op.
      const again = yield* alice.client.chats.acceptChatRequest({
        params: { id: group.id },
      });
      expect(again.version).toBe(accepted.version);

      yield* say(spammer, group.id, "again");
      expect(yield* alice.client.chats.getUnreadChatCount()).toEqual({
        count: 2,
        chats: 1,
      });
    }),
  ));

test("declining a request leaves the group, and can be followed by a block", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("spammer");
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const group = yield* spammer.client.chats.createGroupChat({
        payload: {
          title: "Deals",
          participantIds: [alice.user.id, bob.user.id],
        },
      });

      yield* alice.client.chats.leaveChat({ params: { id: group.id } });
      expect(yield* listIds(alice, true)).toEqual([]);
      const after = yield* spammer.client.chats.getChat({
        params: { id: group.id },
      });
      expect(after.participants.map((p) => p.userId)).not.toContain(
        alice.user.id,
      );
      const denied = yield* alice.client.chats
        .getChat({ params: { id: group.id } })
        .pipe(Effect.flip);
      expect(denied._tag).toBe("Forbidden");

      // "Decline and block" is the existing block on `addedBy`, which keeps
      // the spammer from seating Alice in another group.
      yield* alice.client.users.setBlock({
        params: { id: spammer.user.id },
        payload: { type: "block" },
      });
      const retry = yield* spammer.client.chats
        .createGroupChat({
          payload: { title: "Deals 2", participantIds: [alice.user.id] },
        })
        .pipe(Effect.flip);
      expect(retry._tag).toBe("Forbidden");
    }),
  ));

test("someone you already have a chat with skips the request, for a new group or an add", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      yield* bob.client.chats.createDirectChat({
        payload: { userId: alice.user.id },
      });
      yield* carol.client.chats.createDirectChat({
        payload: { userId: alice.user.id },
      });

      const group = yield* alice.client.chats.createGroupChat({
        payload: { title: "Friends", participantIds: [bob.user.id] },
      });
      yield* alice.client.chats.addParticipants({
        params: { id: group.id },
        payload: { participantIds: [carol.user.id] },
      });
      yield* say(alice, group.id, "welcome");
      for (const member of [bob, carol]) {
        const view = yield* member.client.chats.getChat({
          params: { id: group.id },
        });
        expect(view.messageRequest).toBeNull();
        expect(view.unreadCount).toBe(1);
        expect(yield* listIds(member, true)).toEqual([]);
      }

      // Bob and Carol share only the group with each other, which they're
      // both really in — so an add by Bob is no request for Carol either.
      const second = yield* bob.client.chats.createGroupChat({
        payload: { title: "Second", participantIds: [carol.user.id] },
      });
      const carolView = yield* carol.client.chats.getChat({
        params: { id: second.id },
      });
      expect(carolView.messageRequest).toBeNull();
    }),
  ));

test("an add by a stranger is a request, and a pending one vouches for nothing", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("spammer");
      const alice = yield* registerAndLogin("alice");
      const first = yield* spammer.client.chats.createGroupChat({
        payload: { title: "First", participantIds: [alice.user.id] },
      });
      const other = yield* registerAndLogin("other");
      const second = yield* spammer.client.chats.createGroupChat({
        payload: { title: "Second", participantIds: [other.user.id] },
      });
      yield* spammer.client.chats.addParticipants({
        params: { id: second.id },
        payload: { participantIds: [alice.user.id] },
      });
      expect(yield* listIds(alice, true)).toEqual([second.id, first.id]);
      expect(yield* listIds(alice, false)).toEqual([]);
    }),
  ));

test("joining through an invite link is never a request", () =>
  run(
    Effect.gen(function* () {
      const owner = yield* registerAndLogin("owner");
      const alice = yield* registerAndLogin("alice");
      const filler = yield* registerAndLogin("filler");
      const group = yield* owner.client.chats.createGroupChat({
        payload: { title: "Open", participantIds: [filler.user.id] },
      });
      const invite = yield* owner.client.chats.createChatInvite({
        params: { id: group.id },
        payload: {},
      });
      const joined = yield* alice.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
      expect(joined.messageRequest).toBeNull();
      yield* say(owner, group.id, "welcome");
      expect(yield* listIds(alice, false)).toEqual([group.id]);
      expect(yield* listIds(alice, true)).toEqual([]);
      expect(yield* alice.client.chats.getUnreadChatCount()).toEqual({
        count: 1,
        chats: 1,
      });
    }),
  ));

test("when the owner leaves, the group goes to someone who accepted it", () =>
  run(
    Effect.gen(function* () {
      const owner = yield* registerAndLogin("owner");
      const pending = yield* registerAndLogin("pending");
      const friend = yield* registerAndLogin("friend");
      yield* friend.client.chats.createDirectChat({
        payload: { userId: owner.user.id },
      });
      // `pending` joined first, so seniority alone would pick them.
      const group = yield* owner.client.chats.createGroupChat({
        payload: { title: "G", participantIds: [pending.user.id] },
      });
      yield* owner.client.chats.addParticipants({
        params: { id: group.id },
        payload: { participantIds: [friend.user.id] },
      });
      yield* owner.client.chats.leaveChat({ params: { id: group.id } });
      const view = yield* friend.client.chats.getChat({
        params: { id: group.id },
      });
      expect(view.createdBy).toBe(friend.user.id);
    }),
  ));

// Issue #808: a pending request is readable (to decide on it), but stays out
// of search, and nothing the recipient does reaches the others until they
// accept.
const searchHits = (member: Member, q: string) =>
  Effect.gen(function* () {
    const page = yield* member.client.search.searchMessages({ query: { q } });
    const all = yield* member.client.search.searchAll({ query: { q } });
    return {
      messages: page.results.map((r) => r.chatId),
      all: all.messages.results.map((r) => r.chatId),
    };
  });

test("a pending request's messages stay out of every search until it's accepted", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("spammer");
      const alice = yield* registerAndLogin("alice");
      const friend = yield* registerAndLogin("friend");
      const group = yield* spammer.client.chats.createGroupChat({
        payload: { title: "Deals", participantIds: [alice.user.id] },
      });
      yield* say(spammer, group.id, "cheap watches");
      // A chat Alice is really in still matches, so the filter is per chat.
      const direct = yield* friend.client.chats.createDirectChat({
        payload: { userId: alice.user.id },
      });
      yield* say(friend, direct.id, "my watches arrived");

      // A word/prefix hit and a substring-only one: each union arm filters.
      for (const q of ["watch", "atche"])
        expect(yield* searchHits(alice, q)).toEqual({
          messages: [direct.id],
          all: [direct.id],
        });
      // The spammer, who is in it for real, still finds it.
      expect((yield* searchHits(spammer, "watch")).messages).toEqual([
        group.id,
      ]);

      yield* alice.client.chats.acceptChatRequest({ params: { id: group.id } });
      for (const q of ["watch", "atche"])
        expect(yield* searchHits(alice, q)).toEqual({
          messages: [direct.id, group.id],
          all: [direct.id, group.id],
        });
    }),
  ));

const tagOf = <A, E extends { readonly _tag: string }, R>(
  attempt: Effect.Effect<A, E, R>,
) =>
  attempt.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

test("a pending request can't be sent, forwarded, reacted, pinned or typed into", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("spammer");
      const alice = yield* registerAndLogin("alice");
      const friend = yield* registerAndLogin("friend");
      const group = yield* spammer.client.chats.createGroupChat({
        payload: { title: "Deals", participantIds: [alice.user.id] },
      });
      const spam = yield* say(spammer, group.id, "buy now");
      const direct = yield* friend.client.chats.createDirectChat({
        payload: { userId: alice.user.id },
      });
      const note = yield* say(friend, direct.id, "a note");
      const chats = alice.client.chats;
      const onSpam = { id: group.id, messageId: spam.id };

      expect(yield* tagOf(say(alice, group.id, "hello?"))).toBe("Forbidden");
      expect(yield* tagOf(chats.sendTyping({ params: { id: group.id } }))).toBe(
        "Forbidden",
      );
      expect(
        yield* tagOf(
          chats.addMessageReaction({
            params: onSpam,
            payload: { emoji: "👍" },
          }),
        ),
      ).toBe("Forbidden");
      expect(
        yield* tagOf(
          chats.removeMessageReaction({
            params: onSpam,
            payload: { emoji: "👍" },
          }),
        ),
      ).toBe("Forbidden");
      expect(
        yield* tagOf(
          chats.pinMessage({
            params: { id: group.id },
            payload: { messageId: spam.id },
          }),
        ),
      ).toBe("Forbidden");
      expect(yield* tagOf(chats.unpinMessage({ params: onSpam }))).toBe(
        "Forbidden",
      );

      const forwarded = yield* chats.forwardMessage({
        params: { id: direct.id, messageId: note.id },
        payload: { targetChatIds: [group.id, direct.id] },
      });
      expect(
        forwarded.results.map((r) => [r.chatId, r.error?.reason ?? null]),
      ).toEqual([
        [group.id, "unavailable"],
        [direct.id, null],
      ]);

      // Nothing landed: the spammer sees only their own message, with no
      // reaction and no pin.
      const seen = yield* spammer.client.chats.listMessages({
        params: { id: group.id },
        query: {},
      });
      expect(seen.messages.map((m) => m.content)).toEqual(["buy now"]);
      expect(seen.messages[0]!.reactions.every((r) => r.count === 0)).toBe(
        true,
      );
      expect(seen.messages[0]!.pinned).toBe(false);

      // Reading is still allowed — the request is there to be judged.
      const read = yield* chats.listMessages({
        params: { id: group.id },
        query: {},
      });
      expect(read.messages.map((m) => m.id)).toEqual([spam.id]);
      expect(
        yield* chats.listPinnedMessages({ params: { id: group.id } }),
      ).toEqual([]);
      // Starring is a private bookmark that reaches nobody, so it's allowed.
      const starred = yield* chats.starMessage({ params: onSpam });
      expect(starred.starred).toBe(true);
    }),
  ));

test("reading a pending request sends no read receipt", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("spammer");
      const alice = yield* registerAndLogin("alice");
      const group = yield* spammer.client.chats.createGroupChat({
        payload: { title: "Deals", participantIds: [alice.user.id] },
      });
      const spam = yield* say(spammer, group.id, "buy now");
      const readers = () =>
        spammer.client.chats
          .listMessages({ params: { id: group.id }, query: {} })
          .pipe(Effect.map((page) => page.messages[0]!.readByUserIds));

      const marked = yield* alice.client.chats.markRead({
        params: { id: group.id },
        payload: { messageId: spam.id },
      });
      expect(marked.messageRequest).toEqual({ addedBy: spammer.user.id });
      expect(yield* readers()).toEqual([]);

      yield* alice.client.chats.acceptChatRequest({ params: { id: group.id } });
      yield* alice.client.chats.markRead({
        params: { id: group.id },
        payload: { messageId: spam.id },
      });
      expect(yield* readers()).toEqual([alice.user.id]);
    }),
  ));

test("accepting a request lets the recipient send, react, pin and forward into it", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("stranger");
      const alice = yield* registerAndLogin("alice");
      const friend = yield* registerAndLogin("friend");
      const group = yield* spammer.client.chats.createGroupChat({
        payload: { title: "Hello", participantIds: [alice.user.id] },
      });
      const hi = yield* say(spammer, group.id, "hi there");
      const direct = yield* friend.client.chats.createDirectChat({
        payload: { userId: alice.user.id },
      });
      const note = yield* say(friend, direct.id, "a note");

      yield* alice.client.chats.acceptChatRequest({ params: { id: group.id } });
      yield* say(alice, group.id, "hello!");
      yield* alice.client.chats.sendTyping({ params: { id: group.id } });
      yield* alice.client.chats.addMessageReaction({
        params: { id: group.id, messageId: hi.id },
        payload: { emoji: "👍" },
      });
      yield* alice.client.chats.pinMessage({
        params: { id: group.id },
        payload: { messageId: hi.id },
      });
      const forwarded = yield* alice.client.chats.forwardMessage({
        params: { id: direct.id, messageId: note.id },
        payload: { targetChatIds: [group.id] },
      });
      expect(forwarded.results[0]!.error).toBeNull();

      const seen = yield* spammer.client.chats.listMessages({
        params: { id: group.id },
        query: {},
      });
      expect(seen.messages.map((m) => m.content)).toEqual([
        "hi there",
        "hello!",
        "a note",
      ]);
      expect(seen.messages[0]!.pinned).toBe(true);
      expect(
        seen.messages[0]!.reactions.find((r) => r.emoji === "👍")?.count,
      ).toBe(1);
    }),
  ));

test("someone a chat is still a request for can't claim it once it's ownerless", () =>
  run(
    Effect.gen(function* () {
      const owner = yield* registerAndLogin("owner");
      const alice = yield* registerAndLogin("alice");
      const group = yield* owner.client.chats.createGroupChat({
        payload: { title: "G", participantIds: [alice.user.id] },
      });
      // The owner's account going away leaves the group ownerless.
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.delete(users).where(eq(users.id, owner.user.id)),
      ).pipe(Effect.orDie);
      const claim = () =>
        alice.client.chats.transferOwnership({
          params: { id: group.id },
          payload: { userId: alice.user.id },
        });
      expect(yield* tagOf(claim())).toBe("Forbidden");
      yield* alice.client.chats.acceptChatRequest({ params: { id: group.id } });
      expect((yield* claim()).createdBy).toBe(alice.user.id);
    }),
  ));
