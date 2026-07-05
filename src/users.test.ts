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
import { Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { AuthenticationLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db } from "./Db.ts";
import { JwtLive } from "./Jwt.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import * as schema from "./db/schema.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(JwtLive),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => {
  const TestDbLive = Layer.sync(Db, () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "./drizzle" });
    return db;
  });

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
    effect.pipe(Effect.provide(TestClientLayer)),
  ).finally(dispose);
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

test("listUsers rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users.listUsers({}).pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("listUsers rejects a bogus bearer token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeAuthedClient("not-a-real-token");
      const result = yield* c.users.listUsers({}).pipe(Effect.either);
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

test("listUsers returns all users in insertion order without password data", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "alice", password: "pw-alice" },
      });
      yield* c.users.register({
        payload: { username: "bob", password: "pw-bob" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "alice", password: "pw-alice" },
      });

      const authed = yield* makeAuthedClient(accessToken);
      const users = yield* authed.users.listUsers({});
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.username)).toEqual(["alice", "bob"]);
      expect(users.every((u) => !("passwordHash" in u))).toBe(true);
    }),
  ));

test("getUser returns the correct user after registration", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "carol", password: "pw-carol" },
      });
      const fetched = yield* c.users.getUser({ path: { id: created.id } });
      expect(fetched).toEqual(created);
    }),
  ));

test("getUser returns 404 for a missing id", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
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
