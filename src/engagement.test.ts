import { expect, test } from "bun:test";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import { Effect, Layer, Metric, MetricLabel } from "effect";
import { ChatApi } from "./Api.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
import { JwtLive } from "./Jwt.ts";
import { contentCreatedTotal, rateLimitRejectionsTotal } from "./Metrics.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { users } from "./db/schema.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(EngagementHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(TokenVersionCacheLive),
  Layer.provide(InMemoryPresenceStoreLive),
  Layer.provide(InMemoryRateLimiterLive),
  Layer.provide(JwtLive),
  Layer.provide(SanitizeDecodeErrorsLive),
  Layer.provide(InMemoryWsTicketLive),
);

const { getTestDb } = makeTestDbAccessor();

const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Db>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
  const TestDbLive = Layer.succeed(Db, db);

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      ApiLive.pipe(
        Layer.provide(TestDbLive),
        Layer.provide(InMemoryPubSubLive),
      ),
      BunHttpServer.layerContext,
    ),
  );

  const mockFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> =>
    handler(
      input instanceof Request ? input : new Request(input.toString(), init),
    );

  const TestClientLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, mockFetch as typeof fetch),
    ),
  );

  try {
    return await Effect.runPromise(
      effect.pipe(Effect.provide(TestClientLayer), Effect.provide(TestDbLive)),
    );
  } finally {
    await dispose();
  }
};

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
    return { user, accessToken };
  });

const promoteToAdmin = (username: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.tryPromise(() =>
      db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.username, username)),
    ).pipe(Effect.orDie);
  });

// Registers a user, logs in, creates a post, and returns everything needed to
// exercise the engagement endpoints against it.
const setupPostBy = (username: string) =>
  Effect.gen(function* () {
    const { user, accessToken } = yield* registerAndLogin(
      username,
      "pw-testpass",
    );
    const authed = yield* makeAuthedClient(accessToken);
    const post = yield* authed.posts.createPost({
      payload: { contentType: "text", content: `post by ${username}` },
    });
    return { user, accessToken, authed, post };
  });

// --- Post likes -----------------------------------------------------------

test("a new post starts with zero likes and likedByMe false", () =>
  run(
    Effect.gen(function* () {
      const { post } = yield* setupPostBy("alice");
      expect(post.likeCount).toBe(0);
      expect(post.likedByMe).toBe(false);
    }),
  ));

test("likePost increments the count and marks likedByMe", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("bob");
      const state = yield* authed.comments.likePost({
        path: { id: post.id },
      });
      expect(state.likeCount).toBe(1);
      expect(state.liked).toBe(true);

      const fetched = yield* authed.posts.getPost({ path: { id: post.id } });
      expect(fetched.likeCount).toBe(1);
      expect(fetched.likedByMe).toBe(true);
    }),
  ));

// content_created_total is a module-level metric shared with whichever other
// test files land in the same `bun test --parallel` worker process, so this
// asserts the delta produced rather than an absolute value (see
// Metrics.test.ts's websocketConnectionsActive test for the same reasoning).
test('likePost increments content_created_total{type="like"} only on an actual new like', () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("faye");
      const likesCreated = Metric.taggedWithLabels(contentCreatedTotal, [
        MetricLabel.make("type", "like"),
      ]);
      const before = yield* Metric.value(likesCreated);

      yield* authed.comments.likePost({ path: { id: post.id } });
      const afterFirst = yield* Metric.value(likesCreated);
      expect(afterFirst.count).toBe(before.count + 1);

      // A repeat like is a no-op (see likePost's onConflictDoNothing) and
      // must not double-count.
      yield* authed.comments.likePost({ path: { id: post.id } });
      const afterSecond = yield* Metric.value(likesCreated);
      expect(afterSecond.count).toBe(before.count + 1);
    }),
  ));

test("likePost is idempotent — liking twice still counts once", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("carol");
      yield* authed.comments.likePost({ path: { id: post.id } });
      const state = yield* authed.comments.likePost({
        path: { id: post.id },
      });
      expect(state.likeCount).toBe(1);
      expect(state.liked).toBe(true);
    }),
  ));

test("likes from different users accumulate; likedByMe is per-user", () =>
  run(
    Effect.gen(function* () {
      const { authed: aliceClient, post } = yield* setupPostBy("dave");
      yield* aliceClient.comments.likePost({ path: { id: post.id } });

      const bob = yield* registerAndLogin("erin", "pw-testpass");
      const bobClient = yield* makeAuthedClient(bob.accessToken);
      const state = yield* bobClient.comments.likePost({
        path: { id: post.id },
      });
      expect(state.likeCount).toBe(2);
      expect(state.liked).toBe(true);

      // From the author's perspective, the count is 2 but they only like it
      // themselves.
      const fromAuthor = yield* aliceClient.posts.getPost({
        path: { id: post.id },
      });
      expect(fromAuthor.likeCount).toBe(2);
      expect(fromAuthor.likedByMe).toBe(true);

      // A third user who hasn't liked sees the count but likedByMe false.
      const carol = yield* registerAndLogin("frank", "pw-testpass");
      const carolClient = yield* makeAuthedClient(carol.accessToken);
      const seen = yield* carolClient.posts.getPost({ path: { id: post.id } });
      expect(seen.likeCount).toBe(2);
      expect(seen.likedByMe).toBe(false);
    }),
  ));

test("unlikePost removes the like; unliking again is a no-op", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("grace");
      yield* authed.comments.likePost({ path: { id: post.id } });
      const afterUnlike = yield* authed.comments.unlikePost({
        path: { id: post.id },
      });
      expect(afterUnlike.likeCount).toBe(0);
      expect(afterUnlike.liked).toBe(false);

      const again = yield* authed.comments.unlikePost({
        path: { id: post.id },
      });
      expect(again.likeCount).toBe(0);
    }),
  ));

test("likePost returns 404 for a missing post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("heidi", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.comments
        .likePost({ path: { id: 9999 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
    }),
  ));

test("likePost rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const { post } = yield* setupPostBy("ivan");
      const c = yield* makeClient;
      const result = yield* c.comments
        .likePost({ path: { id: post.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
    }),
  ));

test('engagement mutations are rate-limited per user, incrementing rate_limit_rejections_total{limiter="engagement"}', () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("limiter");
      const rejections = Metric.taggedWithLabels(rateLimitRejectionsTotal, [
        MetricLabel.make("limiter", "engagement"),
      ]);
      const before = yield* Metric.value(rejections);
      // ENGAGEMENT_WRITE_MAX_PER_USER = 120 (EngagementHandler.ts). Creating
      // the post above isn't an engagement write (it's the posts group, no
      // limiter), so this user's engagement bucket starts empty. likePost is
      // idempotent, so repeats are harmless no-ops that each still consume one
      // unit — fire past the limit and the bucket should reject.
      let allowed = 0;
      let lastTag = "";
      for (let i = 0; i < 130; i++) {
        const result = yield* authed.comments
          .likePost({ path: { id: post.id } })
          .pipe(Effect.either);
        if (result._tag === "Right") {
          allowed++;
        } else {
          lastTag = (result.left as { _tag: string })._tag;
          break;
        }
      }
      expect(allowed).toBe(120);
      expect(lastTag).toBe("TooManyRequests");
      const after = yield* Metric.value(rejections);
      expect(after.count).toBe(before.count + 1);
    }),
  ));

// --- Comments -------------------------------------------------------------

test("createComment creates a top-level comment owned by the author", () =>
  run(
    Effect.gen(function* () {
      const { user, authed, post } = yield* setupPostBy("judy");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "nice post" },
      });
      expect(comment.postId).toBe(post.id);
      expect(comment.parentCommentId).toBeNull();
      expect(comment.authorId).toBe(user.id);
      expect(comment.content).toBe("nice post");
      expect(comment.likeCount).toBe(0);
      expect(comment.likedByMe).toBe(false);
    }),
  ));

test('createComment increments content_created_total{type="comment"}', () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("nadia");
      const commentsCreated = Metric.taggedWithLabels(contentCreatedTotal, [
        MetricLabel.make("type", "comment"),
      ]);
      const before = yield* Metric.value(commentsCreated);
      yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "nice post" },
      });
      const after = yield* Metric.value(commentsCreated);
      expect(after.count).toBe(before.count + 1);
    }),
  ));

test("createComment returns 404 for a missing post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("mallory", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.comments
        .createComment({
          path: { id: 9999 },
          payload: { content: "hi" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
    }),
  ));

test("createComment rejects empty content", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("niaj");
      const result = yield* authed.comments
        .createComment({ path: { id: post.id }, payload: { content: "" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("listComments paginates oldest-first with a keyset cursor", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("olivia");
      const created = [];
      for (let i = 0; i < 5; i++) {
        created.push(
          yield* authed.comments.createComment({
            path: { id: post.id },
            payload: { content: `comment ${i}` },
          }),
        );
      }

      const firstPage = yield* authed.comments.listComments({
        path: { id: post.id },
        urlParams: { limit: 2 },
      });
      expect(firstPage.nextCursor).not.toBeNull();
      expect(firstPage.comments.map((c) => c.id)).toEqual([
        created[0]!.id,
        created[1]!.id,
      ]);

      const secondPage = yield* authed.comments.listComments({
        path: { id: post.id },
        urlParams: { limit: 2, cursor: firstPage.nextCursor! },
      });
      expect(secondPage.comments.map((c) => c.id)).toEqual([
        created[2]!.id,
        created[3]!.id,
      ]);

      const thirdPage = yield* authed.comments.listComments({
        path: { id: post.id },
        urlParams: { limit: 2, cursor: secondPage.nextCursor! },
      });
      expect(thirdPage.nextCursor).toBeNull();
      expect(thirdPage.comments.map((c) => c.id)).toEqual([created[4]!.id]);
    }),
  ));

test("listComments excludes replies (only top-level comments)", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("peggy");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "top-level" },
      });
      yield* authed.comments.createReply({
        path: { id: comment.id },
        payload: { content: "a reply" },
      });

      const page = yield* authed.comments.listComments({
        path: { id: post.id },
        urlParams: {},
      });
      expect(page.comments).toHaveLength(1);
      expect(page.comments[0]!.id).toBe(comment.id);
    }),
  ));

test("listComments rejects a malformed cursor", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("sybil");
      const result = yield* authed.comments
        .listComments({
          path: { id: post.id },
          urlParams: { cursor: "not-a-real-cursor" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCommentRequest",
        );
    }),
  ));

// --- Replies (depth-2 enforcement) ---------------------------------------

test("createReply creates a reply with parentCommentId set", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("trent");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "parent" },
      });
      const reply = yield* authed.comments.createReply({
        path: { id: comment.id },
        payload: { content: "child" },
      });
      expect(reply.parentCommentId).toBe(comment.id);
      expect(reply.postId).toBe(post.id);

      const replies = yield* authed.comments.listReplies({
        path: { id: comment.id },
        urlParams: {},
      });
      expect(replies.comments.map((c) => c.id)).toEqual([reply.id]);
    }),
  ));

test("createReply rejects replying to a reply (depth cap)", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("victor");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "parent" },
      });
      const reply = yield* authed.comments.createReply({
        path: { id: comment.id },
        payload: { content: "child" },
      });
      const result = yield* authed.comments
        .createReply({
          path: { id: reply.id },
          payload: { content: "grandchild" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCommentRequest",
        );
    }),
  ));

test("createReply returns 404 for a missing parent comment", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("walter", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.comments
        .createReply({ path: { id: 9999 }, payload: { content: "x" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
    }),
  ));

// --- Comment likes --------------------------------------------------------

test("likeComment toggles like state on a comment", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("wendy");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "like me" },
      });
      const liked = yield* authed.comments.likeComment({
        path: { id: comment.id },
      });
      expect(liked.likeCount).toBe(1);
      expect(liked.liked).toBe(true);

      const listed = yield* authed.comments.listComments({
        path: { id: post.id },
        urlParams: {},
      });
      expect(listed.comments[0]!.likeCount).toBe(1);
      expect(listed.comments[0]!.likedByMe).toBe(true);

      const unliked = yield* authed.comments.unlikeComment({
        path: { id: comment.id },
      });
      expect(unliked.likeCount).toBe(0);
      expect(unliked.liked).toBe(false);
    }),
  ));

test("likeComment returns 404 for a missing comment", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("yvonne", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.comments
        .likeComment({ path: { id: 9999 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
    }),
  ));

// --- Update / delete comment (ownership) ----------------------------------

test("updateComment lets the author edit their comment", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("zoe");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "original" },
      });
      const updated = yield* authed.comments.updateComment({
        path: { id: comment.id },
        payload: { content: "edited" },
      });
      expect(updated.content).toBe("edited");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(comment.updatedAt);
    }),
  ));

test("updateComment rejects edits from a non-owner", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("aaron");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "mine" },
      });
      const intruder = yield* registerAndLogin("bianca", "pw-testpass");
      const intruderClient = yield* makeAuthedClient(intruder.accessToken);
      const result = yield* intruderClient.comments
        .updateComment({
          path: { id: comment.id },
          payload: { content: "hijacked" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("Forbidden");
    }),
  ));

test("deleteComment lets the author delete; an admin can delete anyone's", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("caleb");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "to delete by admin" },
      });

      yield* registerAndLogin("diana", "pw-testpass");
      yield* promoteToAdmin("diana");
      const c = yield* makeClient;
      const { accessToken: adminToken } = yield* c.users.login({
        payload: { username: "diana", password: "pw-testpass" },
      });
      const adminClient = yield* makeAuthedClient(adminToken);
      yield* adminClient.comments.deleteComment({ path: { id: comment.id } });

      const listed = yield* authed.comments.listComments({
        path: { id: post.id },
        urlParams: {},
      });
      expect(listed.comments).toHaveLength(0);
    }),
  ));

test("deleteComment cascades to its replies", () =>
  run(
    Effect.gen(function* () {
      const { authed, post } = yield* setupPostBy("evan");
      const comment = yield* authed.comments.createComment({
        path: { id: post.id },
        payload: { content: "parent" },
      });
      const reply = yield* authed.comments.createReply({
        path: { id: comment.id },
        payload: { content: "child" },
      });

      yield* authed.comments.deleteComment({ path: { id: comment.id } });

      // The reply is gone with its parent — liking it now 404s.
      const result = yield* authed.comments
        .likeComment({ path: { id: reply.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left")
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
    }),
  ));
