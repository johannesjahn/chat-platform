import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { eq } from "drizzle-orm";
import { Effect, Metric } from "effect";
import { ChatApi } from "./Api.ts";
import { Db } from "./Db.ts";
import { contentCreatedTotal } from "./Metrics.ts";
import { users } from "./db/schema.ts";
import { makeTestRun } from "./testApi.ts";

// `effect` may also require `Db` directly (e.g. to promote a user to admin
// out-of-band, the way it'd happen in production) — it shares the exact same
// in-memory database instance as the API layer built below.
const run = makeTestRun();

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
    yield* Effect.tryPromise(() =>
      db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.username, username)),
    ).pipe(Effect.orDie);
  });

test("createPost rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.posts
        .createPost({ payload: { contentType: "text", content: "hello" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("createPost creates a text post owned by the current user", () =>
  run(
    Effect.gen(function* () {
      const { user, accessToken } = yield* registerAndLogin(
        "alice",
        "pw-testpass",
      );
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

// content_created_total is a module-level metric shared with whichever other
// test files land in the same `bun test --parallel` worker process (same
// reasoning as Metrics.test.ts's websocketConnectionsActive test), so this
// asserts the delta createPost produces rather than an absolute value.
test('createPost increments content_created_total{type="post"}', () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("dana", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const postsCreated = Metric.withAttributes(contentCreatedTotal, {
        type: "post",
      });
      const before = yield* Metric.value(postsCreated);
      yield* authed.posts.createPost({
        payload: { contentType: "text", content: "counted" },
      });
      const after = yield* Metric.value(postsCreated);
      expect(after.count).toBe(before.count + 1);
    }),
  ));

test("createPost creates an image_url post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("bob", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const post = yield* authed.posts.createPost({
        payload: {
          contentType: "image_url",
          content: "https://picsum.photos/200",
        },
      });
      expect(post.contentType).toBe("image_url");
      expect(post.content).toBe("https://picsum.photos/200");
    }),
  ));

test("createPost rejects an image_url from a non-allowlisted host", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("bobby", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.posts
        .createPost({
          payload: {
            contentType: "image_url",
            content: "https://evil.example.com/cat.png",
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("createPost rejects a non-https image_url", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("bobbi", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.posts
        .createPost({
          payload: {
            contentType: "image_url",
            content: "http://picsum.photos/200",
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("createPost rejects a javascript: image_url", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("bobette", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.posts
        .createPost({
          payload: {
            contentType: "image_url",
            content: "javascript:alert(1)",
          },
        })
        .pipe(Effect.flip);
    }),
  ));

// Regression tests for issue #171. The typed client above encodes payloads
// through the same schema the server decodes with, so a refinement failure
// like the image_url allowlist above never actually reaches the server —
// `HttpApiClient` catches it while encoding the request, before anything is
// sent. Sending a raw, hand-built request instead (as any non-browser client
// could) is the only way to exercise the server's actual decode-error
// response, i.e. what SanitizeDecodeErrorsLive (DecodeErrorSanitizer.ts) is
// there to clean up.
test("HttpApiDecodeError response keeps a Schema.filter refinement's own message", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "rawbobby",
        "pw-testpass",
      );
      const client = yield* HttpClient.HttpClient;
      const request = HttpClientRequest.post("http://localhost/posts", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          contentType: "image_url",
          content: "https://evil.example.com/cat.png",
        }),
      );
      const response = yield* client.execute(request);
      expect(response.status).toBe(400);
      const body = yield* response.json;
      expect(body).toMatchObject({
        _tag: "HttpApiDecodeError",
        message:
          "content must be an https:// URL from an allowed image-hosting domain",
      });
    }),
  ));

test("HttpApiDecodeError response replaces a structural type mismatch with a generic message", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin(
        "rawbobbi",
        "pw-testpass",
      );
      const client = yield* HttpClient.HttpClient;
      const request = HttpClientRequest.post("http://localhost/posts", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          contentType: "text",
          // Wrong type entirely (not a filter/refinement violation) — no
          // hand-authored message exists for this, so the sanitized
          // response must fall back to a generic message instead of
          // leaking the raw "Expected string, received number" trace.
          content: 12345,
        }),
      );
      const response = yield* client.execute(request);
      expect(response.status).toBe(400);
      const body = yield* response.json;
      expect(body).toMatchObject({
        _tag: "HttpApiDecodeError",
        message: "Invalid request",
      });
      // Regression test: the per-issue `message` must be sanitized too, not
      // just the top-level one — the frontend's errorMessage() reads
      // straight from `issues`, so a leftover raw message there would still
      // reach the user even with a clean top-level `message`.
      expect(JSON.stringify(body)).not.toContain("Expected string");
    }),
  ));

test("createPost rejects content over the max length", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("carol", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.posts
        .createPost({
          payload: { contentType: "text", content: "x".repeat(10_001) },
        })
        .pipe(Effect.flip);
    }),
  ));

test("createPost rejects an empty content string", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("dave", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.posts
        .createPost({ payload: { contentType: "text", content: "" } })
        .pipe(Effect.flip);
    }),
  ));

test("createPost rejects an invalid content type", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("erin", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.posts
        .createPost({
          payload: {
            contentType: "video" as never,
            content: "hello",
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("getPost rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("frank", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });

      const c = yield* makeClient;
      const result = yield* c.posts
        .getPost({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("getPost returns the post for an authenticated request", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("frankie", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });

      const fetched = yield* authed.posts.getPost({
        params: { id: created.id },
      });
      expect(fetched).toEqual(created);
    }),
  ));

test("listPosts rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.posts.listPosts({ query: {} }).pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("listPosts returns a default first page with a null nextCursor", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("olga", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      for (let i = 0; i < 3; i++) {
        yield* authed.posts.createPost({
          payload: { contentType: "text", content: `post ${i}` },
        });
      }

      const result = yield* authed.posts.listPosts({ query: {} });
      expect(result.limit).toBe(20);
      expect(result.nextCursor).toBeNull();
      expect(result.posts).toHaveLength(3);
    }),
  ));

test("listPosts paginates newest-first with a keyset cursor, without gaps or duplicates", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("pete", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const created = [];
      for (let i = 0; i < 5; i++) {
        created.push(
          yield* authed.posts.createPost({
            payload: { contentType: "text", content: `post ${i}` },
          }),
        );
      }
      // listPosts orders newest-first, so pages walk `created` in reverse.
      const newestFirst = [...created].reverse();

      const firstPage = yield* authed.posts.listPosts({
        query: { limit: 2 },
      });
      expect(firstPage.nextCursor).not.toBeNull();
      expect(firstPage.posts.map((p) => p.id)).toEqual(
        newestFirst.slice(0, 2).map((p) => p.id),
      );

      const secondPage = yield* authed.posts.listPosts({
        query: { limit: 2, cursor: firstPage.nextCursor! },
      });
      expect(secondPage.nextCursor).not.toBeNull();
      expect(secondPage.posts.map((p) => p.id)).toEqual(
        newestFirst.slice(2, 4).map((p) => p.id),
      );

      const thirdPage = yield* authed.posts.listPosts({
        query: { limit: 2, cursor: secondPage.nextCursor! },
      });
      expect(thirdPage.nextCursor).toBeNull();
      expect(thirdPage.posts.map((p) => p.id)).toEqual(
        newestFirst.slice(4, 5).map((p) => p.id),
      );
    }),
  ));

test("listPosts rejects a limit above the max", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("quinn", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.posts
        .listPosts({ query: { limit: 101 } })
        .pipe(Effect.flip);
    }),
  ));

test("listPosts rejects a malformed cursor", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("ruth", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .listPosts({ query: { cursor: "not-a-real-cursor" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidPostsRequest");
    }),
  ));

test("getPost returns 404 for a missing id", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("sam", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .getPost({ params: { id: 9999 } })
        .pipe(Effect.flip);
      expect((result as { message: string }).message).toContain("9999");
    }),
  ));

test("updatePost allows the author to edit their post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("grace", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "original" },
      });

      const updated = yield* authed.posts.updatePost({
        params: { id: created.id },
        payload: {
          contentType: "image_url",
          content: "https://picsum.photos/id/1/200",
        },
      });
      expect(updated.id).toBe(created.id);
      expect(updated.contentType).toBe("image_url");
      expect(updated.content).toBe("https://picsum.photos/id/1/200");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    }),
  ));

test("updatePost rejects edits from a user who doesn't own the post", () =>
  run(
    Effect.gen(function* () {
      const author = yield* registerAndLogin("henry", "pw-testpass");
      const authorClient = yield* makeAuthedClient(author.accessToken);
      const created = yield* authorClient.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });

      const intruder = yield* registerAndLogin("iris", "pw-testpass");
      const intruderClient = yield* makeAuthedClient(intruder.accessToken);
      const result = yield* intruderClient.posts
        .updatePost({
          params: { id: created.id },
          payload: { contentType: "text", content: "hijacked" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
    }),
  ));

test("updatePost allows an admin to edit another user's post", () =>
  run(
    Effect.gen(function* () {
      const author = yield* registerAndLogin("oscar", "pw-testpass");
      const authorClient = yield* makeAuthedClient(author.accessToken);
      const created = yield* authorClient.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });

      yield* registerAndLogin("paula", "pw-testpass");
      yield* promoteToAdmin("paula");
      const c = yield* makeClient;
      const { accessToken: adminToken } = yield* c.users.login({
        payload: { username: "paula", password: "pw-testpass" },
      });
      const adminClient = yield* makeAuthedClient(adminToken);

      const updated = yield* adminClient.posts.updatePost({
        params: { id: created.id },
        payload: { contentType: "text", content: "edited by admin" },
      });
      expect(updated.content).toBe("edited by admin");
      expect(updated.authorId).toBe(author.user.id);
    }),
  ));

test("updatePost returns 404 for a missing post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("jack", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.posts
        .updatePost({
          params: { id: 9999 },
          payload: { contentType: "text", content: "nope" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("deletePost allows the author to delete their post", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("karen", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "to delete" },
      });

      yield* authed.posts.deletePost({ params: { id: created.id } });

      const result = yield* authed.posts
        .getPost({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("deletePost rejects deletes from a user who doesn't own the post", () =>
  run(
    Effect.gen(function* () {
      const author = yield* registerAndLogin("liam", "pw-testpass");
      const authorClient = yield* makeAuthedClient(author.accessToken);
      const created = yield* authorClient.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });

      const intruder = yield* registerAndLogin("mona", "pw-testpass");
      const intruderClient = yield* makeAuthedClient(intruder.accessToken);
      const result = yield* intruderClient.posts
        .deletePost({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
    }),
  ));

test("deletePost allows an admin to delete another user's post", () =>
  run(
    Effect.gen(function* () {
      const author = yield* registerAndLogin("quincy", "pw-testpass");
      const authorClient = yield* makeAuthedClient(author.accessToken);
      const created = yield* authorClient.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });

      yield* registerAndLogin("rachel", "pw-testpass");
      yield* promoteToAdmin("rachel");
      const c = yield* makeClient;
      const { accessToken: adminToken } = yield* c.users.login({
        payload: { username: "rachel", password: "pw-testpass" },
      });
      const adminClient = yield* makeAuthedClient(adminToken);

      yield* adminClient.posts.deletePost({ params: { id: created.id } });

      const result = yield* authorClient.posts
        .getPost({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("deletePost rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("nina", "pw-testpass");
      const authed = yield* makeAuthedClient(accessToken);
      const created = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });

      const c = yield* makeClient;
      const result = yield* c.posts
        .deletePost({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));
