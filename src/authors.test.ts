import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { Db } from "./Db.ts";
import { users } from "./db/schema.ts";
import { makeTestRun } from "./testApi.ts";

// `Post.author`/`Comment.author` (issue #750): every post and comment response
// embeds its author's byline, resolved in one batch per response rather than
// a `GET /users/:id` per author on the client.

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

const PW = "pw-testpass";

const registerAndLogin = (username: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({
      payload: { username, password: PW },
    });
    const { accessToken } = yield* c.users.login({
      payload: { username, password: PW },
    });
    return { user, client: yield* makeAuthedClient(accessToken) };
  });

const AVATAR_URL = "https://images.unsplash.com/photo-1";

// Three authors with different bylines: a display name and an external
// avatar, a display name only, and neither.
const seedAuthors = Effect.gen(function* () {
  const alice = yield* registerAndLogin("alice");
  const bob = yield* registerAndLogin("bob");
  const carol = yield* registerAndLogin("carol");
  yield* alice.client.users.updateProfile({
    payload: { displayName: "Alice A.", avatarUrl: AVATAR_URL },
  });
  yield* bob.client.users.updateProfile({
    payload: { displayName: "Bob B.", avatarUrl: null },
  });
  return { alice, bob, carol };
});

const expected = {
  alice: (id: number) => ({
    id,
    username: "alice",
    displayName: "Alice A.",
    avatarUrl: AVATAR_URL,
    avatarVariants: null,
  }),
  bob: (id: number) => ({
    id,
    username: "bob",
    displayName: "Bob B.",
    avatarUrl: null,
    avatarVariants: null,
  }),
  carol: (id: number) => ({
    id,
    username: "carol",
    displayName: null,
    avatarUrl: null,
    avatarVariants: null,
  }),
};

// Counts the batched author lookups (`authorSummaries` in authors.ts) the
// app's database runs while `effect` executes — the N+1 guard: a page costs
// one, however many authors it has.
const countAuthorLookups = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    type Query = (sql: string, ...rest: unknown[]) => Promise<unknown>;
    const client = (db as unknown as { $client: { query: Query } }).$client;
    const original = client.query;
    let lookups = 0;
    client.query = function (this: unknown, sql: string, ...rest: unknown[]) {
      if (/where "users"\."id" in \(/.test(sql)) lookups++;
      return original.call(this, sql, ...rest);
    };
    const result = yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          client.query = original;
        }),
      ),
    );
    return { result, lookups };
  });

test("listPosts embeds every author, in one lookup for the whole page", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, carol } = yield* seedAuthors;
      for (const [who, content] of [
        [alice, "a1"],
        [bob, "b1"],
        [carol, "c1"],
        [alice, "a2"],
      ] as const)
        yield* who.client.posts.createPost({
          payload: { contentType: "text", content },
        });

      const { result: page, lookups } = yield* countAuthorLookups(
        carol.client.posts.listPosts({ query: {} }),
      );
      expect(lookups).toBe(1);
      expect(page.posts.map((p) => [p.content, p.author])).toEqual([
        ["a2", expected.alice(alice.user.id)],
        ["c1", expected.carol(carol.user.id)],
        ["b1", expected.bob(bob.user.id)],
        ["a1", expected.alice(alice.user.id)],
      ]);
      for (const post of page.posts) expect(post.author.id).toBe(post.authorId);
    }),
  ));

test("getPost, createPost and updatePost embed the post's author", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob } = yield* seedAuthors;
      const created = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "hello" },
      });
      expect(created.author).toEqual(expected.alice(alice.user.id));

      const fetched = yield* bob.client.posts.getPost({
        params: { id: created.id },
      });
      expect(fetched.author).toEqual(expected.alice(alice.user.id));

      // An admin's edit keeps the original author's byline.
      const db = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(users)
          .set({ role: "admin" })
          .where(eq(users.id, bob.user.id)),
      );
      const { accessToken } = yield* (yield* makeClient).users.login({
        payload: { username: "bob", password: PW },
      });
      const admin = yield* makeAuthedClient(accessToken);
      const updated = yield* admin.posts.updatePost({
        params: { id: created.id },
        payload: { contentType: "text", content: "edited" },
      });
      expect(updated.author).toEqual(expected.alice(alice.user.id));
    }),
  ));

test("an author's profile change shows through on their existing posts", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob } = yield* seedAuthors;
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "hello" },
      });
      yield* alice.client.users.updateProfile({
        payload: { displayName: "Renamed", avatarUrl: null },
      });
      const fetched = yield* bob.client.posts.getPost({
        params: { id: post.id },
      });
      expect(fetched.author.displayName).toBe("Renamed");
      expect(fetched.author.avatarUrl).toBeNull();
    }),
  ));

test("listUserPosts embeds the profile's author", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob } = yield* seedAuthors;
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "one" },
      });
      yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "two" },
      });
      const page = yield* bob.client.users.listUserPosts({
        params: { id: alice.user.id },
        query: {},
      });
      expect(page.posts.map((p) => p.author)).toEqual([
        expected.alice(alice.user.id),
        expected.alice(alice.user.id),
      ]);
    }),
  ));

test("comments and replies embed their authors, one lookup per page", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, carol } = yield* seedAuthors;
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });
      const fromBob = yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "from bob" },
      });
      expect(fromBob.author).toEqual(expected.bob(bob.user.id));
      yield* carol.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "from carol" },
      });
      yield* alice.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "from alice" },
      });

      const { result: thread, lookups } = yield* countAuthorLookups(
        alice.client.comments.listComments({
          params: { id: post.id },
          query: {},
        }),
      );
      expect(lookups).toBe(1);
      expect(thread.comments.map((c) => c.author)).toEqual([
        expected.bob(bob.user.id),
        expected.carol(carol.user.id),
        expected.alice(alice.user.id),
      ]);

      const reply = yield* carol.client.comments.createReply({
        params: { id: fromBob.id },
        payload: { content: "a reply" },
      });
      expect(reply.author).toEqual(expected.carol(carol.user.id));
      const replies = yield* alice.client.comments.listReplies({
        params: { id: fromBob.id },
        query: {},
      });
      expect(replies.comments.map((c) => c.author)).toEqual([
        expected.carol(carol.user.id),
      ]);

      const single = yield* alice.client.comments.getComment({
        params: { id: fromBob.id },
      });
      expect(single.author).toEqual(expected.bob(bob.user.id));
      const edited = yield* bob.client.comments.updateComment({
        params: { id: fromBob.id },
        payload: { content: "edited" },
      });
      expect(edited.author).toEqual(expected.bob(bob.user.id));
    }),
  ));

test("a blocked author's posts and comments stay hidden", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob, carol } = yield* seedAuthors;
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "by alice" },
      });
      yield* bob.client.posts.createPost({
        payload: { contentType: "text", content: "by bob" },
      });
      yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "bob's comment" },
      });
      yield* carol.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "block" },
      });

      const feed = yield* carol.client.posts.listPosts({ query: {} });
      expect(feed.posts.map((p) => p.author.username)).toEqual(["alice"]);
      const thread = yield* carol.client.comments.listComments({
        params: { id: post.id },
        query: {},
      });
      expect(thread.comments).toEqual([]);
    }),
  ));

test("a deleted account's posts and comments leave the feed and the thread", () =>
  run(
    Effect.gen(function* () {
      const { alice, bob } = yield* seedAuthors;
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "by alice" },
      });
      yield* bob.client.posts.createPost({
        payload: { contentType: "text", content: "by bob" },
      });
      yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "bob's comment" },
      });
      yield* bob.client.users.deleteAccount({ payload: { password: PW } });

      const feed = yield* alice.client.posts.listPosts({ query: {} });
      expect(feed.posts.map((p) => p.author.username)).toEqual(["alice"]);
      const thread = yield* alice.client.comments.listComments({
        params: { id: post.id },
        query: {},
      });
      expect(thread.comments).toEqual([]);
    }),
  ));
