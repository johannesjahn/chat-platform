import { expect, test } from "bun:test";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { AuthenticationLive } from "./Auth.ts";
import { Db } from "./Db.ts";
import { JwtLive } from "./Jwt.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import * as schema from "./db/schema.ts";
import { users } from "./db/schema.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(JwtLive),
);

// `effect` may also require `Db` directly (e.g. to promote a user to admin
// out-of-band, the way it'd happen in production) — it shares the exact same
// in-memory database instance as the API layer built below.
const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Db>,
): Promise<A> => {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  const TestDbLive = Layer.succeed(Db, db);

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      ApiLive.pipe(Layer.provide(TestDbLive)),
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

  return Effect.runPromise(
    effect.pipe(Effect.provide(TestClientLayer), Effect.provide(TestDbLive)),
  ).finally(() => {
    dispose();
    sqlite.close();
  });
};

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

// A client that sends `Authorization: Bearer <token>` on every request, for
// exercising endpoints behind the Authentication middleware.
const makeAuthedClient = (token: string) =>
  HttpApiClient.make(ChatApi, {
    baseUrl: "http://localhost",
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
  });

// Registers a user and logs in, returning the user plus an access token.
const registerAndLogin = (username: string, password: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return { user, accessToken };
  });

// Simulates promoting a user to admin out-of-band (there's no API for it —
// registration always creates a "user"). Role is baked into the JWT at sign
// time, so a promoted user must log in again to get a token reflecting it.
const promoteToAdmin = (username: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.try(() =>
      db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.username, username))
        .run(),
    ).pipe(Effect.orDie);
  });

test("createPost rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.posts
        .createPost({ payload: { contentType: "text", content: "hello" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("createPost creates a text post owned by the current user", () =>
  run(
    Effect.gen(function* () {
      const { user, accessToken } = yield* registerAndLogin("alice", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const post = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "hello world" },
      });
      expect(post.authorId).toBe(user.id);
      expect(post.contentType).toBe("text");
      expect(post.content).toBe("hello world");
      expect(typeof post.id).toBe("number");
      expect(post.createdAt).toBe(post.updatedAt);
    }),
  ));

test("createPost creates an image_url post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("bob", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const post = yield* authed.posts.createPost({
        payload: {
          contentType: "image_url",
          content: "https://example.com/cat.png",
        },
      });
      expect(post.contentType).toBe("image_url");
      expect(post.content).toBe("https://example.com/cat.png");
    }),
  ));

test("createPost rejects content over the max length", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("carol", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .createPost({
          payload: { contentType: "text", content: "x".repeat(10_001) },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("createPost rejects an empty content string", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("dave", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .createPost({ payload: { contentType: "text", content: "" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("createPost rejects an invalid content type", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("erin", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .createPost({
          payload: {
            contentType: "video" as never,
            content: "hello",
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("getPost works without authentication", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("frank", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "public post" },
      });

      const c = yield* makeClient;
      const fetched = yield* c.posts.getPost({ path: { id: created.id } });
      expect(fetched).toEqual(created);
    }),
  ));

test("listAllPosts rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.posts
        .listAllPosts({ urlParams: {} })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("listAllPosts returns a default first page with total count", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("olga", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      for (let i = 0; i < 3; i++) {
        yield* authed.posts.createPost({
          payload: { contentType: "text", content: `post ${i}` },
        });
      }

      const result = yield* authed.posts.listAllPosts({ urlParams: {} });
      expect(result.offset).toBe(0);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(3);
      expect(result.posts).toHaveLength(3);
    }),
  ));

test("listAllPosts paginates newest-first using offset and limit query params", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("pete", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const created = [];
      for (let i = 0; i < 5; i++) {
        created.push(
          yield* authed.posts.createPost({
            payload: { contentType: "text", content: `post ${i}` },
          }),
        );
      }
      // listAllPosts orders newest-first, so pages walk `created` in reverse.
      const newestFirst = [...created].reverse();

      const firstPage = yield* authed.posts.listAllPosts({
        urlParams: { offset: 0, limit: 2 },
      });
      expect(firstPage.total).toBe(5);
      expect(firstPage.posts.map((p) => p.id)).toEqual(
        newestFirst.slice(0, 2).map((p) => p.id),
      );

      const secondPage = yield* authed.posts.listAllPosts({
        urlParams: { offset: 2, limit: 2 },
      });
      expect(secondPage.posts.map((p) => p.id)).toEqual(
        newestFirst.slice(2, 4).map((p) => p.id),
      );

      const thirdPage = yield* authed.posts.listAllPosts({
        urlParams: { offset: 4, limit: 2 },
      });
      expect(thirdPage.posts.map((p) => p.id)).toEqual(
        newestFirst.slice(4, 5).map((p) => p.id),
      );
    }),
  ));

test("listAllPosts rejects a limit above the max", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("quinn", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .listAllPosts({ urlParams: { limit: 101 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("listAllPosts rejects a negative offset", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("ruth", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .listAllPosts({ urlParams: { offset: -1 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("getPost returns 404 for a missing id", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.posts
        .getPost({ path: { id: 9999 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { message: string }).message).toContain("9999");
      }
    }),
  ));

test("updatePost allows the author to edit their post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("grace", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "original" },
      });

      const updated = yield* authed.posts.updatePost({
        path: { id: created.id },
        payload: { contentType: "image_url", content: "https://x.test/i" },
      });
      expect(updated.id).toBe(created.id);
      expect(updated.contentType).toBe("image_url");
      expect(updated.content).toBe("https://x.test/i");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    }),
  ));

test("updatePost rejects edits from a user who doesn't own the post", () =>
  run(
    Effect.gen(function* () {
      const author = yield* registerAndLogin("henry", "pw");
      const authorClient = yield* makeAuthedClient(author.accessToken);
      const created = yield* authorClient.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });

      const intruder = yield* registerAndLogin("iris", "pw");
      const intruderClient = yield* makeAuthedClient(intruder.accessToken);
      const result = yield* intruderClient.posts
        .updatePost({
          path: { id: created.id },
          payload: { contentType: "text", content: "hijacked" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("updatePost allows an admin to edit another user's post", () =>
  run(
    Effect.gen(function* () {
      const author = yield* registerAndLogin("oscar", "pw");
      const authorClient = yield* makeAuthedClient(author.accessToken);
      const created = yield* authorClient.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });

      yield* registerAndLogin("paula", "pw");
      yield* promoteToAdmin("paula");
      const c = yield* makeClient;
      const { accessToken: adminToken } = yield* c.users.login({
        payload: { username: "paula", password: "pw" },
      });
      const adminClient = yield* makeAuthedClient(adminToken);

      const updated = yield* adminClient.posts.updatePost({
        path: { id: created.id },
        payload: { contentType: "text", content: "edited by admin" },
      });
      expect(updated.content).toBe("edited by admin");
      expect(updated.authorId).toBe(author.user.id);
    }),
  ));

test("updatePost returns 404 for a missing post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("jack", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .updatePost({
          path: { id: 9999 },
          payload: { contentType: "text", content: "nope" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("deletePost allows the author to delete their post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("karen", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "to delete" },
      });

      yield* authed.posts.deletePost({ path: { id: created.id } });

      const c = yield* makeClient;
      const result = yield* c.posts
        .getPost({ path: { id: created.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("deletePost rejects deletes from a user who doesn't own the post", () =>
  run(
    Effect.gen(function* () {
      const author = yield* registerAndLogin("liam", "pw");
      const authorClient = yield* makeAuthedClient(author.accessToken);
      const created = yield* authorClient.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });

      const intruder = yield* registerAndLogin("mona", "pw");
      const intruderClient = yield* makeAuthedClient(intruder.accessToken);
      const result = yield* intruderClient.posts
        .deletePost({ path: { id: created.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("deletePost allows an admin to delete another user's post", () =>
  run(
    Effect.gen(function* () {
      const author = yield* registerAndLogin("quincy", "pw");
      const authorClient = yield* makeAuthedClient(author.accessToken);
      const created = yield* authorClient.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });

      yield* registerAndLogin("rachel", "pw");
      yield* promoteToAdmin("rachel");
      const c = yield* makeClient;
      const { accessToken: adminToken } = yield* c.users.login({
        payload: { username: "rachel", password: "pw" },
      });
      const adminClient = yield* makeAuthedClient(adminToken);

      yield* adminClient.posts.deletePost({ path: { id: created.id } });

      const result = yield* c.posts
        .getPost({ path: { id: created.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("deletePost rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("nina", "pw");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });

      const c = yield* makeClient;
      const result = yield* c.posts
        .deletePost({ path: { id: created.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));
