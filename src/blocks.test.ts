import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { makeTestRun } from "./testApi.ts";

const run = makeTestRun();

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

const makeAuthedClient = (token: string) =>
  HttpApiClient.make(ChatApi, {
    baseUrl: "http://localhost",
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
  });

const registerAndLogin = (username: string, password: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return { user, accessToken, client: yield* makeAuthedClient(accessToken) };
  });

const PW = "pw-testpass";

test("setBlock records a block and listBlocks returns it", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const entry = yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });
      expect(entry.type).toBe("block");
      expect(entry.user.id).toBe(bob.user.id);

      const blocks = yield* alice.client.users.listBlocks();
      expect(blocks.length).toBe(1);
      expect(blocks[0]?.user.id).toBe(bob.user.id);
      expect(blocks[0]?.type).toBe("block");
    }),
  ));

test("setBlock upgrades a mute to a block in place (no duplicate row)", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "mute" },
      });
      const upgraded = yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });
      expect(upgraded.type).toBe("block");

      const blocks = yield* alice.client.users.listBlocks();
      expect(blocks.length).toBe(1);
      expect(blocks[0]?.type).toBe("block");
    }),
  ));

test("removeBlock lifts the relationship and is idempotent", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });
      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      expect((yield* alice.client.users.listBlocks()).length).toBe(0);

      // Removing again succeeds (no relationship to remove).
      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      expect((yield* alice.client.users.listBlocks()).length).toBe(0);
    }),
  ));

test("setBlock rejects blocking yourself", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const result = yield* alice.client.users
        .setBlock({
          params: { id: alice.user.id },
          payload: { type: "block" },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect((result.failure as { _tag: string })._tag).toBe(
          "InvalidBlockRequest",
        );
      }
    }),
  ));

test("setBlock 404s for a non-existent target", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const result = yield* alice.client.users
        .setBlock({ params: { id: 999999 }, payload: { type: "block" } })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect((result.failure as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("listBlocks requires authentication", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users.listBlocks().pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect((result.failure as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("listPosts hides posts from blocked and muted authors, restored on removeBlock", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);

      yield* bob.client.posts.createPost({
        payload: { contentType: "text", content: "bob post" },
      });
      yield* carol.client.posts.createPost({
        payload: { contentType: "text", content: "carol post" },
      });
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "alice post" },
      });

      // Alice blocks bob and mutes carol — both authors drop out of her feed.
      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });
      yield* alice.client.users.setBlock({
        params: { id: carol.user.id },
        payload: { type: "mute" },
      });

      const filtered = yield* alice.client.posts.listPosts({ query: {} });
      expect(filtered.posts.map((p) => p.authorId)).toEqual([alice.user.id]);

      // Bob still sees everyone's posts — the filter is per-viewer.
      const bobFeed = yield* bob.client.posts.listPosts({ query: {} });
      expect(bobFeed.posts.length).toBe(3);

      // Unblocking bob brings his post back into alice's feed.
      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      const afterUnblock = yield* alice.client.posts.listPosts({
        query: {},
      });
      expect(afterUnblock.posts.map((p) => p.authorId).sort()).toEqual(
        [alice.user.id, bob.user.id].sort(),
      );
    }),
  ));

test("createMessage is rejected in a direct chat when either party has blocked the other", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      // Bob blocks alice; now neither can message in the direct chat.
      yield* bob.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "block" },
      });

      const aliceSend = yield* alice.client.chats
        .createMessage({
          params: { id: chat.id },
          payload: { contentType: "text", content: "hi bob" },
        })
        .pipe(Effect.result);
      expect(aliceSend._tag).toBe("Failure");
      if (aliceSend._tag === "Failure") {
        expect((aliceSend.failure as { _tag: string })._tag).toBe("Forbidden");
      }

      const bobSend = yield* bob.client.chats
        .createMessage({
          params: { id: chat.id },
          payload: { contentType: "text", content: "hi alice" },
        })
        .pipe(Effect.result);
      expect(bobSend._tag).toBe("Failure");

      // After bob unblocks, messaging works again.
      yield* bob.client.users.removeBlock({ params: { id: alice.user.id } });
      const ok = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hi again" },
      });
      expect(ok.content).toBe("hi again");
    }),
  ));

test("a mute does not block direct messaging", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* bob.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "mute" },
      });

      // Muting only suppresses notifications — alice can still send.
      const sent = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "still delivered" },
      });
      expect(sent.content).toBe("still delivered");
    }),
  ));

test("createMessage succeeds in a group chat where a participant muted the sender", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);

      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      // Carol mutes alice — alice's group messages still post (the mute only
      // suppresses carol's realtime notification, exercised in dispatch).
      yield* carol.client.users.setBlock({
        params: { id: alice.user.id },
        payload: { type: "mute" },
      });

      const sent = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hello group" },
      });
      expect(sent.content).toBe("hello group");
    }),
  ));
