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
        payload: { body: "bob post" },
      });
      yield* carol.client.posts.createPost({
        payload: { body: "carol post" },
      });
      yield* alice.client.posts.createPost({
        payload: { body: "alice post" },
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

      // Bob no longer sees alice's post; carol, only muted, sees everything.
      const bobFeed = yield* bob.client.posts.listPosts({ query: {} });
      expect(bobFeed.posts.map((p) => p.authorId)).toEqual([
        carol.user.id,
        bob.user.id,
      ]);
      const carolFeed = yield* carol.client.posts.listPosts({ query: {} });
      expect(carolFeed.posts.length).toBe(3);

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
        payload: { body: "alice post" },
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
          payload: { body: "hi bob" },
        })
        .pipe(Effect.flip);
      expect(aliceSend._tag).toBe("Forbidden");

      yield* bob.client.chats
        .createMessage({
          params: { id: chat.id },
          payload: { body: "hi alice" },
        })
        .pipe(Effect.flip);

      // After bob unblocks, messaging works again.
      yield* bob.client.users.removeBlock({ params: { id: alice.user.id } });
      const ok = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hi again" },
      });
      expect(ok.body).toBe("hi again");
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
        payload: { body: "still delivered" },
      });
      expect(sent.body).toBe("still delivered");
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
        payload: { body: "hello group" },
      });
      expect(sent.body).toBe("hello group");
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
        payload: { body: "alice post" },
      });
      const bobPost = yield* bob.client.posts.createPost({
        payload: { body: "bob post" },
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
      // To bob the post reads as missing (issue #901).
      expect(blocked._tag).toBe("NotFound");

      // The blocker can't comment on the blocked user's post either.
      const reverse = yield* alice.client.comments
        .createComment({
          params: { id: bobPost.id },
          payload: { content: "alice on bob" },
        })
        .pipe(Effect.flip);
      expect(reverse._tag).toBe("Forbidden");
      if (reverse._tag === "Forbidden") {
        expect(reverse.message).toMatch(BLOCK_MESSAGE_PATTERN);
        expect(reverse.message).not.toContain("alice");
        expect(reverse.message).not.toContain("bob");
      }

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
        payload: { body: "alice post" },
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
        payload: { body: "carol post" },
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
      expect((yield* reply(aliceComment.id))._tag).toBe("NotFound");
      // Only the post's author is the blocker.
      expect((yield* reply(carolComment.id))._tag).toBe("NotFound");
      // Only the comment's author is the blocker.
      expect((yield* reply(aliceOnCarol.id))._tag).toBe("NotFound");

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
        payload: { body: "alice post" },
      });
      const bobPost = yield* bob.client.posts.createPost({
        payload: { body: "bob post" },
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
      expect(blocked._tag).toBe("NotFound");
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
        payload: { body: "carol post" },
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
      expect(blocked._tag).toBe("NotFound");
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
        payload: { body: "alice post" },
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

// Issue #901: a block also hides the blocker from the person they blocked.
// `alice` blocks (or mutes) `bob`; `carol` is a bystander whose post alice
// commented on.
const blockScenario = (type: "block" | "mute") =>
  Effect.gen(function* () {
    const alice = yield* registerAndLogin("alice", PW);
    const bob = yield* registerAndLogin("bob", PW);
    const carol = yield* registerAndLogin("carol", PW);

    const alicePost = yield* alice.client.posts.createPost({
      payload: { body: "findable alice post" },
    });
    const carolOnAlice = yield* carol.client.comments.createComment({
      params: { id: alicePost.id },
      payload: { content: "findable carol on alice" },
    });
    const carolPost = yield* carol.client.posts.createPost({
      payload: { body: "findable carol post" },
    });
    const aliceComment = yield* alice.client.comments.createComment({
      params: { id: carolPost.id },
      payload: { content: "findable alice comment" },
    });
    const carolUnderAlice = yield* carol.client.comments.createReply({
      params: { id: aliceComment.id },
      payload: { content: "findable carol under alice" },
    });
    const carolComment = yield* carol.client.comments.createComment({
      params: { id: carolPost.id },
      payload: { content: "findable carol comment" },
    });
    const aliceReply = yield* alice.client.comments.createReply({
      params: { id: carolComment.id },
      payload: { content: "findable alice reply" },
    });
    yield* alice.client.posts.createPost({ payload: { body: "hey @bob" } });

    yield* alice.client.users.setBlock({
      params: { id: bob.user.id },
      payload: { type },
    });
    return {
      alice,
      bob,
      carol,
      alicePost,
      carolOnAlice,
      carolPost,
      aliceComment,
      carolUnderAlice,
      carolComment,
      aliceReply,
    };
  });

const tagOf = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

test("a blocked user can't see the blocker's profile or posts", () =>
  run(
    Effect.gen(function* () {
      const s = yield* blockScenario("block");
      const { users, posts, comments } = s.bob.client;
      const aliceId = { params: { id: s.alice.user.id } };

      const feed = yield* posts.listPosts({ query: {} });
      expect(feed.posts.map((p) => p.id)).toEqual([s.carolPost.id]);

      // The same error as for an id that doesn't exist.
      const hidden = yield* users.getUser(aliceId).pipe(Effect.flip);
      expect(hidden._tag).toBe("NotFound");
      if (hidden._tag === "NotFound")
        expect(hidden.message).toBe(`User ${s.alice.user.id} not found`);
      expect(yield* tagOf(users.listUserPosts({ ...aliceId, query: {} }))).toBe(
        "NotFound",
      );
      const post = { params: { id: s.alicePost.id } };
      expect(yield* tagOf(posts.getPost(post))).toBe("NotFound");
      expect(yield* tagOf(posts.deletePost(post))).toBe("NotFound");
      expect(
        yield* tagOf(posts.updatePost({ ...post, payload: { body: "x" } })),
      ).toBe("NotFound");
      expect(yield* tagOf(comments.listComments({ ...post, query: {} }))).toBe(
        "NotFound",
      );

      // The blocker can still open the blocked user's profile (to unblock).
      const profile = yield* s.alice.client.users.getUser({
        params: { id: s.bob.user.id },
      });
      expect(profile.username).toBe("bob");
    }),
  ));

test("a blocked user can't see the blocker's comments, and counts match", () =>
  run(
    Effect.gen(function* () {
      const s = yield* blockScenario("block");
      const { posts, comments } = s.bob.client;

      const thread = yield* comments.listComments({
        params: { id: s.carolPost.id },
        query: {},
      });
      expect(thread.comments.map((c) => [c.id, c.replyCount])).toEqual([
        [s.carolComment.id, 0],
      ]);
      const replies = yield* comments.listReplies({
        params: { id: s.carolComment.id },
        query: {},
      });
      expect(replies.comments).toEqual([]);
      const one = yield* comments.getComment({
        params: { id: s.carolComment.id },
      });
      expect(one.replyCount).toBe(0);
      const post = yield* posts.getPost({ params: { id: s.carolPost.id } });
      expect(post.commentCount).toBe(1);
      const feed = yield* posts.listPosts({ query: {} });
      expect(feed.posts[0]?.commentCount).toBe(1);
      const carolPosts = yield* s.bob.client.users.listUserPosts({
        params: { id: s.carol.user.id },
        query: {},
      });
      expect(carolPosts.posts[0]?.commentCount).toBe(1);

      // Nor by id: alice's own, and what sits under her comment or post.
      for (const { id } of [
        s.aliceComment,
        s.aliceReply,
        s.carolUnderAlice,
        s.carolOnAlice,
      ]) {
        const target = { params: { id } };
        expect(yield* tagOf(comments.getComment(target))).toBe("NotFound");
        expect(
          yield* tagOf(comments.listReplies({ ...target, query: {} })),
        ).toBe("NotFound");
        expect(yield* tagOf(comments.deleteComment(target))).toBe("NotFound");
        expect(
          yield* tagOf(
            comments.addCommentReaction({
              ...target,
              payload: { emoji: "👍" },
            }),
          ),
        ).toBe("NotFound");
      }
    }),
  ));

test("a blocked user doesn't find the blocker in any search", () =>
  run(
    Effect.gen(function* () {
      const s = yield* blockScenario("block");
      const { users, search } = s.bob.client;

      expect(yield* users.searchUsers({ query: { q: "alice" } })).toEqual([]);
      expect(
        yield* users.lookupUsersByUsername({ query: { usernames: "alice" } }),
      ).toEqual([]);
      const people = yield* search.searchUsers({ query: { q: "alice" } });
      expect(people.results).toEqual([]);
      const foundPosts = yield* search.searchPosts({
        query: { q: "findable" },
      });
      expect(foundPosts.results.map((r) => r.id)).toEqual([s.carolPost.id]);
      const foundComments = yield* search.searchComments({
        query: { q: "findable" },
      });
      expect(foundComments.results.map((r) => r.id)).toEqual([
        s.carolComment.id,
      ]);
      const all = yield* search.searchAll({ query: { q: "alice" } });
      expect(all.users.results).toEqual([]);
      expect(all.posts.results).toEqual([]);
      expect(all.comments.results).toEqual([]);

      // Both ways for people.
      const reverse = yield* s.alice.client.search.searchUsers({
        query: { q: "bob" },
      });
      expect(reverse.results).toEqual([]);
    }),
  ));

test("a block hides the blocker's notifications from the blocked user", () =>
  run(
    Effect.gen(function* () {
      const s = yield* blockScenario("block");
      const inbox = () =>
        s.bob.client.notifications.listNotifications({ query: {} });

      // The mention from before the block is hidden, and a new one isn't
      // recorded: it doesn't turn up after the block is lifted.
      yield* s.alice.client.posts.createPost({ payload: { body: "@bob 2" } });
      const during = yield* inbox();
      expect(during.notifications).toEqual([]);
      expect(during.unreadCount).toBe(0);
      yield* s.alice.client.users.removeBlock({
        params: { id: s.bob.user.id },
      });
      expect((yield* inbox()).notifications.map((n) => n.excerpt)).toEqual([
        "hey @bob",
      ]);
    }),
  ));

test("lifting a block makes the blocker visible again", () =>
  run(
    Effect.gen(function* () {
      const s = yield* blockScenario("block");
      yield* s.alice.client.users.removeBlock({
        params: { id: s.bob.user.id },
      });
      const { users, posts } = s.bob.client;
      yield* users.getUser({ params: { id: s.alice.user.id } });
      yield* posts.getPost({ params: { id: s.alicePost.id } });
      const feed = yield* posts.listPosts({ query: {} });
      expect(feed.posts.length).toBe(3);
    }),
  ));

test("a muted user sees everything as before", () =>
  run(
    Effect.gen(function* () {
      const s = yield* blockScenario("mute");
      const { users, posts, comments, search, notifications } = s.bob.client;

      expect((yield* posts.listPosts({ query: {} })).posts.length).toBe(3);
      yield* users.getUser({ params: { id: s.alice.user.id } });
      const profile = yield* users.listUserPosts({
        params: { id: s.alice.user.id },
        query: {},
      });
      expect(profile.posts.length).toBe(2);
      yield* posts.getPost({ params: { id: s.alicePost.id } });
      const post = yield* posts.getPost({ params: { id: s.carolPost.id } });
      expect(post.commentCount).toBe(4);
      const thread = yield* comments.listComments({
        params: { id: s.carolPost.id },
        query: {},
      });
      expect(thread.comments.length).toBe(2);
      yield* comments.getComment({ params: { id: s.aliceReply.id } });
      expect((yield* users.searchUsers({ query: { q: "alice" } })).length).toBe(
        1,
      );
      expect(
        (yield* search.searchUsers({ query: { q: "alice" } })).results.length,
      ).toBe(1);
      expect(
        (yield* search.searchPosts({ query: { q: "findable" } })).results
          .length,
      ).toBe(2);
      expect(
        (yield* search.searchComments({ query: { q: "findable" } })).results
          .length,
      ).toBe(5);
      const inbox = yield* notifications.listNotifications({ query: {} });
      expect(inbox.notifications.length).toBe(1);
      // The muter still finds them, too.
      expect(
        (yield* s.alice.client.users.searchUsers({ query: { q: "bob" } }))
          .length,
      ).toBe(1);
    }),
  ));

test("an admin still sees someone who blocked them", () =>
  run(
    Effect.gen(function* () {
      const s = yield* blockScenario("block");
      const db = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(users)
          .set({ role: "admin" })
          .where(eq(users.id, s.bob.user.id)),
      );
      // The role is in the token, so log in again.
      const c = yield* makeClient;
      const { accessToken } = yield* c.users.login({
        payload: { username: "bob", password: PW },
      });
      const admin = yield* makeAuthedClient(accessToken);

      yield* admin.users.getUser({ params: { id: s.alice.user.id } });
      yield* admin.posts.getPost({ params: { id: s.alicePost.id } });
      yield* admin.comments.getComment({ params: { id: s.aliceComment.id } });
      expect((yield* admin.posts.listPosts({ query: {} })).posts.length).toBe(
        3,
      );
      expect(
        (yield* admin.users.searchUsers({ query: { q: "alice" } })).length,
      ).toBe(1);
    }),
  ));
