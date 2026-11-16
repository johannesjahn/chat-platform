import { expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import { MIN_PASSWORD_LENGTH } from "../Api.ts";
import { Db } from "../Db.ts";
import { PubSub } from "../PubSub.ts";
import { users } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { makeTestRun } from "../testApi.ts";
import {
  makeClient,
  authEventCount,
  makeAuthedClient,
  decodeClaims,
  openSocket,
} from "./testKit.ts";

const run = makeTestRun();

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
        query: { q: "hana" },
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
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
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
      yield* c.users.register({
        payload: { username: "nell", password: "pw-nell1" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "nell", password: "pw-nell1" },
      });

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
      yield* c.users.register({
        payload: { username: "maya", password: "pw-maya1" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "maya", password: "pw-maya1" },
      });

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
        yield* c.users.refresh({ payload: { refreshToken } }).pipe(Effect.flip);
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
        query: { q: "quinn" },
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
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidCredentials");
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

      yield* c.users
        .refresh({ payload: { refreshToken: sessionB.refreshToken } })
        .pipe(Effect.flip);
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
      // CHANGE_PASSWORD_MAX_ATTEMPTS_PER_ACCOUNT is 5 (users/authHandlers.ts).
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

// A short TTL of its own, so the test can watch an entry expire without
// waiting out production's (see TokenVersionCacheTtl in Auth.ts).
const runShortTtl = makeTestRun({
  tokenVersionCacheTtl: Duration.seconds(1),
});

test("authentication token version check is cached for its TTL and respects expiration", () =>
  runShortTtl(
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
        params: { id: user.id },
      });
      expect(firstResult.username).toBe("cachetest");

      // 2. Directly bump tokenVersion in the database behind the scenes (bypassing invalidation).
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, user.id)),
      ).pipe(Effect.orDie);

      // 3. Second request: within the cache TTL, it should STILL succeed since cache hasn't expired.
      const secondResult = yield* authed.users.getUser({
        params: { id: user.id },
      });
      expect(secondResult.username).toBe("cachetest");

      // 4. Sleep past the TTL to let the cache entry expire.
      yield* Effect.sleep(Duration.seconds(2));

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

test("logout with allSessions closes the user's open sockets, and only theirs", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const me = yield* c.users.register({
        payload: { username: "wsrevoke1", password: "pw-wsrevoke1" },
      });
      const other = yield* c.users.register({
        payload: { username: "wsrevoke2", password: "pw-wsrevoke2" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "wsrevoke1", password: "pw-wsrevoke1" },
      });
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
      const me = yield* c.users.register({
        payload: { username: "wsrevoke3", password: "pw-wsrevoke3" },
      });
      const { refreshToken } = yield* c.users.login({
        payload: { username: "wsrevoke3", password: "pw-wsrevoke3" },
      });
      const tab = yield* openSocket(me.id);

      yield* c.users.logout({ payload: { refreshToken } });

      expect(tab.closed).toBe(0);
    }),
  ));

test("changePassword closes the user's open sockets", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const me = yield* c.users.register({
        payload: { username: "wsrevoke4", password: "pw-wsrevoke4" },
      });
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
