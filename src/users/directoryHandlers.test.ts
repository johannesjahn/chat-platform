import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  MAX_USER_SEARCH_QUERY_LENGTH,
  MAX_USERNAME_LOOKUP_COUNT,
  MAX_USERNAME_LOOKUP_LENGTH,
} from "../Api.ts";
import { Db } from "../Db.ts";
import { users } from "../db/schema.ts";
import { makeTestRun } from "../testApi.ts";
import { makeClient, makeAuthedClient } from "./testKit.ts";

const run = makeTestRun();

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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "cesar", password: "pw-cesar" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "cesar", password: "pw-cesar" },
      });

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
      yield* c.users.register({
        payload: { username: "nolan", password: "pw-nolan123" },
      });
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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "cyrus", password: "pw-cyrus" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "cyrus", password: "pw-cyrus" },
      });

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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "dahlia", password: "pw-dahlia" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "dahlia", password: "pw-dahlia" },
      });

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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "Mira", password: "pw-mira123" },
      });
      yield* c.users.register({
        payload: { username: "quinn", password: "pw-quinn123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "quinn", password: "pw-quinn123" },
      });

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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "rowan", password: "pw-rowan123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "rowan", password: "pw-rowan123" },
      });

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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "sasha", password: "pw-sasha123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "sasha", password: "pw-sasha123" },
      });

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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "tobias", password: "pw-tobias123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "tobias", password: "pw-tobias123" },
      });

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
      const created = yield* c.users.register({
        payload: { username: "carol", password: "pw-carol" },
      });
      const result = yield* c.users
        .getUser({ params: { id: created.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
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
      const fetched = yield* authed.users.getUser({
        params: { id: created.id },
      });
      expect(fetched).toEqual({ ...created, bio: null });
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
        .getUser({ params: { id: 9999 } })
        .pipe(Effect.flip);
      expect((result as { message: string }).message).toContain("9999");
    }),
  ));

test("listUserPosts rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "erin", password: "pw-erin1" },
      });
      const result = yield* c.users
        .listUserPosts({ params: { id: created.id }, query: {} })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Unauthorized");
    }),
  ));

test("listUserPosts returns 404 for a missing id", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "frank", password: "pw-frank1" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "frank", password: "pw-frank1" },
      });
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
      const c = yield* makeClient;
      const author = yield* c.users.register({
        payload: { username: "grace", password: "pw-grace1" },
      });
      const { accessToken: authorToken } = yield* c.users.login({
        payload: { username: "grace", password: "pw-grace1" },
      });
      const authorClient = yield* makeAuthedClient(authorToken);

      yield* c.users.register({
        payload: { username: "henry", password: "pw-henry1" },
      });
      const { accessToken: otherToken } = yield* c.users.login({
        payload: { username: "henry", password: "pw-henry1" },
      });
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
      const c = yield* makeClient;
      const author = yield* c.users.register({
        payload: { username: "iris", password: "pw-iris01" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "iris", password: "pw-iris01" },
      });
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
      const c = yield* makeClient;
      const author = yield* c.users.register({
        payload: { username: "jack", password: "pw-jack01" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "jack", password: "pw-jack01" },
      });
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
