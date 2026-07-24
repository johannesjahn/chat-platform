import { expect, test } from "bun:test";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Duration, Effect, Layer, Metric, MetricLabel } from "effect";
import {
  ChatApi,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_STATUS_EMOJI_LENGTH,
  MAX_STATUS_TEXT_LENGTH,
  MAX_USER_SEARCH_QUERY_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "./Api.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { SearchHandlerLive } from "./SearchHandler.ts";
import { Db } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { JwtLive } from "./Jwt.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
import { authEventsTotal, rateLimitRejectionsTotal } from "./Metrics.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive, PubSub } from "./PubSub.ts";
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
  Layer.provide(EngagementHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(SearchHandlerLive),
  Layer.provide(AttachmentsHandlerLive),
  Layer.provide(AttachmentStorageLive),
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
  effect: Effect.Effect<A, E, HttpClient.HttpClient | PubSub>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
  const TestDbLive = Layer.succeed(Db, db);
  const pubsub = Effect.runSync(Effect.provide(PubSub, InMemoryPubSubLive));
  const TestPubSubLive = Layer.succeed(PubSub, pubsub);

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      ApiLive.pipe(Layer.provide(TestDbLive), Layer.provide(TestPubSubLive)),
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
      effect.pipe(
        Effect.provide(TestClientLayer),
        Effect.provide(TestPubSubLive),
      ),
    );
  } finally {
    await dispose();
  }
};

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

// authEventsTotal/rateLimitRejectionsTotal are module-level metrics shared
// with whichever other test files land in the same `bun test --parallel`
// worker process, so tests below assert deltas rather than absolute values
// (see Metrics.test.ts's websocketConnectionsActive test for the same
// reasoning).
const authEventCount = (
  event: "signup" | "login" | "refresh",
  outcome: "success" | "failure",
) =>
  Metric.value(
    Metric.taggedWithLabels(authEventsTotal, [
      MetricLabel.make("event", event),
      MetricLabel.make("outcome", outcome),
    ]),
  ).pipe(Effect.map((state) => state.count));

const rateLimitRejectionCount = (limiter: string) =>
  Metric.value(
    Metric.taggedWithLabels(rateLimitRejectionsTotal, [
      MetricLabel.make("limiter", limiter),
    ]),
  ).pipe(Effect.map((state) => state.count));

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

test('register returns the created user with an id and no password, incrementing auth_events_total{event="signup",outcome="success"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const before = yield* authEventCount("signup", "success");
      const user = yield* c.users.register({
        payload: { username: "alice", password: "s3cret-pw" },
      });
      expect(user.username).toBe("alice");
      expect(typeof user.id).toBe("number");
      expect(user.role).toBe("user");
      expect(user).not.toHaveProperty("password");
      expect(user).not.toHaveProperty("passwordHash");
      expect(yield* authEventCount("signup", "success")).toBe(before + 1);
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

test("register rejects a password under the minimum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .register({
          payload: {
            username: "alice3",
            password: "a".repeat(MIN_PASSWORD_LENGTH - 1),
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("register accepts a password at exactly the minimum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const user = yield* c.users.register({
        payload: {
          username: "alice4",
          password: "a".repeat(MIN_PASSWORD_LENGTH),
        },
      });
      expect(user.username).toBe("alice4");
    }),
  ));

test("changePassword rejects a new password under the minimum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "xena", password: "pw-xena12" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "xena", password: "pw-xena12" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .changePassword({
          payload: {
            currentPassword: "pw-xena12",
            newPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1),
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
        payload: { username: "bob", password: "pw-bob123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "bob", password: "pw-bob123" },
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
        payload: { username: "dave", password: "pw-dave1" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "dave", password: "pw-dave1" },
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

test('register is rate-limited per IP, incrementing rate_limit_rejections_total{limiter="register"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const before = yield* rateLimitRejectionCount("register");
      // REGISTER_MAX_ATTEMPTS_PER_IP = 5 (UsersHandler.ts). Every call in
      // this in-process test harness resolves to the same "unknown" IP (no
      // real socket/remoteAddress), so they all land in one bucket.
      for (let i = 0; i < 5; i++) {
        yield* c.users.register({
          payload: { username: `ratelimited-${i}`, password: "pw-testpass" },
        });
      }
      const result = yield* c.users
        .register({
          payload: { username: "ratelimited-tripped", password: "pw-testpass" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("TooManyRequests");
      }
      expect(yield* rateLimitRejectionCount("register")).toBe(before + 1);
    }),
  ));

test('register with a duplicate username returns a 409 conflict, incrementing auth_events_total{event="signup",outcome="failure"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "dave", password: "password-1" },
      });
      const before = yield* authEventCount("signup", "failure");
      const result = yield* c.users
        .register({ payload: { username: "dave", password: "password-2" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { message: string }).message).toContain("dave");
      }
      expect(yield* authEventCount("signup", "failure")).toBe(before + 1);
    }),
  ));

test("register with a username differing only by case from an existing one returns a 409 conflict", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "Bob", password: "password-1" },
      });
      const result = yield* c.users
        .register({ payload: { username: "bob", password: "password-2" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { message: string }).message).toContain("bob");
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

test('login succeeds and returns the user plus signed access and refresh JWTs, incrementing auth_events_total{event="login",outcome="success"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "erin", password: "correct-horse" },
      });
      const before = yield* authEventCount("login", "success");
      const { user, accessToken, refreshToken } = yield* c.users.login({
        payload: { username: "erin", password: "correct-horse" },
      });
      expect(yield* authEventCount("login", "success")).toBe(before + 1);
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

test("login accepts a pre-existing account whose password predates the minimum length", () =>
  run(
    Effect.gen(function* () {
      // Simulates an account created before MIN_PASSWORD_LENGTH existed —
      // bypasses the register endpoint (and its now-enforced minimum) by
      // inserting the row directly, with a short password hashed the same
      // way the handler would.
      const db = yield* Effect.promise(getTestDb);
      const shortPassword = "short1";
      const passwordHash = yield* Effect.tryPromise(() =>
        Bun.password.hash(shortPassword, { algorithm: "argon2id" }),
      );
      yield* Effect.tryPromise(() =>
        db
          .insert(users)
          .values({ username: "legacyuser", passwordHash })
          .returning(),
      );

      const c = yield* makeClient;
      const { user } = yield* c.users.login({
        payload: { username: "legacyuser", password: shortPassword },
      });
      expect(user.username).toBe("legacyuser");
    }),
  ));

test('login fails with a wrong password, incrementing auth_events_total{event="login",outcome="failure"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "frank", password: "right-pw" },
      });
      const before = yield* authEventCount("login", "failure");
      const result = yield* c.users
        .login({ payload: { username: "frank", password: "wrong-pw" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      expect(yield* authEventCount("login", "failure")).toBe(before + 1);
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

test("login succeeds regardless of the casing used, matching the registered account", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "Isabel", password: "pw-isabel" },
      });
      const { user } = yield* c.users.login({
        payload: { username: "isabel", password: "pw-isabel" },
      });
      expect(user.username).toBe("Isabel");
    }),
  ));

test('refresh exchanges a valid refresh token for a new, working access token, incrementing auth_events_total{event="refresh",outcome="success"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "hana", password: "pw-hana1" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "hana", password: "pw-hana1" },
      });

      const before = yield* authEventCount("refresh", "success");
      const refreshed = yield* c.users.refresh({
        payload: { refreshToken },
      });
      expect(yield* authEventCount("refresh", "success")).toBe(before + 1);
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
        payload: { username: "ivan", password: "pw-ivan1" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "ivan", password: "pw-ivan1" },
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
        payload: { username: "kate", password: "pw-kate1" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "kate", password: "pw-kate1" },
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
        payload: { username: "nora", password: "pw-nora1" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "nora", password: "pw-nora1" },
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
        payload: { username: "liam", password: "pw-liam1" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "liam", password: "pw-liam1" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "liam", password: "pw-liam1" },
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
        payload: { username: "jack", password: "pw-jack1" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "jack", password: "pw-jack1" },
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

test('refresh rejects a bogus refresh token, incrementing auth_events_total{event="refresh",outcome="failure"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const before = yield* authEventCount("refresh", "failure");
      const result = yield* c.users
        .refresh({ payload: { refreshToken: "not-a-real-token" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
      expect(yield* authEventCount("refresh", "failure")).toBe(before + 1);
    }),
  ));

test("logout revokes the presented refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "maya", password: "pw-maya1" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "maya", password: "pw-maya1" },
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
        payload: { username: "noah", password: "pw-noah1" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "noah", password: "pw-noah1" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "noah", password: "pw-noah1" },
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
        payload: { username: "olga", password: "pw-olga1" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "olga", password: "pw-olga1" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "olga", password: "pw-olga1" },
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
        payload: { username: "ravi", password: "pw-ravi1" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "ravi", password: "pw-ravi1" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "ravi", password: "pw-ravi1" },
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
          payload: { currentPassword: "pw-sam12", newPassword: "new-pw-sam" },
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
        payload: { username: "sam", password: "pw-sam12" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "sam", password: "pw-sam12" },
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
            payload: { currentPassword: "wrong-pw", newPassword: "new-pw12" },
          })
          .pipe(Effect.either);
        expect(attempt._tag).toBe("Left");
      }
      const result = yield* authed.users
        .changePassword({
          payload: { currentPassword: "wrong-pw", newPassword: "new-pw12" },
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

test("authentication token version cache is immediately evicted via PubSub invalidation events", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "pubsubtest", password: "pw-pubsubtest" },
      });
      const { user, accessToken } = yield* c.users.login({
        payload: { username: "pubsubtest", password: "pw-pubsubtest" },
      });

      const authed = yield* makeAuthedClient(accessToken);

      // 1. First request: should succeed and populate cache.
      const firstResult = yield* authed.users.getUser({
        path: { id: user.id },
      });
      expect(firstResult.username).toBe("pubsubtest");

      // 2. Directly bump tokenVersion in the database behind the scenes (bypassing invalidation).
      const db = yield* Effect.promise(getTestDb);
      yield* Effect.tryPromise(() =>
        db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, user.id)),
      ).pipe(Effect.orDie);

      // 3. Publish an invalidation event over PubSub.
      const pubsub = yield* PubSub;
      yield* pubsub.publish("auth:invalidation", String(user.id));

      // 4. Second request: even within 5 seconds, it should fail immediately because the cache was evicted by the PubSub event.
      const secondResult = yield* authed.users
        .getUser({ path: { id: user.id } })
        .pipe(Effect.either);
      expect(secondResult._tag).toBe("Left");
      if (secondResult._tag === "Left") {
        expect((secondResult.left as { _tag: string })._tag).toBe(
          "Unauthorized",
        );
      }
    }),
  ));

test("updateProfile rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .updateProfile({
          payload: { displayName: null, avatarUrl: null },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("updateProfile updates displayName and avatarUrl, reflected by getUser, without changing username", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "xander", password: "pw-xander" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "xander", password: "pw-xander" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const updated = yield* authed.users.updateProfile({
        payload: {
          displayName: "Xander Prime",
          avatarUrl: "https://i.imgur.com/avatar.png",
        },
      });
      expect(updated).toEqual({
        id: created.id,
        username: "xander",
        displayName: "Xander Prime",
        avatarUrl: "https://i.imgur.com/avatar.png",
        avatarVariants: null,
        role: "user",
        statusText: null,
        statusEmoji: null,
        statusExpiresAt: null,
      });

      const fetched = yield* authed.users.getUser({ path: { id: created.id } });
      expect(fetched).toEqual(updated);
    }),
  ));

test("updateProfile rejects a displayName over the maximum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "victor", password: "pw-victor" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "victor", password: "pw-victor" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .updateProfile({
          payload: {
            displayName: "a".repeat(MAX_DISPLAY_NAME_LENGTH + 1),
            avatarUrl: null,
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("updateProfile rejects an avatarUrl on a disallowed host", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "ulysses", password: "pw-ulysses" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "ulysses", password: "pw-ulysses" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .updateProfile({
          payload: {
            displayName: null,
            avatarUrl: "https://evil.example.com/avatar.png",
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("updateProfile clears displayName and avatarUrl when set to null after being set", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "tobias", password: "pw-tobias" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "tobias", password: "pw-tobias" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users.updateProfile({
        payload: {
          displayName: "Tobias",
          avatarUrl: "https://i.imgur.com/avatar.png",
        },
      });
      const cleared = yield* authed.users.updateProfile({
        payload: { displayName: null, avatarUrl: null },
      });
      expect(cleared.displayName).toBeNull();
      expect(cleared.avatarUrl).toBeNull();
    }),
  ));

test("deleteAccount rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .deleteAccount({ payload: { password: "whatever" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("deleteAccount rejects a wrong password", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "susan", password: "pw-susan12" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "susan", password: "pw-susan12" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .deleteAccount({ payload: { password: "wrong-pw" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidCredentials",
        );
      }
    }),
  ));

test("deleteAccount removes the account, cascading to its posts, and prevents future login", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "ronny", password: "pw-ronny12" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "ronny", password: "pw-ronny12" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const post = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "hello world" },
      });

      yield* authed.users.deleteAccount({
        payload: { password: "pw-ronny12" },
      });

      const loginResult = yield* c.users
        .login({ payload: { username: "ronny", password: "pw-ronny12" } })
        .pipe(Effect.either);
      expect(loginResult._tag).toBe("Left");

      // Register a fresh user just to get an authenticated client to look up
      // the now-deleted account/post through.
      yield* c.users.register({
        payload: { username: "sabrina", password: "pw-sabrina" },
      });
      const { accessToken: otherToken } = yield* c.users.login({
        payload: { username: "sabrina", password: "pw-sabrina" },
      });
      const otherAuthed = yield* makeAuthedClient(otherToken);

      const getUserResult = yield* otherAuthed.users
        .getUser({ path: { id: created.id } })
        .pipe(Effect.either);
      expect(getUserResult._tag).toBe("Left");
      if (getUserResult._tag === "Left") {
        expect((getUserResult.left as { _tag: string })._tag).toBe("NotFound");
      }

      const getPostResult = yield* otherAuthed.posts
        .getPost({ path: { id: post.id } })
        .pipe(Effect.either);
      expect(getPostResult._tag).toBe("Left");
      if (getPostResult._tag === "Left") {
        expect((getPostResult.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("deleteAccount immediately invalidates the caller's own outstanding tokens elsewhere", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "quincy", password: "pw-quincy1" },
      });
      const sessionA = yield* c.users.login({
        payload: { username: "quincy", password: "pw-quincy1" },
      });
      const sessionB = yield* c.users.login({
        payload: { username: "quincy", password: "pw-quincy1" },
      });

      const authedA = yield* makeAuthedClient(sessionA.accessToken);
      yield* authedA.users.deleteAccount({
        payload: { password: "pw-quincy1" },
      });

      const refreshB = yield* c.users
        .refresh({ payload: { refreshToken: sessionB.refreshToken } })
        .pipe(Effect.either);
      expect(refreshB._tag).toBe("Left");
    }),
  ));

test("deleteAccount is rate-limited per account after repeated wrong attempts", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "percy", password: "pw-percy12" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "percy", password: "pw-percy12" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      // DELETE_ACCOUNT_MAX_ATTEMPTS_PER_ACCOUNT is 5 (UsersHandler.ts).
      for (let i = 0; i < 5; i++) {
        const attempt = yield* authed.users
          .deleteAccount({ payload: { password: "wrong-pw" } })
          .pipe(Effect.either);
        expect(attempt._tag).toBe("Left");
      }
      const result = yield* authed.users
        .deleteAccount({ payload: { password: "wrong-pw" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const left = result.left as { _tag: string; retryAfterSeconds: number };
        expect(left._tag).toBe("TooManyRequests");
        expect(left.retryAfterSeconds).toBeGreaterThan(0);
      }
    }),
  ));

test("updateUserRole rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "opal", password: "pw-opal123" },
      });
      const result = yield* c.users
        .updateUserRole({
          path: { id: created.id },
          payload: { role: "admin" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("updateUserRole rejects a non-admin caller with Forbidden", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const target = yield* c.users.register({
        payload: { username: "nadia", password: "pw-nadia12" },
      });
      yield* c.users.register({
        payload: { username: "myron", password: "pw-myron12" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "myron", password: "pw-myron12" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .updateUserRole({
          path: { id: target.id },
          payload: { role: "admin" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("updateUserRole returns 404 for a missing target user", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Effect.promise(getTestDb);
      const passwordHash = yield* Effect.tryPromise(() =>
        Bun.password.hash("pw-admin123", { algorithm: "argon2id" }),
      );
      yield* Effect.tryPromise(() =>
        db
          .insert(users)
          .values({ username: "adminlisa", passwordHash, role: "admin" })
          .returning(),
      );
      const c = yield* makeClient;
      const { accessToken } = yield* c.users.login({
        payload: { username: "adminlisa", password: "pw-admin123" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .updateUserRole({ path: { id: 999999 }, payload: { role: "admin" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("updateUserRole promotes a user to admin, immediately invalidating their outstanding token and taking effect on their next login", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Effect.promise(getTestDb);
      const adminPasswordHash = yield* Effect.tryPromise(() =>
        Bun.password.hash("pw-admin456", { algorithm: "argon2id" }),
      );
      yield* Effect.tryPromise(() =>
        db
          .insert(users)
          .values({
            username: "adminkarl",
            passwordHash: adminPasswordHash,
            role: "admin",
          })
          .returning(),
      );

      const c = yield* makeClient;
      const target = yield* c.users.register({
        payload: { username: "louise", password: "pw-louise1" },
      });
      const targetSession = yield* c.users.login({
        payload: { username: "louise", password: "pw-louise1" },
      });

      const { accessToken: adminToken } = yield* c.users.login({
        payload: { username: "adminkarl", password: "pw-admin456" },
      });
      const adminAuthed = yield* makeAuthedClient(adminToken);

      const updated = yield* adminAuthed.users.updateUserRole({
        path: { id: target.id },
        payload: { role: "admin" },
      });
      expect(updated.role).toBe("admin");

      // The target's already-issued access token was signed under the old
      // role/token_version — must be rejected immediately, not just on its
      // own TTL.
      const targetAuthedBefore = yield* makeAuthedClient(
        targetSession.accessToken,
      );
      const staleResult = yield* targetAuthedBefore.users
        .getUser({ path: { id: target.id } })
        .pipe(Effect.either);
      expect(staleResult._tag).toBe("Left");
      if (staleResult._tag === "Left") {
        expect((staleResult.left as { _tag: string })._tag).toBe(
          "Unauthorized",
        );
      }

      // A fresh login reflects the new role.
      const { user: reloggedUser } = yield* c.users.login({
        payload: { username: "louise", password: "pw-louise1" },
      });
      expect(reloggedUser.role).toBe("admin");
    }),
  ));

test("updateStatus sets and clears statusText/statusEmoji, reflected by getUser", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "stella", password: "pw-stella1" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "stella", password: "pw-stella1" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const updated = yield* authed.users.updateStatus({
        payload: { statusText: "In a meeting", statusEmoji: "📅" },
      });
      expect(updated.statusText).toBe("In a meeting");
      expect(updated.statusEmoji).toBe("📅");
      expect(updated.statusExpiresAt).toBeNull();

      const fetched = yield* authed.users.getUser({ path: { id: created.id } });
      expect(fetched.statusText).toBe("In a meeting");
      expect(fetched.statusEmoji).toBe("📅");

      const cleared = yield* authed.users.updateStatus({
        payload: { statusText: null, statusEmoji: null },
      });
      expect(cleared.statusText).toBeNull();
      expect(cleared.statusEmoji).toBeNull();
      expect(cleared.statusExpiresAt).toBeNull();
    }),
  ));

test("updateStatus sets a future statusExpiresAt from expiresInMinutes", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "tobias", password: "pw-tobias1" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "tobias", password: "pw-tobias1" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const before = Date.now();
      const updated = yield* authed.users.updateStatus({
        payload: {
          statusText: "AFK",
          statusEmoji: null,
          expiresInMinutes: 30,
        },
      });
      expect(updated.statusExpiresAt).not.toBeNull();
      expect(updated.statusExpiresAt as number).toBeGreaterThan(before);
      expect(updated.statusExpiresAt as number).toBeLessThanOrEqual(
        before + 31 * 60_000,
      );
    }),
  ));

test("updateStatus rejects a statusText over the maximum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "ursula", password: "pw-ursula1" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "ursula", password: "pw-ursula1" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .updateStatus({
          payload: {
            statusText: "a".repeat(MAX_STATUS_TEXT_LENGTH + 1),
            statusEmoji: null,
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("updateStatus rejects a statusEmoji over the maximum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "vance", password: "pw-vance123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "vance", password: "pw-vance123" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .updateStatus({
          payload: {
            statusText: null,
            statusEmoji: "e".repeat(MAX_STATUS_EMOJI_LENGTH + 1),
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("updateStatus rejects expiresInMinutes when clearing the status", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "wendy", password: "pw-wendy123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "wendy", password: "pw-wendy123" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .updateStatus({
          payload: {
            statusText: null,
            statusEmoji: null,
            expiresInMinutes: 30,
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("a status past its expiry reads back as null everywhere", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "xena", password: "pw-xena1234" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "xena", password: "pw-xena1234" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users.updateStatus({
        payload: { statusText: "Vacationing", statusEmoji: "🏖️" },
      });

      // Directly backdate the expiry behind the scenes (bypassing the
      // endpoint's `expiresInMinutes` floor of 1) to simulate one that has
      // since elapsed.
      const db = yield* Effect.promise(getTestDb);
      yield* Effect.tryPromise(() =>
        db
          .update(users)
          .set({ statusExpiresAt: new Date(Date.now() - 1_000) })
          .where(eq(users.id, created.id)),
      ).pipe(Effect.orDie);

      const fetched = yield* authed.users.getUser({ path: { id: created.id } });
      expect(fetched.statusText).toBeNull();
      expect(fetched.statusEmoji).toBeNull();
      expect(fetched.statusExpiresAt).toBeNull();
    }),
  ));

test("updateStatus rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .updateStatus({
          payload: { statusText: "Busy", statusEmoji: null },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));
