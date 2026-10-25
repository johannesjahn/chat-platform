import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Duration, Effect, Layer, Metric } from "effect";
import {
  ChatApi,
  MAX_BIO_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_STATUS_EMOJI_LENGTH,
  MAX_STATUS_TEXT_LENGTH,
  MAX_USER_SEARCH_QUERY_LENGTH,
  MAX_USERNAME_LENGTH,
  MAX_USERNAME_LOOKUP_COUNT,
  MAX_USERNAME_LOOKUP_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USER_SEARCH_QUERY_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_PATTERN,
} from "./Api.ts";
import {
  AdminAccountError,
  createAdminAccount,
  resetAdminPassword,
} from "./adminAccounts.ts";
import {
  GOOGLE_TEST_CLIENT_ID,
  googleSubFor,
  mintGoogleIdToken,
} from "./GoogleTestSigner.ts";
import { extractMentionedUsernames } from "./notifications.ts";
import { Db } from "./Db.ts";
import { authEventsTotal, rateLimitRejectionsTotal } from "./Metrics.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { staticPresenceAudience } from "./PresenceAudience.ts";
import { PubSub } from "./PubSub.ts";
import { RealtimeConnections, RealtimeConnectionsLive } from "./Realtime.ts";
import { users } from "./db/schema.ts";
import { eq } from "drizzle-orm";
import { makeTestRun } from "./testApi.ts";
import {
  googleIdTokenFor,
  signInTestUser,
  signUpTestUser,
} from "./testUsers.ts";

const run = makeTestRun();

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

// authEventsTotal/rateLimitRejectionsTotal are module-level metrics shared
// with whichever other test files land in the same `bun test --parallel`
// worker process, so tests below assert deltas rather than absolute values
// (see Metrics.test.ts's websocketConnectionsActive test for the same
// reasoning).
const authEventCount = (
  event: "google_login" | "google_signup" | "login" | "refresh",
  outcome: "success" | "failure",
) =>
  Metric.value(
    Metric.withAttributes(authEventsTotal, { event: event, outcome: outcome }),
  ).pipe(Effect.map((state) => state.count));

const rateLimitRejectionCount = (limiter: string) =>
  Metric.value(
    Metric.withAttributes(rateLimitRejectionsTotal, { limiter: limiter }),
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
        .searchUsers({ query: { q: "abc" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("searchUsers rejects a bogus bearer token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeAuthedClient("not-a-real-token");
      const result = yield* c.users
        .searchUsers({ query: { q: "abc" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

// The first half of a first Google sign-in: verifies a fresh ID token for
// `sub` and returns the pending token the username step takes.
const pendingTokenFor = (sub: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const idToken = yield* Effect.promise(() => mintGoogleIdToken({ sub }));
    const result = yield* c.users.loginGoogle({ payload: { idToken } });
    if (!("needsUsername" in result))
      return yield* Effect.die(new Error(`${sub} is already registered`));
    return result.pendingToken;
  });

// A password admin, made by the same code as scripts/create-admin.ts.
const createAdmin = (username: string, password: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* Effect.promise(() =>
      createAdminAccount(db, username, password),
    );
  });

// A password account written straight to the database, for the cases the
// CLI won't make: a non-admin with a password (e.g. an admin since demoted),
// or credentials predating today's username/password rules.
const insertPasswordUser = (
  username: string,
  password: string,
  role: "user" | "admin",
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const passwordHash = yield* Effect.promise(() =>
      Bun.password.hash(password, { algorithm: "argon2id" }),
    );
    const rows = yield* Effect.promise(() =>
      db
        .insert(users)
        .values({ username, passwordHash, role })
        .returning({ id: users.id }),
    );
    return rows[0]!;
  });

// Sends a request raw, so the server's own validation is what's exercised
// (the typed client would reject a malformed payload itself).
const postRaw = (path: string, body: unknown) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.post(`http://localhost${path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
    return { status: response.status, body: yield* response.text };
  });

test('a first Google sign-in asks for a username without creating an account, incrementing auth_events_total{event="google_login",outcome="success"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const db = yield* Db;
      const before = yield* authEventCount("google_login", "success");
      const idToken = yield* Effect.promise(() =>
        mintGoogleIdToken({ sub: "google-first" }),
      );
      const result = yield* c.users.loginGoogle({ payload: { idToken } });
      expect(result).toEqual({
        needsUsername: true,
        pendingToken: expect.any(String),
      });
      // No placeholder row: nothing to show up in mentions, search or lookups
      // until a name is picked.
      expect(yield* Effect.promise(() => db.select().from(users))).toEqual([]);
      expect(yield* authEventCount("google_login", "success")).toBe(before + 1);
    }),
  ));

test('the username step creates the account and returns a session, incrementing auth_events_total{event="google_signup",outcome="success"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const db = yield* Db;
      const before = yield* authEventCount("google_signup", "success");
      const pendingToken = yield* pendingTokenFor("google-alice");
      const session = yield* c.users.registerGoogle({
        payload: { pendingToken, username: "alice" },
      });
      expect(session.user.username).toBe("alice");
      expect(session.user.role).toBe("user");
      expect(session.authMethod).toBe("google");
      expect(session.user).not.toHaveProperty("googleSub");
      expect(session.user).not.toHaveProperty("passwordHash");
      expect(yield* authEventCount("google_signup", "success")).toBe(
        before + 1,
      );

      // The session works, and the row holds only Google's `sub` — no
      // password and nothing else from the token.
      const authed = yield* makeAuthedClient(session.accessToken);
      const me = yield* authed.users.getUser({
        params: { id: session.user.id },
      });
      expect(me.username).toBe("alice");
      const [row] = yield* Effect.promise(() =>
        db.select().from(users).where(eq(users.id, session.user.id)),
      );
      expect(row!.googleSub).toBe("google-alice");
      expect(row!.passwordHash).toBeNull();
    }),
  ));

test("a returning Google sign-in gets a session for the same account", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* signUpTestUser("bob");
      const idToken = yield* Effect.promise(() =>
        mintGoogleIdToken({ sub: googleSubFor("bob") }),
      );
      const session = yield* c.users.loginGoogle({ payload: { idToken } });
      if ("needsUsername" in session) throw new Error("expected a session");
      expect(session.user.id).toBe(created.user.id);
      expect(session.authMethod).toBe("google");
      expect(decodeClaims(session.accessToken).type).toBe("access");
      expect(decodeClaims(session.refreshToken).type).toBe("refresh");
    }),
  ));

test('loginGoogle rejects an expired token, a wrong audience or issuer, and a tampered signature, incrementing auth_events_total{event="google_login",outcome="failure"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* signUpTestUser("carol");
      const sub = googleSubFor("carol");
      const now = Math.floor(Date.now() / 1000);
      const genuine = yield* Effect.promise(() => mintGoogleIdToken({ sub }));
      const [header, body, signature] = genuine.split(".");
      // Same header and signature, but a payload claiming another account.
      const forgedBody = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(body!, "base64url").toString()),
          sub: "someone-else",
        }),
      ).toString("base64url");
      const rejected = {
        expired: yield* Effect.promise(() =>
          mintGoogleIdToken({ sub, exp: now - 60 }),
        ),
        "wrong aud": yield* Effect.promise(() =>
          mintGoogleIdToken({
            sub,
            aud: "another-app.apps.googleusercontent.com",
          }),
        ),
        "wrong iss": yield* Effect.promise(() =>
          mintGoogleIdToken({ sub, iss: "https://evil.example" }),
        ),
        "tampered payload": `${header}.${forgedBody}.${signature}`,
        "tampered signature": `${header}.${body}.${signature!.slice(0, -4)}AAAA`,
        "not a jwt": "not-a-token",
      };
      const before = yield* authEventCount("google_login", "failure");
      for (const [label, idToken] of Object.entries(rejected)) {
        const result = yield* c.users
          .loginGoogle({ payload: { idToken } })
          .pipe(Effect.flip);
        expect(result._tag, label).toBe("InvalidCredentials");
      }
      expect(yield* authEventCount("google_login", "failure")).toBe(
        before + Object.keys(rejected).length,
      );
      // Both spellings of Google's issuer are genuine.
      for (const iss of [
        "accounts.google.com",
        "https://accounts.google.com",
      ]) {
        const idToken = yield* Effect.promise(() =>
          mintGoogleIdToken({ sub, iss }),
        );
        const session = yield* c.users.loginGoogle({ payload: { idToken } });
        expect("user" in session, iss).toBe(true);
      }
    }),
  ));

test("registerGoogle rejects an expired, forged or wrong-kind pending token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const pendingToken = yield* pendingTokenFor("google-dora");
      // Tokens of the other kinds, from a password login so this test's
      // registerGoogle calls stay within the per-IP signup budget.
      yield* createAdmin("someone", "s3cret-pw");
      const session = yield* c.users.login({
        payload: { username: "someone", password: "s3cret-pw" },
      });
      const [header, body, signature] = pendingToken.split(".");
      const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
      const reencode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const rejected = {
        // Re-signed claims can't be produced without the server's secret, so
        // these keep the original signature over edited claims.
        "edited exp": `${header}.${reencode({ ...claims, exp: 1 })}.${signature}`,
        "forged sub": `${header}.${reencode({ ...claims, googleSub: "x" })}.${signature}`,
        "an access token": session.accessToken,
        "a refresh token": session.refreshToken,
        garbage: "garbage",
      };
      const before = yield* authEventCount("google_signup", "failure");
      for (const [label, token] of Object.entries(rejected)) {
        const result = yield* c.users
          .registerGoogle({
            payload: { pendingToken: token, username: "dora" },
          })
          .pipe(Effect.flip);
        expect(result._tag, label).toBe("InvalidCredentials");
      }
      expect(yield* authEventCount("google_signup", "failure")).toBe(
        before + Object.keys(rejected).length,
      );
    }),
  ));

test("a pending token stops working after its ten minutes", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const realNow = Date.now;
      const pendingToken = yield* pendingTokenFor("google-late");
      try {
        Date.now = () => realNow() + 10 * 60 * 1000 + 1000;
        const result = yield* c.users
          .registerGoogle({ payload: { pendingToken, username: "late" } })
          .pipe(Effect.flip);
        expect(result._tag).toBe("InvalidCredentials");
      } finally {
        Date.now = realNow;
      }
    }),
  ));

test("a pending token is no access token", () =>
  run(
    Effect.gen(function* () {
      const pendingToken = yield* pendingTokenFor("google-sneaky");
      const authed = yield* makeAuthedClient(pendingToken);
      const result = yield* authed.users
        .searchUsers({ query: { q: "abc" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test('registerGoogle with a taken username returns a 409 conflict, case-insensitively, incrementing auth_events_total{event="google_signup",outcome="failure"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* signUpTestUser("Dave");
      const pendingToken = yield* pendingTokenFor("google-other-dave");
      const before = yield* authEventCount("google_signup", "failure");
      for (const username of ["Dave", "dave"]) {
        const result = yield* c.users
          .registerGoogle({ payload: { pendingToken, username } })
          .pipe(Effect.flip);
        expect(result._tag).toBe("UsernameTaken");
        expect((result as { message: string }).message).toContain(username);
      }
      expect(yield* authEventCount("google_signup", "failure")).toBe(
        before + 2,
      );
      // The pending token is still good for a free name.
      const session = yield* c.users.registerGoogle({
        payload: { pendingToken, username: "dave2" },
      });
      expect(session.user.username).toBe("dave2");
    }),
  ));

test("a pending token can't create a second account for the same Google account", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const pendingToken = yield* pendingTokenFor("google-twice");
      yield* c.users.registerGoogle({
        payload: { pendingToken, username: "first" },
      });
      const result = yield* c.users
        .registerGoogle({ payload: { pendingToken, username: "second" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
    }),
  ));

test('registerGoogle is rate-limited per IP, incrementing rate_limit_rejections_total{limiter="register"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const before = yield* rateLimitRejectionCount("register");
      // REGISTER_MAX_ATTEMPTS_PER_IP = 5 (UsersHandler.ts). Every call in
      // this in-process test harness resolves to the same "unknown" IP (no
      // real socket/remoteAddress), so they all land in one bucket.
      for (let i = 0; i < 5; i++) yield* signUpTestUser(`ratelimited-${i}`);
      const pendingToken = yield* pendingTokenFor("google-tripped");
      const result = yield* c.users
        .registerGoogle({
          payload: { pendingToken, username: "ratelimited-tripped" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("TooManyRequests");
      expect(yield* rateLimitRejectionCount("register")).toBe(before + 1);
    }),
  ));

test('loginGoogle is rate-limited per IP, incrementing rate_limit_rejections_total{limiter="google-login"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const before = yield* rateLimitRejectionCount("google-login");
      // GOOGLE_LOGIN_MAX_ATTEMPTS_PER_IP = 20 — failed attempts count too.
      for (let i = 0; i < 20; i++) {
        yield* c.users
          .loginGoogle({ payload: { idToken: "not-a-token" } })
          .pipe(Effect.flip);
      }
      const idToken = yield* Effect.promise(() =>
        mintGoogleIdToken({ sub: "google-limited" }),
      );
      const result = yield* c.users
        .loginGoogle({ payload: { idToken } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("TooManyRequests");
      expect(yield* rateLimitRejectionCount("google-login")).toBe(before + 1);
    }),
  ));

test("registerGoogle rejects a username over the maximum length or under the minimum", () =>
  run(
    Effect.gen(function* () {
      const pendingToken = yield* pendingTokenFor("google-lengths");
      for (const username of [
        "a".repeat(MAX_USERNAME_LENGTH + 1),
        "a".repeat(MIN_USERNAME_LENGTH - 1),
      ]) {
        const { status } = yield* postRaw("/users/register/google", {
          pendingToken,
          username,
        });
        expect(status, username).toBe(400);
      }
      // Exactly the minimum is fine.
      const { status } = yield* postRaw("/users/register/google", {
        pendingToken,
        username: "a".repeat(MIN_USERNAME_LENGTH),
      });
      expect(status).toBe(201);
    }),
  ));

test("registerGoogle rejects usernames outside the @mention character set (issue #493)", () =>
  run(
    Effect.gen(function* () {
      const pendingToken = yield* pendingTokenFor("google-charset");
      for (const username of [
        "bad name 😀", // the issue's example: a space and an emoji
        "with space",
        "emoji😀",
        "at@sign",
        "аlice", // Cyrillic "а" — a look-alike of "alice"
        "bidi‮name", // right-to-left override
        "zero​width",
        "trailing.",
        "trailing-",
      ]) {
        const { status, body } = yield* postRaw("/users/register/google", {
          pendingToken,
          username,
        });
        expect(status, username).toBe(400);
        expect(body).toContain("may only contain letters");
      }

      // Everything the mention parser accepts as a whole name still works
      // (one per Google account — each gets a single account).
      for (const username of ["Bob_99", "j.doe", "x-y_z", ".dot"]) {
        const { status } = yield* postRaw("/users/register/google", {
          pendingToken: yield* pendingTokenFor(`google-${username}`),
          username,
        });
        expect(status, username).toBe(201);
      }
    }),
  ));

test("every username USERNAME_PATTERN accepts parses back whole as a mention", () => {
  for (const username of ["alice", "Bob_99", "j.doe", "x-y_z", ".dot", "a.-_"])
    expect(extractMentionedUsernames(`hi @${username} there`)).toEqual([
      username.toLowerCase(),
    ]);
  // And the names it rejects for trailing punctuation are exactly the ones
  // the parser would cut short.
  for (const username of ["trailing.", "trailing-"]) {
    expect(USERNAME_PATTERN.test(username)).toBe(false);
    expect(extractMentionedUsernames(`@${username}`)).not.toEqual([username]);
  }
});

test("every registrable username is long enough to be found by people search", () => {
  // Issue #483: a non-admin can't run a people search shorter than
  // MIN_USER_SEARCH_QUERY_LENGTH, so a shorter username would be unfindable.
  expect(MIN_USERNAME_LENGTH).toBeGreaterThanOrEqual(
    MIN_USER_SEARCH_QUERY_LENGTH,
  );
});

test("there is no password signup endpoint", () =>
  run(
    Effect.gen(function* () {
      const { status } = yield* postRaw("/users/register", {
        username: "sneaky",
        password: "s3cret-pw",
      });
      expect(status).toBe(404);
    }),
  ));

test("getAuthConfig exposes the Google client id", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      expect(yield* c.users.getAuthConfig()).toEqual({
        googleClientId: GOOGLE_TEST_CLIENT_ID,
      });
    }),
  ));

test("createAdminAccount makes an admin that signs in with its password, and enforces the signup rules", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const db = yield* Db;
      yield* createAdmin("rootadmin", "s3cret-pw");
      const session = yield* c.users.login({
        payload: { username: "rootadmin", password: "s3cret-pw" },
      });
      expect(session.user.role).toBe("admin");
      expect(session.authMethod).toBe("password");

      for (const [username, password] of [
        ["rootadmin", "another-pw"], // taken
        ["ROOTADMIN", "another-pw"], // taken, case-insensitively
        ["ab", "another-pw"], // too short
        ["bad name", "another-pw"], // outside the charset
        ["okname", "a".repeat(MIN_PASSWORD_LENGTH - 1)],
        ["okname", "a".repeat(MAX_PASSWORD_LENGTH + 1)],
      ] as const) {
        const error = yield* Effect.promise(() =>
          createAdminAccount(db, username, password).then(
            () => null,
            (e: unknown) => e,
          ),
        );
        expect(error, `${username}/${password.length}`).toBeInstanceOf(
          AdminAccountError,
        );
      }
    }),
  ));

test("resetAdminPassword changes the password and signs every session out", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const db = yield* Db;
      yield* createAdmin("resetme", "old-password");
      const session = yield* c.users.login({
        payload: { username: "resetme", password: "old-password" },
      });

      yield* Effect.promise(() =>
        resetAdminPassword(db, "resetme", "new-password"),
      );

      const oldLogin = yield* c.users
        .login({ payload: { username: "resetme", password: "old-password" } })
        .pipe(Effect.flip);
      expect(oldLogin._tag).toBe("InvalidCredentials");
      yield* c.users.login({
        payload: { username: "resetme", password: "new-password" },
      });
      // The refresh token from before the reset is gone, and the access
      // token carries a stale token_version.
      const refreshed = yield* c.users
        .refresh({ payload: { refreshToken: session.refreshToken } })
        .pipe(Effect.flip);
      expect(refreshed._tag).toBe("InvalidCredentials");

      // Only an admin's password is reset.
      yield* signUpTestUser("notadmin");
      const error = yield* Effect.promise(() =>
        resetAdminPassword(db, "notadmin", "new-password").then(
          () => null,
          (e: unknown) => e,
        ),
      );
      expect(error).toBeInstanceOf(AdminAccountError);
    }),
  ));

test("changePassword rejects a new password under the minimum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("xena", "pw-xena12");
      const { accessToken } = yield* c.users.login({
        payload: { username: "xena", password: "pw-xena12" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users
        .changePassword({
          payload: {
            currentPassword: "pw-xena12",
            newPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1),
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("changePassword is refused for a Google account, which has no password", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("googler");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .changePassword({
          payload: {
            currentPassword: "anything-at-all",
            newPassword: "new-password-1",
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
    }),
  ));

test("searchUsers returns matching users, case-insensitively, without password data", () =>
  run(
    Effect.gen(function* () {
      yield* signUpTestUser("alexander");
      yield* signUpTestUser("alexina");
      const { accessToken } = yield* signUpTestUser("bob");

      const authed = yield* makeAuthedClient(accessToken);
      const results = yield* authed.users.searchUsers({
        query: { q: "ALEX" },
      });
      expect(results).toHaveLength(2);
      expect(results.map((u) => u.username)).toEqual(["alexander", "alexina"]);
      expect(results.every((u) => !("passwordHash" in u))).toBe(true);
    }),
  ));

test("searchUsers rejects a non-admin's query shorter than the minimum length", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("cesar");

      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .searchUsers({ query: { q: "ce" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidUserSearchRequest");
    }),
  ));

test("searchUsers lets an admin browse the full directory with a query shorter than the minimum length, including empty", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const passwordHash = yield* Effect.tryPromise(() =>
        Bun.password.hash("pw-adminnora", { algorithm: "argon2id" }),
      );
      yield* Effect.tryPromise(() =>
        db
          .insert(users)
          .values({ username: "adminnora", passwordHash, role: "admin" })
          .returning(),
      );
      const c = yield* makeClient;
      yield* signUpTestUser("nolan");
      const { accessToken } = yield* c.users.login({
        payload: { username: "adminnora", password: "pw-adminnora" },
      });

      const authed = yield* makeAuthedClient(accessToken);
      const shortQueryResults = yield* authed.users.searchUsers({
        query: { q: "no" },
      });
      expect(shortQueryResults.map((u) => u.username).sort()).toEqual([
        "adminnora",
        "nolan",
      ]);

      const emptyQueryResults = yield* authed.users.searchUsers({
        query: { q: "" },
      });
      expect(emptyQueryResults.map((u) => u.username).sort()).toEqual([
        "adminnora",
        "nolan",
      ]);
    }),
  ));

test("searchUsers rejects a query longer than the maximum length", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("cyrus");

      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users
        .searchUsers({
          query: { q: "c".repeat(MAX_USER_SEARCH_QUERY_LENGTH + 1) },
        })
        .pipe(Effect.flip);
    }),
  ));

test("searchUsers returns no results for a query that matches nobody", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("dahlia");

      const authed = yield* makeAuthedClient(accessToken);
      const results = yield* authed.users.searchUsers({
        query: { q: "zzzzz" },
      });
      expect(results).toEqual([]);
    }),
  ));

test("lookupUsersByUsername rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .lookupUsersByUsername({ query: { usernames: "alice" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("lookupUsersByUsername resolves a batch of names case-insensitively, skipping the ones that don't exist", () =>
  run(
    Effect.gen(function* () {
      yield* signUpTestUser("Mira");
      const { accessToken } = yield* signUpTestUser("quinn");

      const authed = yield* makeAuthedClient(accessToken);
      const results = yield* authed.users.lookupUsersByUsername({
        // "mira" differs in case from the stored "Mira"; "nobody" has no
        // account at all and is simply absent from the response.
        query: { usernames: "mira,nobody,QUINN" },
      });
      expect(results.map((u) => u.username)).toEqual(["Mira", "quinn"]);
      expect(results.every((u) => !("passwordHash" in u))).toBe(true);
    }),
  ));

test("lookupUsersByUsername ignores blank and duplicate names", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("rowan");

      const authed = yield* makeAuthedClient(accessToken);
      const results = yield* authed.users.lookupUsersByUsername({
        query: { usernames: "rowan , ,rowan," },
      });
      expect(results.map((u) => u.username)).toEqual(["rowan"]);

      // An entirely empty batch is a no-op rather than an error, so a
      // caller needn't special-case content with no mentions in it.
      const empty = yield* authed.users.lookupUsersByUsername({
        query: { usernames: "" },
      });
      expect(empty).toEqual([]);
    }),
  ));

test("lookupUsersByUsername rejects a batch naming more than the maximum number of users", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("sasha");

      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .lookupUsersByUsername({
          query: {
            usernames: Array.from(
              { length: MAX_USERNAME_LOOKUP_COUNT + 1 },
              (_, i) => `u${i}`,
            ).join(","),
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidUsernameLookupRequest");
    }),
  ));

test("lookupUsersByUsername rejects a parameter longer than the maximum length", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("tobias");

      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users
        .lookupUsersByUsername({
          query: {
            usernames: "t".repeat(MAX_USERNAME_LOOKUP_LENGTH + 1),
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("getUser rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { user: created } = yield* signUpTestUser("carol");
      const result = yield* c.users
        .getUser({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("getUser returns the correct user after registration", () =>
  run(
    Effect.gen(function* () {
      const { user: created, accessToken } = yield* signUpTestUser("carol");
      const authed = yield* makeAuthedClient(accessToken);
      const fetched = yield* authed.users.getUser({
        params: { id: created.id },
      });
      expect(fetched).toEqual({ ...created, bio: null });
    }),
  ));

test("getUser returns 404 for a missing id", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("dave");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .getUser({ params: { id: 9999 } })
        .pipe(Effect.flip);
      expect((result as { message: string }).message).toContain("9999");
    }),
  ));

test("listUserPosts rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { user: created } = yield* signUpTestUser("erin");
      const result = yield* c.users
        .listUserPosts({ params: { id: created.id }, query: {} })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("listUserPosts returns 404 for a missing id", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("frank");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .listUserPosts({ params: { id: 9999 }, query: {} })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("listUserPosts returns only the target user's posts, newest-first, with a total count", () =>
  run(
    Effect.gen(function* () {
      const { user: author, accessToken: authorToken } =
        yield* signUpTestUser("grace");
      const authorClient = yield* makeAuthedClient(authorToken);

      const { accessToken: otherToken } = yield* signUpTestUser("henry");
      const otherClient = yield* makeAuthedClient(otherToken);
      yield* otherClient.posts.createPost({
        payload: { contentType: "text", content: "not grace's post" },
      });

      const created = [];
      for (let i = 0; i < 3; i++) {
        created.push(
          yield* authorClient.posts.createPost({
            payload: { contentType: "text", content: `grace post ${i}` },
          }),
        );
      }
      const newestFirst = [...created].reverse();

      const result = yield* otherClient.users.listUserPosts({
        params: { id: author.id },
        query: {},
      });
      expect(result.totalCount).toBe(3);
      expect(result.nextCursor).toBeNull();
      expect(result.posts.map((p) => p.id)).toEqual(
        newestFirst.map((p) => p.id),
      );
      expect(result.posts.every((p) => p.authorId === author.id)).toBe(true);
    }),
  ));

test("listUserPosts paginates newest-first with a keyset cursor", () =>
  run(
    Effect.gen(function* () {
      const { user: author, accessToken } = yield* signUpTestUser("iris");
      const authed = yield* makeAuthedClient(accessToken);
      const created = [];
      for (let i = 0; i < 3; i++) {
        created.push(
          yield* authed.posts.createPost({
            payload: { contentType: "text", content: `post ${i}` },
          }),
        );
      }
      const newestFirst = [...created].reverse();

      const firstPage = yield* authed.users.listUserPosts({
        params: { id: author.id },
        query: { limit: 2 },
      });
      expect(firstPage.totalCount).toBe(3);
      expect(firstPage.nextCursor).not.toBeNull();
      expect(firstPage.posts.map((p) => p.id)).toEqual(
        newestFirst.slice(0, 2).map((p) => p.id),
      );

      const secondPage = yield* authed.users.listUserPosts({
        params: { id: author.id },
        query: { limit: 2, cursor: firstPage.nextCursor! },
      });
      expect(secondPage.totalCount).toBe(3);
      expect(secondPage.nextCursor).toBeNull();
      expect(secondPage.posts.map((p) => p.id)).toEqual(
        newestFirst.slice(2, 3).map((p) => p.id),
      );
    }),
  ));

test("listUserPosts rejects a malformed cursor", () =>
  run(
    Effect.gen(function* () {
      const { user: author, accessToken } = yield* signUpTestUser("jack");
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .listUserPosts({
          params: { id: author.id },
          query: { cursor: "not-a-real-cursor" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidPostsRequest");
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

test('login succeeds for an admin and returns the user plus signed access and refresh JWTs, incrementing auth_events_total{event="login",outcome="success"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { id } = yield* createAdmin("erin", "correct-horse");
      const before = yield* authEventCount("login", "success");
      const { user, accessToken, refreshToken, authMethod } =
        yield* c.users.login({
          payload: { username: "erin", password: "correct-horse" },
        });
      expect(yield* authEventCount("login", "success")).toBe(before + 1);
      expect(user.id).toBe(id);
      expect(user.username).toBe("erin");
      expect(authMethod).toBe("password");

      const access = decodeClaims(accessToken);
      const refresh = decodeClaims(refreshToken);

      for (const claims of [access, refresh]) {
        expect(claims.sub).toBe(id);
        expect(claims.username).toBe("erin");
        expect(claims.role).toBe("admin");
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

test("login refuses a Google account and a non-admin password account exactly like a wrong password", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* signUpTestUser("googleonly");
      // A password account that isn't (or is no longer) an admin.
      yield* insertPasswordUser("demoted", "s3cret-pw", "user");
      yield* createAdmin("realadmin", "s3cret-pw");

      const before = yield* authEventCount("login", "failure");
      const refusals = [];
      for (const [username, password] of [
        ["googleonly", "s3cret-pw"],
        ["demoted", "s3cret-pw"], // the right password, but not an admin
        ["realadmin", "wrong-pw"],
        ["ghost", "s3cret-pw"], // no such account
      ] as const) {
        const result = yield* c.users
          .login({ payload: { username, password } })
          .pipe(Effect.flip);
        expect(result._tag, username).toBe("InvalidCredentials");
        refusals.push((result as { message: string }).message);
      }
      // Nothing tells the cases apart.
      expect(new Set(refusals).size).toBe(1);
      expect(yield* authEventCount("login", "failure")).toBe(before + 4);
    }),
  ));

test("login accepts a pre-existing admin whose password predates the minimum length", () =>
  run(
    Effect.gen(function* () {
      // Simulates an account created before MIN_PASSWORD_LENGTH existed —
      // inserted directly, since scripts/create-admin.ts enforces the
      // minimum.
      yield* insertPasswordUser("legacyuser", "short1", "admin");
      const c = yield* makeClient;
      const { user } = yield* c.users.login({
        payload: { username: "legacyuser", password: "short1" },
      });
      expect(user.username).toBe("legacyuser");
    }),
  ));

test("login accepts a pre-existing admin whose username predates the minimum length or the charset rule", () =>
  run(
    Effect.gen(function* () {
      // Inserted directly, since no signup path accepts these names anymore.
      const c = yield* makeClient;
      for (const username of ["jo", "legacy name 😀"]) {
        yield* insertPasswordUser(username, "pw-legacy1", "admin");
        const { user } = yield* c.users.login({
          payload: { username, password: "pw-legacy1" },
        });
        expect(user.username).toBe(username);
      }
    }),
  ));

test("login succeeds regardless of the casing used, matching the admin account", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("Isabel", "pw-isabel1");
      const { user } = yield* c.users.login({
        payload: { username: "isabel", password: "pw-isabel1" },
      });
      expect(user.username).toBe("Isabel");
    }),
  ));

test('refresh exchanges a valid refresh token for a new, working access token, incrementing auth_events_total{event="refresh",outcome="success"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { refreshToken } = yield* signUpTestUser("hana");

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
        query: { q: "hana" },
      });
      expect(results.map((u) => u.username)).toContain("hana");
    }),
  ));

test("refresh rotates the refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { refreshToken } = yield* signUpTestUser("ivan");

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
      const { refreshToken } = yield* signUpTestUser("kate");

      yield* c.users.refresh({ payload: { refreshToken } });

      // The old token is signature- and expiry-valid, but its store row was
      // marked revoked on rotation, so re-presenting it must be rejected.
      const result = yield* c.users
        .refresh({ payload: { refreshToken } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
    }),
  ));

test("replaying a rotated-away refresh token revokes the whole family, including the token it was rotated to", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { refreshToken } = yield* signUpTestUser("nora");

      // Simulates theft: someone rotates the token first (the legitimate
      // client, in the normal case), then the original (now stale) token
      // gets replayed — e.g. by whoever stole it before the rotation.
      const rotated = yield* c.users.refresh({ payload: { refreshToken } });
      const reuse = yield* c.users
        .refresh({ payload: { refreshToken } })
        .pipe(Effect.flip);
      expect(reuse._tag).toBe("InvalidCredentials");

      // The replay must have poisoned the whole family: even the token the
      // legitimate client rotated to (and never leaked) is now revoked, so
      // both parties are forced to log back in rather than the thief simply
      // getting rejected while the legitimate session carries on unaware.
      const afterReuse = yield* c.users
        .refresh({ payload: { refreshToken: rotated.refreshToken } })
        .pipe(Effect.flip);
      expect(afterReuse._tag).toBe("InvalidCredentials");
    }),
  ));

test("two concurrent refreshes with the same token can't both succeed, and the race revokes the family (issue #650)", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { refreshToken } = yield* signUpTestUser("nell");

      // Both requests read the row as unrevoked before either writes. This
      // is a thief replaying a stolen token at the same moment the victim's
      // client refreshes.
      const results = yield* Effect.all(
        [
          c.users.refresh({ payload: { refreshToken } }).pipe(Effect.result),
          c.users.refresh({ payload: { refreshToken } }).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const winners = results.filter((r) => r._tag === "Success");
      expect(winners).toHaveLength(1);

      // The session didn't fork: whatever the winner got was revoked with
      // the rest of the family when the loser was caught.
      const winner = winners[0]!;
      if (winner._tag !== "Success") throw new Error("unreachable");
      const after = yield* c.users
        .refresh({ payload: { refreshToken: winner.success.refreshToken } })
        .pipe(Effect.flip);
      expect(after._tag).toBe("InvalidCredentials");
    }),
  ));

test("two concurrent login sessions each rotate independently", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* signUpTestUser("liam");
      const sessionA = yield* signInTestUser("liam");
      const sessionB = yield* signInTestUser("liam");

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
      const { accessToken } = yield* signUpTestUser("jack");

      const result = yield* c.users
        .refresh({ payload: { refreshToken: accessToken } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
    }),
  ));

test('refresh rejects a bogus refresh token, incrementing auth_events_total{event="refresh",outcome="failure"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const before = yield* authEventCount("refresh", "failure");
      const result = yield* c.users
        .refresh({ payload: { refreshToken: "not-a-real-token" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
      expect(yield* authEventCount("refresh", "failure")).toBe(before + 1);
    }),
  ));

test("logout revokes the presented refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { refreshToken } = yield* signUpTestUser("maya");

      yield* c.users.logout({ payload: { refreshToken } });

      const result = yield* c.users
        .refresh({ payload: { refreshToken } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
    }),
  ));

test("logout only revokes the presented session, leaving others intact", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* signUpTestUser("noah");
      const sessionA = yield* signInTestUser("noah");
      const sessionB = yield* signInTestUser("noah");

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
      yield* signUpTestUser("olga");
      const sessionA = yield* signInTestUser("olga");
      const sessionB = yield* signInTestUser("olga");

      yield* c.users.logout({
        payload: { refreshToken: sessionA.refreshToken, allSessions: true },
      });

      for (const refreshToken of [
        sessionA.refreshToken,
        sessionB.refreshToken,
      ]) {
        yield* c.users.refresh({ payload: { refreshToken } }).pipe(Effect.flip);
      }
    }),
  ));

test("logout with allSessions immediately invalidates outstanding access tokens, not just refresh tokens", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { accessToken, refreshToken } = yield* signUpTestUser("petra");

      // Sanity check: the access token works before the forced logout.
      const authedBefore = yield* makeAuthedClient(accessToken);
      yield* authedBefore.users.searchUsers({ query: { q: "petra" } });

      yield* c.users.logout({
        payload: { refreshToken, allSessions: true },
      });

      // Still well within its own 15-minute TTL, but token_version has been
      // bumped, so it must be rejected immediately rather than surviving to
      // its own expiry.
      const authedAfter = yield* makeAuthedClient(accessToken);
      const result = yield* authedAfter.users
        .searchUsers({ query: { q: "petra" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("a fresh login after a forced logout still works", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { refreshToken } = yield* signUpTestUser("quinn");
      yield* c.users.logout({
        payload: { refreshToken, allSessions: true },
      });

      const { accessToken } = yield* signInTestUser("quinn");
      const authed = yield* makeAuthedClient(accessToken);
      const results = yield* authed.users.searchUsers({
        query: { q: "quinn" },
      });
      expect(results.map((u) => u.username)).toContain("quinn");
    }),
  ));

test("refresh rejects a token signed under a token_version invalidated by a forced logout", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* signUpTestUser("ravi");
      const sessionA = yield* signInTestUser("ravi");
      const sessionB = yield* signInTestUser("ravi");

      yield* c.users.logout({
        payload: { refreshToken: sessionA.refreshToken, allSessions: true },
      });

      // sessionB's refresh token row is deleted by the forced logout too, so
      // this already fails on the store lookup — but it now also carries a
      // stale token_version, which must independently be rejected.
      const result = yield* c.users
        .refresh({ payload: { refreshToken: sessionB.refreshToken } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
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
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("changePassword rejects a wrong current password", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("sam", "pw-sam12");
      const { accessToken } = yield* c.users.login({
        payload: { username: "sam", password: "pw-sam12" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .changePassword({
          payload: { currentPassword: "wrong-pw", newPassword: "new-pw-sam" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
    }),
  ));

test("changePassword updates the password and lets the caller log in with the new one", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("tara", "old-pw-tara");
      const { accessToken } = yield* c.users.login({
        payload: { username: "tara", password: "old-pw-tara" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users.changePassword({
        payload: { currentPassword: "old-pw-tara", newPassword: "new-pw-tara" },
      });

      yield* c.users
        .login({ payload: { username: "tara", password: "old-pw-tara" } })
        .pipe(Effect.flip);

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
      yield* createAdmin("uma", "old-pw-uma");
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
      yield* authed.users
        .searchUsers({ query: { q: "uma" } })
        .pipe(Effect.flip);

      // ...but the freshly issued one works.
      const authedAfter = yield* makeAuthedClient(newAccessToken);
      const results = yield* authedAfter.users.searchUsers({
        query: { q: "uma" },
      });
      expect(results.map((u) => u.username)).toContain("uma");
    }),
  ));

test("changePassword revokes every other session's refresh token", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("vince", "old-pw-vince");
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

      yield* c.users
        .refresh({ payload: { refreshToken: sessionB.refreshToken } })
        .pipe(Effect.flip);
    }),
  ));

test("changePassword is rate-limited per account after repeated wrong attempts", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("wendy", "pw-wendy123");
      const { accessToken } = yield* c.users.login({
        payload: { username: "wendy", password: "pw-wendy123" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      // CHANGE_PASSWORD_MAX_ATTEMPTS_PER_ACCOUNT is 5 (UsersHandler.ts).
      for (let i = 0; i < 5; i++) {
        yield* authed.users
          .changePassword({
            payload: { currentPassword: "wrong-pw", newPassword: "new-pw12" },
          })
          .pipe(Effect.flip);
      }
      const result = yield* authed.users
        .changePassword({
          payload: { currentPassword: "wrong-pw", newPassword: "new-pw12" },
        })
        .pipe(Effect.flip);
      const left = result as {
        _tag: string;
        retryAfterSeconds: number;
      };
      expect(left._tag).toBe("TooManyRequests");
      expect(left.retryAfterSeconds).toBeGreaterThan(0);
    }),
  ));

test("login is rate-limited per account after repeated attempts, independent of whether the account exists", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      // LOGIN_MAX_FAILURES_PER_ACCOUNT_AND_IP is 5, well below the per-IP cap
      // of 20, so this trips the per-account bucket first. The username need not
      // belong to a real account — the bucket is keyed on the submitted
      // username regardless, so a nonexistent account can't be used to
      // bypass the limit.
      for (let i = 0; i < 5; i++) {
        const attempt = yield* c.users
          .login({ payload: { username: "ghost-account", password: "wrong" } })
          .pipe(Effect.flip);
        expect(attempt._tag).toBe("InvalidCredentials");
      }
      const result = yield* c.users
        .login({ payload: { username: "ghost-account", password: "wrong" } })
        .pipe(Effect.flip);
      const left = result as {
        _tag: string;
        retryAfterSeconds: number;
      };
      expect(left._tag).toBe("TooManyRequests");
      expect(left.retryAfterSeconds).toBeGreaterThan(0);
    }),
  ));

test("successful logins don't count toward the per-account login limit", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("multidevice", "pw-multi");
      // Well past the 5-failure account bucket (but under the per-IP cap of
      // 20): someone signing in on several devices must never be locked out.
      for (let i = 0; i < 10; i++) {
        const session = yield* c.users.login({
          payload: { username: "multidevice", password: "pw-multi" },
        });
        expect(session.user.username).toBe("multidevice");
      }
    }),
  ));

test("a successful login clears the account's earlier failed attempts", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("typo-prone", "pw-right");
      const fail = c.users
        .login({ payload: { username: "typo-prone", password: "pw-wrong" } })
        .pipe(Effect.flip);
      for (let i = 0; i < 4; i++) {
        expect((yield* fail)._tag).toBe("InvalidCredentials");
      }
      yield* c.users.login({
        payload: { username: "typo-prone", password: "pw-right" },
      });
      // The four failures above were forgiven by the success, so a fresh
      // run of four more still isn't rate-limited.
      for (let i = 0; i < 4; i++) {
        expect((yield* fail)._tag).toBe("InvalidCredentials");
      }
    }),
  ));

test("concurrent wrong-password logins can't race past the per-account limit", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("raced", "pw-raced");
      // Issue #543: the account buckets used to be checked up front but only
      // consumed after the (slow) password check, so every concurrent guess
      // passed the check and reached verification. Under the per-IP cap of
      // 20, LOGIN_MAX_FAILURES_PER_ACCOUNT_AND_IP (5) must still hold.
      const results = yield* Effect.all(
        Array.from({ length: 15 }, () =>
          c.users
            .login({ payload: { username: "raced", password: "pw-wrong" } })
            .pipe(Effect.flip),
        ),
        { concurrency: "unbounded" },
      );
      const tags = results.map((r) => r._tag);
      const invalid = tags.filter((t) => t === "InvalidCredentials").length;
      expect(invalid).toBeLessThanOrEqual(5);
      expect(tags.filter((t) => t === "TooManyRequests").length).toBe(
        15 - invalid,
      );
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
          .pipe(Effect.ignore);
      }
      const result = yield* c.users
        .refresh({ payload: { refreshToken: "not-a-real-token" } })
        .pipe(Effect.flip);
      const left = result as {
        _tag: string;
        retryAfterSeconds: number;
      };
      expect(left._tag).toBe("TooManyRequests");
      expect(left.retryAfterSeconds).toBeGreaterThan(0);
    }),
  ));

test("authentication token version check is cached for 5 seconds and respects expiration", () =>
  run(
    Effect.gen(function* () {
      const { user, accessToken } = yield* signUpTestUser("cachetest");

      const authed = yield* makeAuthedClient(accessToken);

      // 1. First request: should succeed and populate cache.
      const firstResult = yield* authed.users.getUser({
        params: { id: user.id },
      });
      expect(firstResult.username).toBe("cachetest");

      // 2. Directly bump tokenVersion in the database behind the scenes (bypassing invalidation).
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, user.id)),
      ).pipe(Effect.orDie);

      // 3. Second request: within the cache TTL (5s), it should STILL succeed since cache hasn't expired.
      const secondResult = yield* authed.users.getUser({
        params: { id: user.id },
      });
      expect(secondResult.username).toBe("cachetest");

      // 4. Sleep for 6 seconds to let the cache entry expire.
      yield* Effect.sleep(Duration.seconds(6));

      // 5. Third request: after cache expiration, it must fetch from DB, find the bumped version (1 !== 0), and reject as Unauthorized.
      const thirdResult = yield* authed.users
        .getUser({ params: { id: user.id } })
        .pipe(Effect.flip);
      expect(thirdResult._tag).toBe("Unauthorized");
    }),
  ));

test("authentication token version cache is immediately evicted via PubSub invalidation events", () =>
  run(
    Effect.gen(function* () {
      const { user, accessToken } = yield* signUpTestUser("pubsubtest");

      const authed = yield* makeAuthedClient(accessToken);

      // 1. First request: should succeed and populate cache.
      const firstResult = yield* authed.users.getUser({
        params: { id: user.id },
      });
      expect(firstResult.username).toBe("pubsubtest");

      // 2. Directly bump tokenVersion in the database behind the scenes (bypassing invalidation).
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, user.id)),
      ).pipe(Effect.orDie);

      // 3. Publish an invalidation event over PubSub.
      const pubsub = yield* PubSub;
      yield* pubsub.publish("auth:invalidation", String(user.id));

      // 4. Second request: even within 5 seconds, it should fail immediately because the cache was evicted by the PubSub event.
      const secondResult = yield* authed.users
        .getUser({ params: { id: user.id } })
        .pipe(Effect.flip);
      expect(secondResult._tag).toBe("Unauthorized");
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
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("updateProfile updates displayName and avatarUrl, reflected by getUser, without changing username", () =>
  run(
    Effect.gen(function* () {
      const { user: created, accessToken } = yield* signUpTestUser("xander");
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
        bio: null,
      });

      const fetched = yield* authed.users.getUser({
        params: { id: created.id },
      });
      expect(fetched).toEqual(updated);
    }),
  ));

test("updateProfile rejects a displayName over the maximum length", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("victor");
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users
        .updateProfile({
          payload: {
            displayName: "a".repeat(MAX_DISPLAY_NAME_LENGTH + 1),
            avatarUrl: null,
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("updateProfile rejects an avatarUrl on a disallowed host", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("ulysses");
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users
        .updateProfile({
          payload: {
            displayName: null,
            avatarUrl: "https://evil.example.com/avatar.png",
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("updateProfile clears displayName and avatarUrl when set to null after being set", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("tobias");
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

test("updateProfile sets a bio, shown to other users by getUser", () =>
  run(
    Effect.gen(function* () {
      const { user: created } = yield* signUpTestUser("beatrix");
      yield* signUpTestUser("viewer");
      const { accessToken } = yield* signInTestUser("beatrix");
      const authed = yield* makeAuthedClient(accessToken);

      const updated = yield* authed.users.updateProfile({
        payload: {
          displayName: null,
          avatarUrl: null,
          bio: "Coffee, climbing\nand compilers.",
        },
      });
      expect(updated.bio).toBe("Coffee, climbing\nand compilers.");

      const viewerLogin = yield* signInTestUser("viewer");
      const viewer = yield* makeAuthedClient(viewerLogin.accessToken);
      const fetched = yield* viewer.users.getUser({
        params: { id: created.id },
      });
      expect(fetched.bio).toBe("Coffee, climbing\nand compilers.");
    }),
  ));

test("updateProfile keeps the bio when it's omitted and clears it on null", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("cornelia");
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users.updateProfile({
        payload: { displayName: null, avatarUrl: null, bio: "Hi there" },
      });
      // A client that predates the field sends no `bio` — that mustn't wipe it.
      const kept = yield* authed.users.updateProfile({
        payload: { displayName: "Cornelia", avatarUrl: null },
      });
      expect(kept.displayName).toBe("Cornelia");
      expect(kept.bio).toBe("Hi there");

      const cleared = yield* authed.users.updateProfile({
        payload: { displayName: "Cornelia", avatarUrl: null, bio: null },
      });
      expect(cleared.bio).toBeNull();
    }),
  ));

test("updateProfile rejects a bio over the maximum length or blank", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("desmond");
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users
        .updateProfile({
          payload: {
            displayName: null,
            avatarUrl: null,
            bio: "a".repeat(MAX_BIO_LENGTH + 1),
          },
        })
        .pipe(Effect.flip);
      yield* authed.users
        .updateProfile({
          payload: { displayName: null, avatarUrl: null, bio: "" },
        })
        .pipe(Effect.flip);
      // Exactly at the cap is fine.
      const atCap = yield* authed.users.updateProfile({
        payload: {
          displayName: null,
          avatarUrl: null,
          bio: "a".repeat(MAX_BIO_LENGTH),
        },
      });
      expect(atCap.bio).toHaveLength(MAX_BIO_LENGTH);
    }),
  ));

test("deleteAccount rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.users
        .deleteAccount({ payload: { password: "whatever" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("deleteAccount rejects a wrong password", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("susan", "pw-susan12");
      const { accessToken } = yield* c.users.login({
        payload: { username: "susan", password: "pw-susan12" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      const result = yield* authed.users
        .deleteAccount({ payload: { password: "wrong-pw" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
    }),
  ));

test("deleteAccount lets an admin password account confirm with its password", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* createAdmin("leaving", "pw-leaving1");
      const { accessToken } = yield* c.users.login({
        payload: { username: "leaving", password: "pw-leaving1" },
      });
      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users.deleteAccount({
        payload: { password: "pw-leaving1" },
      });
      const result = yield* c.users
        .login({ payload: { username: "leaving", password: "pw-leaving1" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
    }),
  ));

test("deleteAccount refuses a Google account confirming with a password, another Google account's token, or a stale token", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("careful");
      yield* signUpTestUser("bystander");
      const authed = yield* makeAuthedClient(accessToken);
      const sub = googleSubFor("careful");
      const now = Math.floor(Date.now() / 1000);
      // Still unexpired, but signed in an hour-long token's middle age —
      // re-confirming needs a sign-in made just now.
      const stale = yield* Effect.promise(() =>
        mintGoogleIdToken({ sub, iat: now - 10 * 60 }),
      );
      for (const [label, payload] of [
        ["a password", { password: "anything-at-all" }],
        [
          "someone else's token",
          { idToken: yield* googleIdTokenFor("bystander") },
        ],
        ["a stale token", { idToken: stale }],
        ["garbage", { idToken: "garbage" }],
      ] as const) {
        const result = yield* authed.users
          .deleteAccount({ payload })
          .pipe(Effect.flip);
        expect(result._tag, label).toBe("InvalidCredentials");
      }
      // Still there.
      const me = yield* authed.users.getUser({
        params: { id: decodeClaims(accessToken).sub },
      });
      expect(me.username).toBe("careful");
    }),
  ));

test("deleteAccount removes a Google account after a fresh Google sign-in, cascading to its posts — signing in again starts over", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { user: created, accessToken } = yield* signUpTestUser("ronny");
      const authed = yield* makeAuthedClient(accessToken);
      const post = yield* authed.posts.createPost({
        payload: { contentType: "text", content: "hello world" },
      });

      yield* authed.users.deleteAccount({
        payload: { idToken: yield* googleIdTokenFor("ronny") },
      });

      // The Google account is a stranger again: no session, just the
      // username step.
      const again = yield* c.users.loginGoogle({
        payload: { idToken: yield* googleIdTokenFor("ronny") },
      });
      expect("needsUsername" in again).toBe(true);

      // A fresh user to look up the now-deleted account/post through.
      const { accessToken: otherToken } = yield* signUpTestUser("sabrina");
      const otherAuthed = yield* makeAuthedClient(otherToken);

      const getUserResult = yield* otherAuthed.users
        .getUser({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(getUserResult._tag).toBe("NotFound");

      const getPostResult = yield* otherAuthed.posts
        .getPost({ params: { id: post.id } })
        .pipe(Effect.flip);
      expect(getPostResult._tag).toBe("NotFound");
    }),
  ));

test("deleteAccount immediately invalidates the caller's own outstanding tokens elsewhere", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const sessionA = yield* signUpTestUser("quincy");
      const sessionB = yield* signInTestUser("quincy");

      const authedA = yield* makeAuthedClient(sessionA.accessToken);
      yield* authedA.users.deleteAccount({
        payload: { idToken: yield* googleIdTokenFor("quincy") },
      });

      yield* c.users
        .refresh({ payload: { refreshToken: sessionB.refreshToken } })
        .pipe(Effect.flip);
    }),
  ));

test("deleteAccount is rate-limited per account after repeated wrong attempts", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("percy");
      const authed = yield* makeAuthedClient(accessToken);
      // DELETE_ACCOUNT_MAX_ATTEMPTS_PER_ACCOUNT is 5 (UsersHandler.ts).
      for (let i = 0; i < 5; i++) {
        yield* authed.users
          .deleteAccount({ payload: { idToken: "wrong-token" } })
          .pipe(Effect.flip);
      }
      const result = yield* authed.users
        .deleteAccount({
          payload: { idToken: yield* googleIdTokenFor("percy") },
        })
        .pipe(Effect.flip);
      const left = result as {
        _tag: string;
        retryAfterSeconds: number;
      };
      expect(left._tag).toBe("TooManyRequests");
      expect(left.retryAfterSeconds).toBeGreaterThan(0);
    }),
  ));

test("updateUserRole rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { user: created } = yield* signUpTestUser("opal");
      const result = yield* c.users
        .updateUserRole({
          params: { id: created.id },
          payload: { role: "admin" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("updateUserRole rejects a non-admin caller with Forbidden", () =>
  run(
    Effect.gen(function* () {
      const { user: target } = yield* signUpTestUser("nadia");
      const { accessToken } = yield* signUpTestUser("myron");
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .updateUserRole({
          params: { id: target.id },
          payload: { role: "admin" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
    }),
  ));

test("updateUserRole returns 404 for a missing target user", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
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
        .updateUserRole({ params: { id: 999999 }, payload: { role: "admin" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("updateUserRole promotes a user to admin, immediately invalidating their outstanding token and taking effect on their next login", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
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
      const { user: target } = yield* signUpTestUser("louise");
      const targetSession = yield* signInTestUser("louise");

      const { accessToken: adminToken } = yield* c.users.login({
        payload: { username: "adminkarl", password: "pw-admin456" },
      });
      const adminAuthed = yield* makeAuthedClient(adminToken);

      const updated = yield* adminAuthed.users.updateUserRole({
        params: { id: target.id },
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
        .getUser({ params: { id: target.id } })
        .pipe(Effect.flip);
      expect(staleResult._tag).toBe("Unauthorized");

      // A fresh login reflects the new role.
      const { user: reloggedUser } = yield* signInTestUser("louise");
      expect(reloggedUser.role).toBe("admin");
    }),
  ));

test("deleteUser rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { user: created } = yield* signUpTestUser("unauthtarget");
      const result = yield* c.users
        .deleteUser({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("deleteUser rejects a non-admin caller with Forbidden", () =>
  run(
    Effect.gen(function* () {
      const { user: target } = yield* signUpTestUser("victim1");
      const { accessToken } = yield* signUpTestUser("regular1");
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .deleteUser({ params: { id: target.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");

      // The target still exists — the rejected call was a no-op.
      const stillThere = yield* authed.users.getUser({
        params: { id: target.id },
      });
      expect(stillThere.id).toBe(target.id);
    }),
  ));

test("deleteUser returns 404 for a missing target user", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const passwordHash = yield* Effect.tryPromise(() =>
        Bun.password.hash("pw-admin123", { algorithm: "argon2id" }),
      );
      yield* Effect.tryPromise(() =>
        db
          .insert(users)
          .values({ username: "adminmona", passwordHash, role: "admin" })
          .returning(),
      );
      const c = yield* makeClient;
      const { accessToken } = yield* c.users.login({
        payload: { username: "adminmona", password: "pw-admin123" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .deleteUser({ params: { id: 999999 } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("deleteUser rejects an admin deleting their own account with Forbidden", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const passwordHash = yield* Effect.tryPromise(() =>
        Bun.password.hash("pw-admin123", { algorithm: "argon2id" }),
      );
      const inserted = yield* Effect.tryPromise(() =>
        db
          .insert(users)
          .values({ username: "adminself", passwordHash, role: "admin" })
          .returning(),
      );
      const adminId = inserted[0]!.id;
      const c = yield* makeClient;
      const { accessToken } = yield* c.users.login({
        payload: { username: "adminself", password: "pw-admin123" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const result = yield* authed.users
        .deleteUser({ params: { id: adminId } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");

      // The admin's own account is untouched.
      const stillThere = yield* authed.users.getUser({
        params: { id: adminId },
      });
      expect(stillThere.id).toBe(adminId);
    }),
  ));

test("deleteUser removes the target, cascading to its posts, and invalidates its outstanding token", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const adminPasswordHash = yield* Effect.tryPromise(() =>
        Bun.password.hash("pw-admin456", { algorithm: "argon2id" }),
      );
      yield* Effect.tryPromise(() =>
        db
          .insert(users)
          .values({
            username: "adminpat",
            passwordHash: adminPasswordHash,
            role: "admin",
          })
          .returning(),
      );

      const c = yield* makeClient;
      const { user: target } = yield* signUpTestUser("doomed1");
      const targetSession = yield* signInTestUser("doomed1");
      const targetAuthed = yield* makeAuthedClient(targetSession.accessToken);
      const post = yield* targetAuthed.posts.createPost({
        payload: { contentType: "text", content: "about to be deleted" },
      });

      const { accessToken: adminToken } = yield* c.users.login({
        payload: { username: "adminpat", password: "pw-admin456" },
      });
      const adminAuthed = yield* makeAuthedClient(adminToken);

      yield* adminAuthed.users.deleteUser({ params: { id: target.id } });

      // The account and its post are gone.
      const getUserResult = yield* adminAuthed.users
        .getUser({ params: { id: target.id } })
        .pipe(Effect.flip);
      expect(getUserResult._tag).toBe("NotFound");

      const getPostResult = yield* adminAuthed.posts
        .getPost({ params: { id: post.id } })
        .pipe(Effect.flip);
      expect(getPostResult._tag).toBe("NotFound");

      // The target's already-issued access token is rejected immediately.
      const staleResult = yield* targetAuthed.users
        .getUser({ params: { id: target.id } })
        .pipe(Effect.flip);
      expect(staleResult._tag).toBe("Unauthorized");

      // The target's refresh token no longer works either, and signing in
      // with their Google account again finds no account.
      yield* c.users
        .refresh({ payload: { refreshToken: targetSession.refreshToken } })
        .pipe(Effect.flip);

      const again = yield* c.users.loginGoogle({
        payload: { idToken: yield* googleIdTokenFor("doomed1") },
      });
      expect("needsUsername" in again).toBe(true);
    }),
  ));

test("updateStatus sets and clears statusText/statusEmoji, reflected by getUser", () =>
  run(
    Effect.gen(function* () {
      const { user: created, accessToken } = yield* signUpTestUser("stella");
      const authed = yield* makeAuthedClient(accessToken);

      const updated = yield* authed.users.updateStatus({
        payload: { statusText: "In a meeting", statusEmoji: "📅" },
      });
      expect(updated.statusText).toBe("In a meeting");
      expect(updated.statusEmoji).toBe("📅");
      expect(updated.statusExpiresAt).toBeNull();

      const fetched = yield* authed.users.getUser({
        params: { id: created.id },
      });
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
      const { accessToken } = yield* signUpTestUser("tobias");
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
      const { accessToken } = yield* signUpTestUser("ursula");
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users
        .updateStatus({
          payload: {
            statusText: "a".repeat(MAX_STATUS_TEXT_LENGTH + 1),
            statusEmoji: null,
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("updateStatus rejects a statusEmoji over the maximum length", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("vance");
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users
        .updateStatus({
          payload: {
            statusText: null,
            statusEmoji: "e".repeat(MAX_STATUS_EMOJI_LENGTH + 1),
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("updateStatus rejects expiresInMinutes when clearing the status", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* signUpTestUser("wendy");
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users
        .updateStatus({
          payload: {
            statusText: null,
            statusEmoji: null,
            expiresInMinutes: 30,
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("a status past its expiry reads back as null everywhere", () =>
  run(
    Effect.gen(function* () {
      const { user: created, accessToken } = yield* signUpTestUser("xena");
      const authed = yield* makeAuthedClient(accessToken);

      yield* authed.users.updateStatus({
        payload: { statusText: "Vacationing", statusEmoji: "🏖️" },
      });

      // Directly backdate the expiry behind the scenes (bypassing the
      // endpoint's `expiresInMinutes` floor of 1) to simulate one that has
      // since elapsed.
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db
          .update(users)
          .set({ statusExpiresAt: new Date(Date.now() - 1_000) })
          .where(eq(users.id, created.id)),
      ).pipe(Effect.orDie);

      const fetched = yield* authed.users.getUser({
        params: { id: created.id },
      });
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
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

// Registers a stand-in `/ws` connection for `userId` and reports how many
// times it was closed — the handlers below must close a user's sockets
// wherever they bump token_version (issue #651). The connection lives on its
// own RealtimeConnectionsLive sharing the run's PubSub, i.e. on another
// replica than the one handling the request.
const openSocket = (userId: number) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub;
    const connections = yield* Effect.service(RealtimeConnections).pipe(
      Effect.provide(
        RealtimeConnectionsLive.pipe(
          Layer.provide(Layer.succeed(PubSub, pubsub)),
          Layer.provide(InMemoryPresenceStoreLive),
          Layer.provide(staticPresenceAudience([])),
        ),
      ),
    );
    const state = { closed: 0 };
    yield* connections.register(
      userId,
      () => Effect.void,
      Effect.sync(() => {
        state.closed++;
      }),
    );
    return state;
  });

const insertAdmin = (username: string, password: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const passwordHash = yield* Effect.tryPromise(() =>
      Bun.password.hash(password, { algorithm: "argon2id" }),
    );
    yield* Effect.tryPromise(() =>
      db.insert(users).values({ username, passwordHash, role: "admin" }),
    );
    const c = yield* makeClient;
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return yield* makeAuthedClient(accessToken);
  });

test("logout with allSessions closes the user's open sockets, and only theirs", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { user: me } = yield* signUpTestUser("wsrevoke1");
      const { user: other } = yield* signUpTestUser("wsrevoke2");
      const { refreshToken } = yield* signInTestUser("wsrevoke1");
      const tabA = yield* openSocket(me.id);
      const tabB = yield* openSocket(me.id);
      const theirs = yield* openSocket(other.id);

      yield* c.users.logout({ payload: { refreshToken, allSessions: true } });

      expect(tabA.closed).toBe(1);
      expect(tabB.closed).toBe(1);
      expect(theirs.closed).toBe(0);
    }),
  ));

test("a single-session logout leaves the user's other sockets open", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const { user: me, refreshToken } = yield* signUpTestUser("wsrevoke3");
      const tab = yield* openSocket(me.id);

      yield* c.users.logout({ payload: { refreshToken } });

      expect(tab.closed).toBe(0);
    }),
  ));

test("changePassword closes the user's open sockets", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const me = yield* createAdmin("wsrevoke4", "pw-wsrevoke4");
      const { accessToken } = yield* c.users.login({
        payload: { username: "wsrevoke4", password: "pw-wsrevoke4" },
      });
      const tab = yield* openSocket(me.id);

      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users.changePassword({
        payload: {
          currentPassword: "pw-wsrevoke4",
          newPassword: "pw-wsrevoke4-new",
        },
      });

      expect(tab.closed).toBe(1);
    }),
  ));

test("deleteAccount closes the user's open sockets", () =>
  run(
    Effect.gen(function* () {
      const { user: me, accessToken } = yield* signUpTestUser("wsrevoke5");
      const tab = yield* openSocket(me.id);

      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users.deleteAccount({
        payload: { idToken: yield* googleIdTokenFor("wsrevoke5") },
      });

      expect(tab.closed).toBe(1);
    }),
  ));

test("an admin's role change or deletion closes the target's open sockets", () =>
  run(
    Effect.gen(function* () {
      const admin = yield* insertAdmin("wsrevokeadmin", "pw-wsrevokeadmin");
      const { user: target } = yield* signUpTestUser("wsrevoke6");

      const beforeRoleChange = yield* openSocket(target.id);
      yield* admin.users.updateUserRole({
        params: { id: target.id },
        payload: { role: "admin" },
      });
      expect(beforeRoleChange.closed).toBe(1);

      const beforeDeletion = yield* openSocket(target.id);
      yield* admin.users.deleteUser({ params: { id: target.id } });
      expect(beforeDeletion.closed).toBe(1);
    }),
  ));
