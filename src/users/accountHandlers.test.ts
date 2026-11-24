import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Db } from "../Db.ts";
import { users } from "../db/schema.ts";
import { makeTestRun } from "../testApi.ts";
import { makeClient, makeAuthedClient, openSocket } from "./testKit.ts";

const run = makeTestRun();

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
      yield* c.users.register({
        payload: { username: "susan", password: "pw-susan12" },
      });
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
        payload: { body: "hello world" },
      });

      yield* authed.users.deleteAccount({
        payload: { password: "pw-ronny12" },
      });

      yield* c.users
        .login({ payload: { username: "ronny", password: "pw-ronny12" } })
        .pipe(Effect.flip);

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

      yield* c.users
        .refresh({ payload: { refreshToken: sessionB.refreshToken } })
        .pipe(Effect.flip);
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
      // DELETE_ACCOUNT_MAX_ATTEMPTS_PER_ACCOUNT is 5
      // (users/accountHandlers.ts).
      for (let i = 0; i < 5; i++) {
        yield* authed.users
          .deleteAccount({ payload: { password: "wrong-pw" } })
          .pipe(Effect.flip);
      }
      const result = yield* authed.users
        .deleteAccount({ payload: { password: "wrong-pw" } })
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
      const created = yield* c.users.register({
        payload: { username: "opal", password: "pw-opal123" },
      });
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
      const { user: reloggedUser } = yield* c.users.login({
        payload: { username: "louise", password: "pw-louise1" },
      });
      expect(reloggedUser.role).toBe("admin");
    }),
  ));

test("deleteUser rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "unauthtarget", password: "pw-target12" },
      });
      const result = yield* c.users
        .deleteUser({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("deleteUser rejects a non-admin caller with Forbidden", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const target = yield* c.users.register({
        payload: { username: "victim1", password: "pw-victim12" },
      });
      yield* c.users.register({
        payload: { username: "regular1", password: "pw-regular1" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "regular1", password: "pw-regular1" },
      });
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
      const target = yield* c.users.register({
        payload: { username: "doomed1", password: "pw-doomed12" },
      });
      const targetSession = yield* c.users.login({
        payload: { username: "doomed1", password: "pw-doomed12" },
      });
      const targetAuthed = yield* makeAuthedClient(targetSession.accessToken);
      const post = yield* targetAuthed.posts.createPost({
        payload: { body: "about to be deleted" },
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

      // The target's refresh token no longer works either, and they can't
      // log back in.
      yield* c.users
        .refresh({ payload: { refreshToken: targetSession.refreshToken } })
        .pipe(Effect.flip);

      yield* c.users
        .login({ payload: { username: "doomed1", password: "pw-doomed12" } })
        .pipe(Effect.flip);
    }),
  ));

test("deleteAccount closes the user's open sockets", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const me = yield* c.users.register({
        payload: { username: "wsrevoke5", password: "pw-wsrevoke5" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "wsrevoke5", password: "pw-wsrevoke5" },
      });
      const tab = yield* openSocket(me.id);

      const authed = yield* makeAuthedClient(accessToken);
      yield* authed.users.deleteAccount({
        payload: { password: "pw-wsrevoke5" },
      });

      expect(tab.closed).toBe(1);
    }),
  ));

test("an admin's role change or deletion closes the target's open sockets", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const admin = yield* insertAdmin("wsrevokeadmin", "pw-wsrevokeadmin");
      const target = yield* c.users.register({
        payload: { username: "wsrevoke6", password: "pw-wsrevoke6" },
      });

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
