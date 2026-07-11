import { expect, test } from "bun:test";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Duration, Effect, Layer } from "effect";
import {
  ChatApi,
  MAX_PASSWORD_LENGTH,
  MAX_USER_SEARCH_QUERY_LENGTH,
  MAX_USERNAME_LENGTH,
} from "./Api.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db } from "./Db.ts";
import { JwtLive } from "./Jwt.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";
import { users } from "./db/schema.ts";
import { eq } from "drizzle-orm";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(InMemoryPubSubLive),
  Layer.provide(InMemoryPresenceStoreLive),
  Layer.provide(InMemoryRateLimiterLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(TokenVersionCacheLive),
  Layer.provide(JwtLive),
  Layer.provide(InMemoryWsTicketLive),
);

const { getTestDb } = makeTestDbAccessor();

const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
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

  try {
    return await Effect.runPromise(
      effect.pipe(Effect.provide(TestClientLayer)),
    );
  } finally {
    await dispose();
  }
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

test("searchUsers rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .searchUsers({ urlParams: { q: "abc" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("searchUsers rejects a bogus bearer token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeAuthedClient("not-a-real-token");
      const result = yield* c.users
        .searchUsers({ urlParams: { q: "abc" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("register returns the created user with an id and no password", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const user = yield* c.users.register({
        payload: { username: "alice", password: "s3cret-pw" },
      });
      expect(user.username).toBe("alice");
      expect(typeof user.id).toBe("number");
      expect(user.role).toBe("user");
      expect(user).not.toHaveProperty("password");
      expect(user).not.toHaveProperty("passwordHash");
    }),
  ));

test("register rejects a username over the maximum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .register({
          payload: {
            username: "a".repeat(MAX_USERNAME_LENGTH + 1),
            password: "s3cret-pw",
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("register rejects a password over the maximum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .register({
          payload: {
            username: "alice2",
            password: "a".repeat(MAX_PASSWORD_LENGTH + 1),
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("searchUsers returns matching users, case-insensitively, without password data", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "alexander", password: "pw-alexander" },
      });
      yield* c.users.register({
        payload: { username: "alexina", password: "pw-alexina" },
      });
      yield* c.users.register({
        payload: { username: "bob", password: "pw-bob" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "bob", password: "pw-bob" },
      });

      const authed = yield* makeAuthedClient(accessToken);
      const results = yield* authed.users.searchUsers({
        urlParams: { q: "ALEX" },
      });
      expect(results).toHaveLength(2);
      expect(results.map((u) => u.username)).toEqual(["alexander", "alexina"]);
      expect(results.every((u) => !("passwordHash" in u))).toBe(true);
    }),
  ));

test("searchUsers rejects a query shorter than the minimum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "cesar", password: "pw-cesar" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "cesar", password: "pw-cesar" },
      });

      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .searchUsers({ urlParams: { q: "ce" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("searchUsers rejects a query longer than the maximum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "cyrus", password: "pw-cyrus" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "cyrus", password: "pw-cyrus" },
      });

      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .searchUsers({
          urlParams: { q: "c".repeat(MAX_USER_SEARCH_QUERY_LENGTH + 1) },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("searchUsers returns no results for a query that matches nobody", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "dahlia", password: "pw-dahlia" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "dahlia", password: "pw-dahlia" },
      });

      const authed = yield* makeAuthedClient(accessToken);
      const results = yield* authed.users.searchUsers({
        urlParams: { q: "zzzzz" },
      });
      expect(results).toEqual([]);
    }),
  ));

test("getUser rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "carol", password: "pw-carol" },
      });
      const result = yield* c.users
        .getUser({ path: { id: created.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("getUser returns the correct user after registration", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "carol", password: "pw-carol" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "carol", password: "pw-carol" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const fetched = yield* authed.users.getUser({ path: { id: created.id } });
      expect(fetched).toEqual(created);
    }),
  ));

test("getUser returns 404 for a missing id", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "dave", password: "pw-dave" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "dave", password: "pw-dave" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .getUser({ path: { id: 9999 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { message: string }).message).toContain("9999");
      }
    }),
  ));

test("register with a duplicate username returns a 409 conflict", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "dave", password: "pw1" },
      });
      const result = yield* c.users
        .register({ payload: { username: "dave", password: "pw2" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { message: string }).message).toContain("dave");
      }
    }),
  ));

const decodeClaims = (token: string) => {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  expect(header).toEqual({ alg: "HS256", typ: "JWT" });
  return claims as {
    sub: number;
    username: string;
    role: string;
    type: string;
    iat: number;
    exp: number;
    tokenVersion: number;
  };
};

test("login succeeds and returns the user plus signed access and refresh JWTs", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "erin", password: "correct-horse" },
      });
      const { user, accessToken, refreshToken } = yield* c.users.login({
        payload: { username: "erin", password: "correct-horse" },
      });
      expect(user).toEqual(created);

      const access = decodeClaims(accessToken);
      const refresh = decodeClaims(refreshToken);

      for (const claims of [access, refresh]) {
        expect(claims.sub).toBe(created.id);
        expect(claims.username).toBe("erin");
        expect(claims.role).toBe("user");
        expect(claims.exp).toBeGreaterThan(claims.iat);
        expect(claims.tokenVersion).toBe(0);
      }
      expect(access.type).toBe("access");
      expect(refresh.type).toBe("refresh");
      // The refresh token outlives the access token.
      expect(refresh.exp - refresh.iat).toBeGreaterThan(
        access.exp - access.iat,
      );
    }),
  ));

test("login fails with a wrong password", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "frank", password: "right-pw" },
      });
      const result = yield* c.users
        .login({ payload: { username: "frank", password: "wrong-pw" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("login fails for an unknown username", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .login({ payload: { username: "ghost", password: "whatever" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("refresh exchanges a valid refresh token for a new, working access token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "hana", password: "pw-hana" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "hana", password: "pw-hana" },
      });

      const refreshed = yield* c.users.refresh({
        payload: { refreshToken },
      });
      const claims = decodeClaims(refreshed.accessToken);
      expect(claims.username).toBe("hana");
      expect(claims.type).toBe("access");

      const authed = yield* makeAuthedClient(refreshed.accessToken);
      const results = yield* authed.users.searchUsers({
        urlParams: { q: "hana" },
      });
      expect(results.map((u) => u.username)).toContain("hana");
    }),
  ));

test("refresh rotates the refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "ivan", password: "pw-ivan" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "ivan", password: "pw-ivan" },
      });

      const first = yield* c.users.refresh({ payload: { refreshToken } });
      expect(first.refreshToken).not.toBe(refreshToken);

      // The new refresh token works...
      const second = yield* c.users.refresh({
        payload: { refreshToken: first.refreshToken },
      });
      expect(decodeClaims(second.accessToken).username).toBe("ivan");
    }),
  ));

test("refresh rejects the previous refresh token once it's been rotated away", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "kate", password: "pw-kate" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "kate", password: "pw-kate" },
      });

      yield* c.users.refresh({ payload: { refreshToken } });

      // The old token is signature- and expiry-valid, but its store row was
      // marked revoked on rotation, so re-presenting it must be rejected.
      const result = yield* c.users
        .refresh({ payload: { refreshToken } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
    }),
  ));

test("replaying a rotated-away refresh token revokes the whole family, including the token it was rotated to", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "nora", password: "pw-nora" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "nora", password: "pw-nora" },
      });

      // Simulates theft: someone rotates the token first (the legitimate
      // client, in the normal case), then the original (now stale) token
      // gets replayed — e.g. by whoever stole it before the rotation.
      const rotated = yield* c.users.refresh({ payload: { refreshToken } });
      const reuse = yield* c.users
        .refresh({ payload: { refreshToken } })
        .pipe(Effect.either);
      expect(reuse._tag).toBe("Left");
      if (reuse._tag === "Left") {
        expect((reuse.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }

      // The replay must have poisoned the whole family: even the token the
      // legitimate client rotated to (and never leaked) is now revoked, so
      // both parties are forced to log back in rather than the thief simply
      // getting rejected while the legitimate session carries on unaware.
      const afterReuse = yield* c.users
        .refresh({ payload: { refreshToken: rotated.refreshToken } })
        .pipe(Effect.either);
      expect(afterReuse._tag).toBe("Left");
      if (afterReuse._tag === "Left") {
        expect((afterReuse.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
    }),
  ));

test("two concurrent login sessions each rotate independently", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "liam", password: "pw-liam" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "liam", password: "pw-liam" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "liam", password: "pw-liam" },
      });

      // Rotating session A must not invalidate session B's still-unused
      // refresh token — each login's refresh token is tracked by its own
      // store row.
      yield* c.users.refresh({
        payload: { refreshToken: sessionA.refreshToken },
      });
      const refreshedB = yield* c.users.refresh({
        payload: { refreshToken: sessionB.refreshToken },
      });
      expect(decodeClaims(refreshedB.accessToken).username).toBe("liam");
    }),
  ));

test("refresh rejects an access token used in place of a refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "jack", password: "pw-jack" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "jack", password: "pw-jack" },
      });

      const result = yield* c.users
        .refresh({ payload: { refreshToken: accessToken } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
    }),
  ));

test("refresh rejects a bogus refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .refresh({ payload: { refreshToken: "not-a-real-token" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
    }),
  ));

test("logout revokes the presented refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "maya", password: "pw-maya" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "maya", password: "pw-maya" },
      });

      yield* c.users.logout({ payload: { refreshToken } });

      const result = yield* c.users
        .refresh({ payload: { refreshToken } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
    }),
  ));

test("logout only revokes the presented session, leaving others intact", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "noah", password: "pw-noah" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "noah", password: "pw-noah" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "noah", password: "pw-noah" },
      });

      yield* c.users.logout({
        payload: { refreshToken: sessionA.refreshToken },
      });

      const refreshedB = yield* c.users.refresh({
        payload: { refreshToken: sessionB.refreshToken },
      });
      expect(decodeClaims(refreshedB.accessToken).username).toBe("noah");
    }),
  ));

test("logout with allSessions revokes every session for the user", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "olga", password: "pw-olga" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "olga", password: "pw-olga" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "olga", password: "pw-olga" },
      });

      yield* c.users.logout({
        payload: { refreshToken: sessionA.refreshToken, allSessions: true },
      });

      for (const refreshToken of [
        sessionA.refreshToken,
        sessionB.refreshToken,
      ]) {
        const result = yield* c.users
          .refresh({ payload: { refreshToken } })
          .pipe(Effect.either);
        expect(result._tag).toBe("Left");
      }
    }),
  ));

test("logout with allSessions immediately invalidates outstanding access tokens, not just refresh tokens", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "petra", password: "pw-petra" },
      });
      const { accessToken, refreshToken } = yield* c.users.login({
        payload: { username: "petra", password: "pw-petra" },
      });

      // Sanity check: the access token works before the forced logout.
      const authedBefore = yield* makeAuthedClient(accessToken);
      yield* authedBefore.users.searchUsers({ urlParams: { q: "petra" } });

      yield* c.users.logout({
        payload: { refreshToken, allSessions: true },
      });

      // Still well within its own 15-minute TTL, but token_version has been
      // bumped, so it must be rejected immediately rather than surviving to
      // its own expiry.
      const authedAfter = yield* makeAuthedClient(accessToken);
      const result = yield* authedAfter.users
        .searchUsers({ urlParams: { q: "petra" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("a fresh login after a forced logout still works", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "quinn", password: "pw-quinn" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "quinn", password: "pw-quinn" },
      });
      yield* c.users.logout({
        payload: { refreshToken, allSessions: true },
      });

      const { accessToken } = yield* c.users.login({
        payload: { username: "quinn", password: "pw-quinn" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const results = yield* authed.users.searchUsers({
        urlParams: { q: "quinn" },
      });
      expect(results.map((u) => u.username)).toContain("quinn");
    }),
  ));

test("refresh rejects a token signed under a token_version invalidated by a forced logout", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "ravi", password: "pw-ravi" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "ravi", password: "pw-ravi" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "ravi", password: "pw-ravi" },
      });

      yield* c.users.logout({
        payload: { refreshToken: sessionA.refreshToken, allSessions: true },
      });

      // sessionB's refresh token row is deleted by the forced logout too, so
      // this already fails on the store lookup — but it now also carries a
      // stale token_version, which must independently be rejected.
      const result = yield* c.users
        .refresh({ payload: { refreshToken: sessionB.refreshToken } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
    }),
  ));

test("logout with an already-invalid refresh token succeeds as a no-op", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.logout({
        payload: { refreshToken: "not-a-real-token" },
      });
    }),
  ));

test("changePassword rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .changePassword({
          payload: { currentPassword: "pw-sam", newPassword: "new-pw-sam" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("changePassword rejects a wrong current password", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "sam", password: "pw-sam" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "sam", password: "pw-sam" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .changePassword({
          payload: { currentPassword: "wrong-pw", newPassword: "new-pw-sam" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
    }),
  ));

test("changePassword updates the password and lets the caller log in with the new one", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "tara", password: "old-pw-tara" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "tara", password: "old-pw-tara" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users.changePassword({
        payload: { currentPassword: "old-pw-tara", newPassword: "new-pw-tara" },
      });

      const oldLogin = yield* c.users
        .login({ payload: { username: "tara", password: "old-pw-tara" } })
        .pipe(Effect.either);
      expect(oldLogin._tag).toBe("Left");

      const newLogin = yield* c.users.login({
        payload: { username: "tara", password: "new-pw-tara" },
      });
      expect(newLogin.user.username).toBe("tara");
    }),
  ));

test("changePassword returns a working access token for the calling session, despite bumping token_version", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "uma", password: "old-pw-uma" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "uma", password: "old-pw-uma" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const { accessToken: newAccessToken } =
        yield* authed.users.changePassword({
          payload: { currentPassword: "old-pw-uma", newPassword: "new-pw-uma" },
        });

      // The old access token, signed under the pre-bump token_version, is
      // now rejected...
      const staleResult = yield* authed.users
        .searchUsers({ urlParams: { q: "uma" } })
        .pipe(Effect.either);
      expect(staleResult._tag).toBe("Left");

      // ...but the freshly issued one works.
      const authedAfter = yield* makeAuthedClient(newAccessToken);
      const results = yield* authedAfter.users.searchUsers({
        urlParams: { q: "uma" },
      });
      expect(results.map((u) => u.username)).toContain("uma");
    }),
  ));

test("changePassword revokes every other session's refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "vince", password: "old-pw-vince" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "vince", password: "old-pw-vince" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "vince", password: "old-pw-vince" },
      });

      const authedA = yield* makeAuthedClient(sessionA.accessToken);
      yield* authedA.users.changePassword({
        payload: {
          currentPassword: "old-pw-vince",
          newPassword: "new-pw-vince",
        },
      });

      const refreshB = yield* c.users
        .refresh({ payload: { refreshToken: sessionB.refreshToken } })
        .pipe(Effect.either);
      expect(refreshB._tag).toBe("Left");
    }),
  ));

test("changePassword is rate-limited per account after repeated wrong attempts", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "wendy", password: "pw-wendy" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "wendy", password: "pw-wendy" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      // CHANGE_PASSWORD_MAX_ATTEMPTS_PER_ACCOUNT is 5 (UsersHandler.ts).
      for (let i = 0; i < 5; i++) {
        const attempt = yield* authed.users
          .changePassword({
            payload: { currentPassword: "wrong-pw", newPassword: "new-pw" },
          })
          .pipe(Effect.either);
        expect(attempt._tag).toBe("Left");
      }
      const result = yield* authed.users
        .changePassword({
          payload: { currentPassword: "wrong-pw", newPassword: "new-pw" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const left = result.left as { _tag: string; retryAfterSeconds: number };
        expect(left._tag).toBe("TooManyRequests");
        expect(left.retryAfterSeconds).toBeGreaterThan(0);
      }
    }),
  ));

test("register is rate-limited per IP after repeated attempts", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      // REGISTER_MAX_ATTEMPTS_PER_IP is 5 (UsersHandler.ts) — the test
      // harness has no real socket, so every call in this test shares one
      // "unknown" IP bucket regardless of username.
      for (let i = 0; i < 5; i++) {
        yield* c.users.register({
          payload: { username: `reguser${i}`, password: "pw-register" },
        });
      }
      const result = yield* c.users
        .register({
          payload: { username: "reguser5", password: "pw-register" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const left = result.left as { _tag: string; retryAfterSeconds: number };
        expect(left._tag).toBe("TooManyRequests");
        expect(left.retryAfterSeconds).toBeGreaterThan(0);
      }
    }),
  ));

test("login is rate-limited per account after repeated attempts, independent of whether the account exists", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      // LOGIN_MAX_ATTEMPTS_PER_ACCOUNT is 5, well below the per-IP cap of 20,
      // so this trips the per-account bucket first. The username need not
      // belong to a real account — the bucket is keyed on the submitted
      // username regardless, so a nonexistent account can't be used to
      // bypass the limit.
      for (let i = 0; i < 5; i++) {
        const attempt = yield* c.users
          .login({ payload: { username: "ghost-account", password: "wrong" } })
          .pipe(Effect.either);
        expect(attempt._tag).toBe("Left");
        if (attempt._tag === "Left") {
          expect((attempt.left as { _tag: string })._tag).toBe(
            "InvalidCredentials",
          );
        }
      }
      const result = yield* c.users
        .login({ payload: { username: "ghost-account", password: "wrong" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const left = result.left as { _tag: string; retryAfterSeconds: number };
        expect(left._tag).toBe("TooManyRequests");
        expect(left.retryAfterSeconds).toBeGreaterThan(0);
      }
    }),
  ));

test("refresh is rate-limited per IP after repeated attempts", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      // REFRESH_MAX_ATTEMPTS_PER_IP is 60 — a bogus token is enough to
      // exercise the limit without needing a real refresh token per call.
      for (let i = 0; i < 60; i++) {
        yield* c.users
          .refresh({ payload: { refreshToken: "not-a-real-token" } })
          .pipe(Effect.either);
      }
      const result = yield* c.users
        .refresh({ payload: { refreshToken: "not-a-real-token" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const left = result.left as { _tag: string; retryAfterSeconds: number };
        expect(left._tag).toBe("TooManyRequests");
        expect(left.retryAfterSeconds).toBeGreaterThan(0);
      }
    }),
  ));

test("authentication token version check is cached for 5 seconds and respects expiration", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "cachetest", password: "pw-cachetest" },
      });
      const { user, accessToken } = yield* c.users.login({
        payload: { username: "cachetest", password: "pw-cachetest" },
      });

      const authed = yield* makeAuthedClient(accessToken);

      // 1. First request: should succeed and populate cache.
      const firstResult = yield* authed.users.getUser({
        path: { id: user.id },
      });
      expect(firstResult.username).toBe("cachetest");

      // 2. Directly bump tokenVersion in the database behind the scenes (bypassing invalidation).
      const db = yield* Effect.promise(getTestDb);
      yield* Effect.tryPromise(() =>
        db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, user.id)),
      ).pipe(Effect.orDie);

      // 3. Second request: within the cache TTL (5s), it should STILL succeed since cache hasn't expired.
      const secondResult = yield* authed.users.getUser({
        path: { id: user.id },
      });
      expect(secondResult.username).toBe("cachetest");

      // 4. Sleep for 6 seconds to let the cache entry expire.
      yield* Effect.sleep(Duration.seconds(6));

      // 5. Third request: after cache expiration, it must fetch from DB, find the bumped version (1 !== 0), and reject as Unauthorized.
      const thirdResult = yield* authed.users
        .getUser({ path: { id: user.id } })
        .pipe(Effect.either);
      expect(thirdResult._tag).toBe("Left");
      if (thirdResult._tag === "Left") {
        expect((thirdResult.left as { _tag: string })._tag).toBe(
          "Unauthorized",
        );
      }
    }),
  ));
