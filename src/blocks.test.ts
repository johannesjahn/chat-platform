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
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidBlockRequest");
    }),
  ));

test("setBlock 404s for a non-existent target", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const result = yield* alice.client.users
        .setBlock({ params: { id: 999999 }, payload: { type: "block" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("listBlocks requires authentication", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users.listBlocks().pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
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

test("comments and replies from blocked and muted authors are hidden, restored on removeBlock", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);
      const dave = yield* registerAndLogin("dave", PW);

      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "alice post" },
      });
      const aliceComment = yield* alice.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "alice comment" },
      });
      const bobComment = yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "bob comment" },
      });
      yield* carol.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "carol comment" },
      });
      yield* bob.client.comments.createReply({
        params: { id: aliceComment.id },
        payload: { content: "bob reply" },
      });
      yield* dave.client.comments.createReply({
        params: { id: aliceComment.id },
        payload: { content: "dave reply" },
      });
      // Dave's reply under bob's comment is unreachable for alice once bob's
      // comment is hidden, so it drops out of her count too.
      yield* dave.client.comments.createReply({
        params: { id: bobComment.id },
        payload: { content: "dave reply to bob" },
      });

      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });
      yield* alice.client.users.setBlock({
        params: { id: carol.user.id },
        payload: { type: "mute" },
      });

      const top = yield* alice.client.comments.listComments({
        params: { id: post.id },
        query: {},
      });
      expect(top.comments.map((c) => c.content)).toEqual(["alice comment"]);
      expect(top.comments[0]?.replyCount).toBe(1);

      const replies = yield* alice.client.comments.listReplies({
        params: { id: aliceComment.id },
        query: {},
      });
      expect(replies.comments.map((c) => c.content)).toEqual(["dave reply"]);

      expect(
        (yield* alice.client.posts.getPost({ params: { id: post.id } }))
          .commentCount,
      ).toBe(2);
      const feed = yield* alice.client.posts.listPosts({ query: {} });
      expect(feed.posts[0]?.commentCount).toBe(2);
      const comment = yield* alice.client.comments.getComment({
        params: { id: aliceComment.id },
      });
      expect(comment.replyCount).toBe(1);

      // A page never comes back short: the hidden rows are skipped inside
      // the keyset query, not trimmed off afterwards.
      const firstPage = yield* alice.client.comments.listComments({
        params: { id: post.id },
        query: { limit: 1 },
      });
      expect(firstPage.comments.map((c) => c.content)).toEqual([
        "alice comment",
      ]);
      expect(firstPage.nextCursor).toBeNull();

      // The filter is per-viewer: dave still sees everything.
      const daveView = yield* dave.client.comments.listComments({
        params: { id: post.id },
        query: {},
      });
      expect(daveView.comments.length).toBe(3);
      expect(
        (yield* dave.client.posts.getPost({ params: { id: post.id } }))
          .commentCount,
      ).toBe(6);

      // Unblocking and unmuting brings everything back.
      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      yield* alice.client.users.removeBlock({ params: { id: carol.user.id } });
      const restored = yield* alice.client.comments.listComments({
        params: { id: post.id },
        query: {},
      });
      expect(restored.comments.map((c) => c.content)).toEqual([
        "alice comment",
        "bob comment",
        "carol comment",
      ]);
      expect(restored.comments[0]?.replyCount).toBe(2);
      const restoredReplies = yield* alice.client.comments.listReplies({
        params: { id: aliceComment.id },
        query: {},
      });
      expect(restoredReplies.comments.map((c) => c.content)).toEqual([
        "bob reply",
        "dave reply",
      ]);
      expect(
        (yield* alice.client.posts.getPost({ params: { id: post.id } }))
          .commentCount,
      ).toBe(6);
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
        .pipe(Effect.flip);
      expect(aliceSend._tag).toBe("Forbidden");

      yield* bob.client.chats
        .createMessage({
          params: { id: chat.id },
          payload: { contentType: "text", content: "hi alice" },
        })
        .pipe(Effect.flip);

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
