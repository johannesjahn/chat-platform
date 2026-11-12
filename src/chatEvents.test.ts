import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { PubSub } from "./PubSub.ts";
import { makeTestRun } from "./testApi.ts";

// Who receives which `chat_updated`, and what it says changed (issue #749).
// A message used to reach every participant as a bare "something changed",
// and so did every read receipt it caused — each of which made every client
// refetch the chat list, the chat and its message window. The events now
// say what changed, so a viewer fetches just the new message and patches a
// receipt in place.

// Every `notifyUsers` envelope published during the current test.
type Envelope = {
  scope: string;
  userIds?: number[];
  event: { type: string; [key: string]: unknown };
};
let published: Envelope[] = [];
const RecordingPubSubLive = Layer.succeed(PubSub, {
  publish: (_channel, message) =>
    Effect.sync(() => {
      published.push(JSON.parse(message) as Envelope);
    }),
  subscribe: () => Effect.void,
  ping: Effect.void,
});

const run = makeTestRun({
  pubSub: RecordingPubSubLive,
  beforeEach: () => {
    published = [];
  },
});

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

// The `chat_updated` events published since `from`, with their recipients.
const chatUpdates = (chatId: number, from = 0) =>
  published
    .slice(from)
    .filter(
      (e) => e.event.type === "chat_updated" && e.event["chatId"] === chatId,
    )
    .map((e): Record<string, unknown> & { to: number[] } => ({
      to: [...(e.userIds ?? [])].sort(),
      ...e.event,
    }));

test("a new message tells every participant who sent which message", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const mark = published.length;
      const message = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hi" },
      });

      expect(chatUpdates(chat.id, mark)).toEqual([
        {
          to: [alice.user.id, bob.user.id].sort(),
          type: "chat_updated",
          chatId: chat.id,
          version: chat.version + 1,
          change: "message_created",
          messageId: message.id,
          senderId: bob.user.id,
        },
      ]);
    }),
  ));

test("a forwarded message is announced in its target chat as a new message", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const carol = yield* registerAndLogin("carol");
      const source = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const target = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: source.id },
        payload: { contentType: "text", content: "pass it on" },
      });

      const mark = published.length;
      const { results } = yield* alice.client.chats.forwardMessage({
        params: { id: source.id, messageId: message.id },
        payload: { targetChatIds: [target.id] },
      });
      const forwarded = results[0]?.message;
      expect(forwarded).toBeTruthy();

      const [event, ...rest] = chatUpdates(target.id, mark);
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        to: [alice.user.id, carol.user.id].sort(),
        change: "message_created",
        senderId: alice.user.id,
      });
      expect(event?.["messageId"]).toBe(forwarded?.id);
    }),
  ));

test("a read receipt is one event naming the reader and the range they read", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const first = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "one" },
      });
      const second = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "two" },
      });

      let mark = published.length;
      const read = yield* alice.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: first.id },
      });
      expect(chatUpdates(chat.id, mark)).toEqual([
        {
          to: [alice.user.id, bob.user.id].sort(),
          type: "chat_updated",
          chatId: chat.id,
          // The same version the reader's own response carries, so the
          // reader's tab recognises the echo as already applied.
          version: read.version,
          change: "read",
          userId: alice.user.id,
          fromMessageId: 0,
          lastReadMessageId: first.id,
        },
      ]);

      // The next read starts where the last one left off.
      mark = published.length;
      yield* alice.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: second.id },
      });
      expect(chatUpdates(chat.id, mark)).toMatchObject([
        {
          change: "read",
          userId: alice.user.id,
          fromMessageId: first.id,
          lastReadMessageId: second.id,
        },
      ]);

      // Nothing newly read, nothing published — a repeat (a second tab, a
      // re-run effect) costs nobody anything.
      mark = published.length;
      yield* alice.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: second.id },
      });
      expect(chatUpdates(chat.id, mark)).toEqual([]);
    }),
  ));

test("one group message read by everyone is one publish per participant, not per pair", () =>
  run(
    Effect.gen(function* () {
      const owner = yield* registerAndLogin("owner");
      const members = [];
      for (const name of [
        "member1",
        "member2",
        "member3",
        "member4",
        "member5",
      ]) {
        members.push(yield* registerAndLogin(name));
      }
      const chat = yield* owner.client.chats.createGroupChat({
        payload: {
          title: "Everyone",
          participantIds: members.map((m) => m.user.id),
        },
      });
      const everyone = [owner, ...members].map((p) => p.user.id).sort();

      const mark = published.length;
      const message = yield* owner.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hello all" },
      });
      for (const member of members) {
        yield* member.client.chats.markRead({
          params: { id: chat.id },
          payload: { messageId: message.id },
        });
      }

      const events = chatUpdates(chat.id, mark);
      // The message, then one receipt per reader — N publishes for N
      // participants. Each still reaches everyone (that's what keeps the
      // versions gap-free), but a receipt is patched in place by the
      // clients it reaches, so none of them turns into a request.
      expect(events).toHaveLength(1 + members.length);
      for (const event of events) expect(event.to).toEqual(everyone);
      expect(events[0]).toMatchObject({ change: "message_created" });
      expect(events.slice(1).map((e) => e["userId"])).toEqual(
        members.map((m) => m.user.id),
      );
      for (const event of events.slice(1)) {
        expect(event).toMatchObject({
          change: "read",
          fromMessageId: 0,
          lastReadMessageId: message.id,
        });
      }
      // And versions stay consecutive, so no client mistakes any of this
      // for a missed update.
      expect(events.map((e) => e["version"])).toEqual(
        events.map((_, i) => chat.version + 1 + i),
      );
    }),
  ));

test("a change with no narrower meaning still goes out without one", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice");
      const bob = yield* registerAndLogin("bob");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Plans", participantIds: [bob.user.id] },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "draft" },
      });

      const mark = published.length;
      yield* alice.client.chats.updateChat({
        params: { id: chat.id },
        payload: { title: "Plans v2" },
      });
      yield* alice.client.chats.updateMessage({
        params: { id: chat.id, messageId: message.id },
        payload: { contentType: "text", content: "final" },
      });
      yield* alice.client.chats.deleteMessage({
        params: { id: chat.id, messageId: message.id },
      });

      const events = chatUpdates(chat.id, mark);
      expect(events).toHaveLength(3);
      for (const event of events) {
        expect(event.to).toEqual([alice.user.id, bob.user.id].sort());
        // A client that sees no `change` refetches everything, as before.
        expect(event["change"]).toBeUndefined();
      }
    }),
  ));
