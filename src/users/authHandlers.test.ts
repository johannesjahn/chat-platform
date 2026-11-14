import { expect, setSystemTime, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Effect, Metric } from "effect";
import {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USER_SEARCH_QUERY_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_PATTERN,
} from "../Api.ts";
import { extractMentionedUsernames } from "../notifications.ts";
import { Db } from "../Db.ts";
import { rateLimitRejectionsTotal } from "../Metrics.ts";
import { users } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { makeTestRun } from "../testApi.ts";
import { makeClient, authEventCount, decodeClaims } from "./testKit.ts";

const run = makeTestRun();

const rateLimitRejectionCount = (limiter: string) =>
  Metric.value(
    Metric.withAttributes(rateLimitRejectionsTotal, { limiter: limiter }),
  ).pipe(Effect.map((state) => state.count));

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
      yield* c.users
        .register({
          payload: {
            username: "a".repeat(MAX_USERNAME_LENGTH + 1),
            password: "s3cret-pw",
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("register rejects a username under the minimum length", () =>
  run(
    Effect.gen(function* () {
      // Sent raw: the typed client would reject the payload itself, before
      // it ever reached the server's validation.
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        HttpClientRequest.post("http://localhost/users/register").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            username: "a".repeat(MIN_USERNAME_LENGTH - 1),
            password: "s3cret-pw",
          }),
        ),
      );
      expect(response.status).toBe(400);
      // Exactly the minimum is fine.
      const c = yield* makeClient;
      const user = yield* c.users.register({
        payload: {
          username: "a".repeat(MIN_USERNAME_LENGTH),
          password: "s3cret-pw",
        },
      });
      expect(user.username).toBe("a".repeat(MIN_USERNAME_LENGTH));
    }),
  ));

test("register rejects usernames outside the @mention character set (issue #493)", () =>
  run(
    Effect.gen(function* () {
      // Sent raw, like the minimum-length test above, so the server's own
      // validation is what's exercised.
      const http = yield* HttpClient.HttpClient;
      const register = (username: string) =>
        http
          .execute(
            HttpClientRequest.post("http://localhost/users/register").pipe(
              HttpClientRequest.bodyJsonUnsafe({
                username,
                password: "s3cret-pw",
              }),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              response.text.pipe(
                Effect.map((body) => ({ status: response.status, body })),
              ),
            ),
          );

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
        const { status, body } = yield* register(username);
        expect(status, username).toBe(400);
        expect(body).toContain("may only contain letters");
      }

      // Everything the mention parser accepts as a whole name still works.
      for (const username of ["alice", "Bob_99", "j.doe", "x-y_z", ".dot"]) {
        const { status } = yield* register(username);
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

test("a username created before the charset rule can still log in (issue #493)", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      // Register a valid name, then rename it in the database to one the
      // new rule rejects — standing in for an account that predates it.
      const user = yield* c.users.register({
        payload: { username: "legacy", password: "s3cret-pw" },
      });
      const db = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(users)
          .set({ username: "legacy name 😀" })
          .where(eq(users.id, user.id)),
      );
      const session = yield* c.users.login({
        payload: { username: "legacy name 😀", password: "s3cret-pw" },
      });
      expect(session.user.username).toBe("legacy name 😀");
    }),
  ));

test("every registrable username is long enough to be found by people search", () => {
  // Issue #483: a non-admin can't run a people search shorter than
  // MIN_USER_SEARCH_QUERY_LENGTH, so a shorter username would be unfindable.
  expect(MIN_USERNAME_LENGTH).toBeGreaterThanOrEqual(
    MIN_USER_SEARCH_QUERY_LENGTH,
  );
});

test("register rejects a password over the maximum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users
        .register({
          payload: {
            username: "alice2",
            password: "a".repeat(MAX_PASSWORD_LENGTH + 1),
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("register rejects a password under the minimum length", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users
        .register({
          payload: {
            username: "alice3",
            password: "a".repeat(MIN_PASSWORD_LENGTH - 1),
          },
        })
        .pipe(Effect.flip);
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

test('register is rate-limited per IP, incrementing rate_limit_rejections_total{limiter="register"}', () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const before = yield* rateLimitRejectionCount("register");
      // REGISTER_BURST_MAX_ATTEMPTS_PER_IP = 10 per minute
      // (users/authHandlers.ts). Every call in this in-process test harness
      // resolves to the same "unknown" IP (no real socket/remoteAddress), so
      // they all land in one bucket.
      for (let i = 0; i < 10; i++) {
        yield* c.users.register({
          payload: { username: `ratelimited-${i}`, password: "pw-testpass" },
        });
      }
      const result = yield* c.users
        .register({
          payload: { username: "ratelimited-tripped", password: "pw-testpass" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("TooManyRequests");
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
        .pipe(Effect.flip);
      expect((result as { message: string }).message).toContain("dave");
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
        .pipe(Effect.flip);
      expect((result as { message: string }).message).toContain("bob");
    }),
  ));

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
      const db = yield* Db;
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

test("login accepts a pre-existing account whose username predates the minimum length", () =>
  run(
    Effect.gen(function* () {
      // Like the short-password case above: inserted directly, since the
      // register endpoint no longer accepts a name this short.
      const db = yield* Db;
      const passwordHash = yield* Effect.tryPromise(() =>
        Bun.password.hash("pw-legacy1", { algorithm: "argon2id" }),
      );
      yield* Effect.tryPromise(() =>
        db.insert(users).values({ username: "jo", passwordHash }).returning(),
      );

      const c = yield* makeClient;
      const { user } = yield* c.users.login({
        payload: { username: "jo", password: "pw-legacy1" },
      });
      expect(user.username).toBe("jo");
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
      yield* c.users
        .login({ payload: { username: "frank", password: "wrong-pw" } })
        .pipe(Effect.flip);
      expect(yield* authEventCount("login", "failure")).toBe(before + 1);
    }),
  ));

test("login fails for an unknown username", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users
        .login({ payload: { username: "ghost", password: "whatever" } })
        .pipe(Effect.flip);
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

test("register allows a shared network's worth of sign-ups per hour, but caps both bursts and the hourly total per IP", async () => {
  // Issue #767: a class onboarding together behind one address used to hit
  // REGISTER_MAX_ATTEMPTS_PER_IP (then 5/hour). Now 50/hour is allowed, at
  // most REGISTER_BURST_MAX_ATTEMPTS_PER_IP (10) per minute. The harness has
  // no real socket, so every call shares one "unknown" IP bucket; the
  // in-memory limiter reads Date.now(), so the clock is stepped past each
  // burst window.
  let now = Date.now();
  setSystemTime(new Date(now));
  try {
    await run(
      Effect.gen(function* () {
        const c = yield* makeClient;
        const register = (username: string) =>
          c.users.register({ payload: { username, password: "pw-register" } });
        const expectLimited = (username: string) =>
          Effect.gen(function* () {
            const left = (yield* register(username).pipe(Effect.flip)) as {
              _tag: string;
              retryAfterSeconds: number;
            };
            expect(left._tag).toBe("TooManyRequests");
            expect(left.retryAfterSeconds).toBeGreaterThan(0);
          });

        for (let burst = 0; burst < 5; burst++) {
          for (let i = 0; i < 10; i++) {
            yield* register(`reguser${burst}x${i}`);
          }
          // An 11th sign-up within the same minute is a burst too many.
          yield* expectLimited(`regburst${burst}`);
          now += 61_000;
          setSystemTime(new Date(now));
        }
        // 50 accounts in five minutes: the hourly ceiling is spent, even
        // though the burst window has rolled over.
        yield* expectLimited("reguser-over-hourly");
      }),
    );
  } finally {
    setSystemTime();
  }
});

test("login is rate-limited per account after repeated attempts, independent of whether the account exists", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      // LOGIN_MAX_FAILURES_PER_ACCOUNT_AND_IP is 5, well below the per-IP cap
      // of 50, so this trips the per-account bucket first. The username need not
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
      yield* c.users.register({
        payload: { username: "multidevice", password: "pw-multi" },
      });
      // Well past the 5-failure account bucket: someone signing in on several devices must never be locked out.
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
      yield* c.users.register({
        payload: { username: "typo-prone", password: "pw-right" },
      });
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

test(
  "successful logins don't count toward the per-IP login limit, but failures still do",
  () =>
    run(
      Effect.gen(function* () {
        const c = yield* makeClient;
        const db = yield* Db;
        // Issue #767: everyone behind one public address (a school, an
        // office, CGNAT) shares the per-IP bucket. The harness resolves every
        // call to the same "unknown" IP, so 50 people signing in to their own
        // accounts here is exactly that, well past the old cap of 20
        // attempts. Accounts are inserted directly (sharing one hash) rather
        // than registered, which would trip register's own per-IP limits.
        const passwordHash = yield* Effect.promise(() =>
          Bun.password.hash("pw-shared-net", { algorithm: "argon2id" }),
        );
        const accounts = Array.from({ length: 50 }, (_, i) => `campus${i}`);
        yield* Effect.tryPromise(() =>
          db
            .insert(users)
            .values(accounts.map((username) => ({ username, passwordHash }))),
        ).pipe(Effect.orDie);
        for (const username of accounts) {
          const session = yield* c.users.login({
            payload: { username, password: "pw-shared-net" },
          });
          expect(session.user.username).toBe(username);
        }

        // Failures still count: LOGIN_MAX_FAILURES_PER_IP is 50. Each guess
        // targets a different account, so the per-account buckets never trip
        // and only the IP bucket can stop this spray.
        for (const username of accounts) {
          const attempt = yield* c.users
            .login({ payload: { username, password: "wrong" } })
            .pipe(Effect.flip);
          expect(attempt._tag).toBe("InvalidCredentials");
        }
        const left = (yield* c.users
          .login({ payload: { username: "campus-extra", password: "wrong" } })
          .pipe(Effect.flip)) as { _tag: string; retryAfterSeconds: number };
        expect(left._tag).toBe("TooManyRequests");
        expect(left.retryAfterSeconds).toBeGreaterThan(0);
      }),
    ),
  // About 100 real argon2id verifications — CPU-bound, so on a busy CI
  // runner (parallel files, coverage) they alone can pass the suite-wide 15s.
  60_000,
);

test("concurrent wrong-password logins can't race past the per-account limit", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "raced", password: "pw-raced" },
      });
      // Issue #543: the account buckets used to be checked up front but only
      // consumed after the (slow) password check, so every concurrent guess
      // passed the check and reached verification. Under the per-IP cap of
      // 50, LOGIN_MAX_FAILURES_PER_ACCOUNT_AND_IP (5) must still hold.
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
