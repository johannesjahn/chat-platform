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

// Issue #757: a group used to be a way around the DM block — the blocked
// user could put the blocker in a "group" of two and message them there.
test("createGroupChat is rejected when a participant is on either side of a block with the creator", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);

      // Alice blocks bob: bob can't put alice in a group…
      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });
      const bobCreate = yield* bob.client.chats
        .createGroupChat({
          payload: {
            title: "sneaky",
            participantIds: [carol.user.id, alice.user.id],
          },
        })
        .pipe(Effect.flip);
      expect(bobCreate._tag).toBe("Forbidden");

      // …and, symmetric like DMs, alice can't put bob in one either.
      const aliceCreate = yield* alice.client.chats
        .createGroupChat({
          payload: { title: "nope", participantIds: [bob.user.id] },
        })
        .pipe(Effect.flip);
      expect(aliceCreate._tag).toBe("Forbidden");

      // Nothing was created along the way.
      const bobChats = yield* bob.client.chats.listChats({ query: {} });
      expect(bobChats.chats).toEqual([]);

      // A mute doesn't gate groups, and unblocking lifts the gate.
      yield* carol.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "mute" },
      });
      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      const ok = yield* bob.client.chats.createGroupChat({
        payload: {
          title: "fine now",
          participantIds: [carol.user.id, alice.user.id],
        },
      });
      expect(ok.participants.length).toBe(3);
    }),
  ));

test("addParticipants is rejected when a requested user is on either side of a block with the caller", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);
      const dave = yield* registerAndLogin("dave", PW);

      const chat = yield* bob.client.chats.createGroupChat({
        payload: { title: "group", participantIds: [carol.user.id] },
      });
      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });

      // The whole request fails — dave isn't added on his own either.
      const added = yield* bob.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: { participantIds: [dave.user.id, alice.user.id] },
        })
        .pipe(Effect.flip);
      expect(added._tag).toBe("Forbidden");
      const after = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(after.participants.map((p) => p.userId).sort()).toEqual(
        [bob.user.id, carol.user.id].sort(),
      );

      // The other way round: bob blocks dave, so bob can't add dave.
      yield* bob.client.users.setBlock({
        params: { id: dave.user.id },
        payload: { type: "block" },
      });
      const addDave = yield* bob.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: { participantIds: [dave.user.id] },
        })
        .pipe(Effect.flip);
      expect(addDave._tag).toBe("Forbidden");
    }),
  ));

test("joinChatViaInvite is rejected when the joiner and the invite's creator are on either side of a block", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);

      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "group", participantIds: [carol.user.id] },
      });
      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });

      const joined = yield* bob.client.chats
        .joinChatViaInvite({ params: { code: invite.code } })
        .pipe(Effect.flip);
      expect(joined._tag).toBe("Forbidden");
      // A rejected join doesn't use up the invite.
      const invites = yield* alice.client.chats.listChatInvites({
        params: { id: chat.id },
      });
      expect(invites.find((i) => i.id === invite.id)?.useCount).toBe(0);

      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      const ok = yield* bob.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
      expect(ok.id).toBe(chat.id);
    }),
  ));

// Issue #784: a block stops commenting on, replying to and reacting to the
// other side's posts and comments, in both directions, with a 403 that
// doesn't say who blocked whom. Content from before the block stays.
const BLOCK_MESSAGE_PATTERN = /because of a block$/;

test("createComment is rejected on a post when either party has blocked the other", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const alicePost = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "alice post" },
      });
      const bobPost = yield* bob.client.posts.createPost({
        payload: { contentType: "text", content: "bob post" },
      });
      const before = yield* bob.client.comments.createComment({
        params: { id: alicePost.id },
        payload: { content: "before the block" },
      });

      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });

      const blocked = yield* bob.client.comments
        .createComment({
          params: { id: alicePost.id },
          payload: { content: "after the block" },
        })
        .pipe(Effect.flip);
      expect(blocked._tag).toBe("Forbidden");
      if (blocked._tag === "Forbidden") {
        expect(blocked.message).toMatch(BLOCK_MESSAGE_PATTERN);
        expect(blocked.message).not.toContain("alice");
        expect(blocked.message).not.toContain("bob");
      }

      // The blocker can't comment on the blocked user's post either.
      const reverse = yield* alice.client.comments
        .createComment({
          params: { id: bobPost.id },
          payload: { content: "alice on bob" },
        })
        .pipe(Effect.flip);
      expect(reverse._tag).toBe("Forbidden");

      // The pre-block comment stays (visible to everyone but alice).
      const carol = yield* registerAndLogin("carol", PW);
      const seen = yield* carol.client.comments.listComments({
        params: { id: alicePost.id },
        query: {},
      });
      expect(seen.comments.map((c) => c.id)).toEqual([before.id]);

      // Lifting the block lets bob comment again.
      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      const ok = yield* bob.client.comments.createComment({
        params: { id: alicePost.id },
        payload: { content: "after unblock" },
      });
      expect(ok.content).toBe("after unblock");
    }),
  ));

test("createReply is rejected on a block with either the comment's or the post's author", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);

      // Alice's post, with a comment by alice and one by carol.
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "alice post" },
      });
      const aliceComment = yield* alice.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "alice comment" },
      });
      const carolComment = yield* carol.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "carol comment" },
      });
      // Carol's post, with a comment by alice.
      const carolPost = yield* carol.client.posts.createPost({
        payload: { contentType: "text", content: "carol post" },
      });
      const aliceOnCarol = yield* alice.client.comments.createComment({
        params: { id: carolPost.id },
        payload: { content: "alice on carol" },
      });

      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });

      const reply = (id: number) =>
        bob.client.comments
          .createReply({ params: { id }, payload: { content: "bob reply" } })
          .pipe(Effect.flip);

      // Both authors are the blocker.
      expect((yield* reply(aliceComment.id))._tag).toBe("Forbidden");
      // Only the post's author is the blocker.
      expect((yield* reply(carolComment.id))._tag).toBe("Forbidden");
      // Only the comment's author is the blocker.
      expect((yield* reply(aliceOnCarol.id))._tag).toBe("Forbidden");

      // Nothing to do with alice: allowed.
      const carolOwn = yield* carol.client.comments.createComment({
        params: { id: carolPost.id },
        payload: { content: "carol on own post" },
      });
      const ok = yield* bob.client.comments.createReply({
        params: { id: carolOwn.id },
        payload: { content: "bob reply to carol" },
      });
      expect(ok.parentCommentId).toBe(carolOwn.id);
    }),
  ));

test("addPostReaction is rejected when either party has blocked the other", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const alicePost = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "alice post" },
      });
      const bobPost = yield* bob.client.posts.createPost({
        payload: { contentType: "text", content: "bob post" },
      });
      yield* bob.client.comments.addPostReaction({
        params: { id: alicePost.id },
        payload: { emoji: "👍" },
      });

      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });

      const blocked = yield* bob.client.comments
        .addPostReaction({
          params: { id: alicePost.id },
          payload: { emoji: "❤️" },
        })
        .pipe(Effect.flip);
      expect(blocked._tag).toBe("Forbidden");
      const reverse = yield* alice.client.comments
        .addPostReaction({
          params: { id: bobPost.id },
          payload: { emoji: "❤️" },
        })
        .pipe(Effect.flip);
      expect(reverse._tag).toBe("Forbidden");

      // The pre-block reaction stays, and bob can still take it back.
      const post = yield* alice.client.posts.getPost({
        params: { id: alicePost.id },
      });
      expect(post.reactions.map((r) => r.emoji)).toEqual(["👍"]);
      const removed = yield* bob.client.comments.removePostReaction({
        params: { id: alicePost.id },
        payload: { emoji: "👍" },
      });
      expect(removed.reactions).toEqual([]);
    }),
  ));

test("addCommentReaction is rejected when either party has blocked the other", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);
      const carol = yield* registerAndLogin("carol", PW);

      const carolPost = yield* carol.client.posts.createPost({
        payload: { contentType: "text", content: "carol post" },
      });
      const aliceComment = yield* alice.client.comments.createComment({
        params: { id: carolPost.id },
        payload: { content: "alice comment" },
      });
      const bobComment = yield* bob.client.comments.createComment({
        params: { id: carolPost.id },
        payload: { content: "bob comment" },
      });

      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });

      const blocked = yield* bob.client.comments
        .addCommentReaction({
          params: { id: aliceComment.id },
          payload: { emoji: "👍" },
        })
        .pipe(Effect.flip);
      expect(blocked._tag).toBe("Forbidden");
      const reverse = yield* alice.client.comments
        .addCommentReaction({
          params: { id: bobComment.id },
          payload: { emoji: "👍" },
        })
        .pipe(Effect.flip);
      expect(reverse._tag).toBe("Forbidden");

      // A comment by someone else on the same post is fine.
      const carolComment = yield* carol.client.comments.createComment({
        params: { id: carolPost.id },
        payload: { content: "carol comment" },
      });
      const ok = yield* bob.client.comments.addCommentReaction({
        params: { id: carolComment.id },
        payload: { emoji: "👍" },
      });
      expect(ok.reactions.map((r) => r.emoji)).toEqual(["👍"]);
    }),
  ));

test("a mute does not stop commenting, replying or reacting", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", PW);
      const bob = yield* registerAndLogin("bob", PW);

      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "alice post" },
      });
      const aliceComment = yield* alice.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "alice comment" },
      });
      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "mute" },
      });

      const comment = yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "bob comment" },
      });
      expect(comment.content).toBe("bob comment");
      const reply = yield* bob.client.comments.createReply({
        params: { id: aliceComment.id },
        payload: { content: "bob reply" },
      });
      expect(reply.parentCommentId).toBe(aliceComment.id);
      yield* bob.client.comments.addPostReaction({
        params: { id: post.id },
        payload: { emoji: "👍" },
      });
      yield* bob.client.comments.addCommentReaction({
        params: { id: aliceComment.id },
        payload: { emoji: "👍" },
      });
      // Alice muting bob doesn't stop her engaging with him either.
      yield* alice.client.comments.addCommentReaction({
        params: { id: comment.id },
        payload: { emoji: "👍" },
      });
    }),
  ));
