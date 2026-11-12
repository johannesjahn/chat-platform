// `GET /users/contacts` (issue #764): the caller's own contacts, the only
// people the client may suggest below the directory search's 3-character
// floor (issue #48).
import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { ChatApi, MAX_CONTACTS } from "./Api.ts";
import { Db } from "./Db.ts";
import { chatParticipants, chats, users } from "./db/schema.ts";
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

const contactNames = (member: Member) =>
  member.client.users
    .listContacts()
    .pipe(Effect.map((list) => list.map((u) => u.username)));

// Pins a chat's last activity, so ordering doesn't hinge on two requests
// landing in different milliseconds.
const setActivity = (chatId: number, at: Date) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.promise(() =>
      db.update(chats).set({ updatedAt: at }).where(eq(chats.id, chatId)),
    );
  });

// A group from someone you share no chat with starts as a message request
// (issue #785); these tests are about accepted chats unless they say so.
const acceptAll = (chatId: number, members: Member[]) =>
  Effect.forEach(members, (m) =>
    m.client.chats.acceptChatRequest({ params: { id: chatId } }),
  );

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

test("lists the people you share a chat with, most recent activity first", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const dave = yield* registerAndLogin("dave");
      yield* registerAndLogin("erin"); // shares no chat with alice

      expect(yield* contactNames(alice)).toEqual([]);

      const withBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const group = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Trip",
          participantIds: [carol.user.id, dave.user.id],
        },
      });
      yield* acceptAll(group.id, [carol, dave]);
      // Bob also sits in an older group: he's listed once, at his newest chat.
      const oldGroup = yield* alice.client.chats.createGroupChat({
        payload: { title: "Old", participantIds: [bob.user.id] },
      });
      yield* setActivity(oldGroup.id, minutesAgo(60));
      yield* setActivity(group.id, minutesAgo(30));
      yield* setActivity(withBob.id, minutesAgo(5));

      // Ties (carol and dave share the group) break by newest account.
      expect(yield* contactNames(alice)).toEqual(["bob", "dave", "carol"]);
      // Symmetric, and never yourself.
      expect(yield* contactNames(carol)).toEqual(["dave", "alice"]);

      // A message bumps the chat to the front.
      yield* setActivity(group.id, minutesAgo(1));
      expect(yield* contactNames(alice)).toEqual(["dave", "carol", "bob"]);
    }),
  ));

test("leaves out blocks in either direction, but not mutes", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const dave = yield* registerAndLogin("dave");
      const group = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "All",
          participantIds: [bob.user.id, carol.user.id, dave.user.id],
        },
      });
      yield* acceptAll(group.id, [bob, carol, dave]);

      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });
      yield* carol.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "block" },
      });
      yield* alice.client.users.setBlock({
        params: { id: dave.user.id },
        payload: { type: "mute" },
      });

      expect(yield* contactNames(alice)).toEqual(["dave"]);
      expect(yield* contactNames(bob)).not.toContain("alice");
      expect(yield* contactNames(carol)).not.toContain("alice");
      // A third party's block doesn't touch anyone else's list.
      expect((yield* contactNames(bob)).sort()).toEqual(["carol", "dave"]);

      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      expect((yield* contactNames(alice)).sort()).toEqual(["bob", "dave"]);
    }),
  ));

test("a pending message request introduces nobody, on either side", () =>
  run(
    Effect.gen(function* () {
      const spammer = yield* registerAndLogin("spammer");
      const accomplice = yield* registerAndLogin("accomplice");
      const alice = yield* registerAndLogin("alice");
      // The accomplice is the spammer's contact; alice shares no chat with
      // the spammer, so the group is a request for her (issue #785).
      yield* spammer.client.chats.createDirectChat({
        payload: { userId: accomplice.user.id },
      });
      const group = yield* spammer.client.chats.createGroupChat({
        payload: {
          title: "Deals",
          participantIds: [accomplice.user.id, alice.user.id],
        },
      });
      const aliceView = yield* alice.client.chats.getChat({
        params: { id: group.id },
      });
      expect(aliceView.messageRequest).not.toBeNull();

      // Neither the sender nor anyone else in the request reaches her list,
      expect(yield* contactNames(alice)).toEqual([]);
      // nor does she reach theirs while it's pending.
      expect(yield* contactNames(spammer)).toEqual(["accomplice"]);
      expect(yield* contactNames(accomplice)).toEqual(["spammer"]);

      yield* alice.client.chats.acceptChatRequest({ params: { id: group.id } });
      expect((yield* contactNames(alice)).sort()).toEqual([
        "accomplice",
        "spammer",
      ]);
      expect((yield* contactNames(spammer)).sort()).toEqual([
        "accomplice",
        "alice",
      ]);
    }),
  ));

test("someone in both a pending request and an accepted chat is a contact", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const stranger = yield* registerAndLogin("stranger");
      yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      // Bob shares a chat with the stranger; alice doesn't, so the
      // stranger's group is a request for her.
      yield* stranger.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* stranger.client.chats.createGroupChat({
        payload: { title: "Hi", participantIds: [bob.user.id, alice.user.id] },
      });
      expect(yield* contactNames(alice)).toEqual(["bob"]);
    }),
  ));

test(`returns at most ${MAX_CONTACTS} contacts, the most recent ones`, () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const db = yield* Db;
      // Seeded directly: registering this many accounts through the API
      // would spend most of the test on password hashing.
      const total = MAX_CONTACTS + 5;
      const seeded = yield* Effect.promise(() =>
        db
          .insert(users)
          .values(
            Array.from({ length: total }, (_, i) => ({
              username: `friend${String(i).padStart(2, "0")}`,
              passwordHash: "unused",
            })),
          )
          .returning({ id: users.id, username: users.username }),
      );
      for (const [i, friend] of seeded.entries()) {
        const [chat] = yield* Effect.promise(() =>
          db
            .insert(chats)
            .values({
              type: "direct",
              createdBy: alice.user.id,
              // friend00 is the oldest chat, the last one the newest.
              updatedAt: minutesAgo(total - i),
            })
            .returning({ id: chats.id }),
        );
        yield* Effect.promise(() =>
          db.insert(chatParticipants).values([
            { chatId: chat!.id, userId: alice.user.id },
            { chatId: chat!.id, userId: friend.id },
          ]),
        );
      }

      const names = yield* contactNames(alice);
      expect(names).toHaveLength(MAX_CONTACTS);
      expect(names[0]).toBe(seeded[total - 1]!.username);
      // The five oldest are the ones cut.
      expect(names).not.toContain("friend00");
      expect(names).not.toContain("friend04");
      expect(names).toContain("friend05");
    }),
  ));

test("requires authentication", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users.listContacts().pipe(Effect.flip);
      expect(result).toBeDefined();
    }),
  ));
