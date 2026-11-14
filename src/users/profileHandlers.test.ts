import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  MAX_BIO_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_STATUS_EMOJI_LENGTH,
  MAX_STATUS_TEXT_LENGTH,
} from "../Api.ts";
import { Db } from "../Db.ts";
import { users } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { makeTestRun } from "../testApi.ts";
import { makeClient, makeAuthedClient } from "./testKit.ts";

const run = makeTestRun();

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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "victor", password: "pw-victor" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "victor", password: "pw-victor" },
      });
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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "ulysses", password: "pw-ulysses" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "ulysses", password: "pw-ulysses" },
      });
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

test("updateProfile sets a bio, shown to other users by getUser", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const created = yield* c.users.register({
        payload: { username: "beatrix", password: "pw-beatrix" },
      });
      yield* c.users.register({
        payload: { username: "viewer", password: "pw-viewer" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "beatrix", password: "pw-beatrix" },
      });
      const authed = yield* makeAuthedClient(accessToken);

      const updated = yield* authed.users.updateProfile({
        payload: {
          displayName: null,
          avatarUrl: null,
          bio: "Coffee, climbing\nand compilers.",
        },
      });
      expect(updated.bio).toBe("Coffee, climbing\nand compilers.");

      const viewerLogin = yield* c.users.login({
        payload: { username: "viewer", password: "pw-viewer" },
      });
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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "cornelia", password: "pw-cornelia" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "cornelia", password: "pw-cornelia" },
      });
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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "desmond", password: "pw-desmond" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "desmond", password: "pw-desmond" },
      });
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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "vance", password: "pw-vance123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "vance", password: "pw-vance123" },
      });
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
      const c = yield* makeClient;
      yield* c.users.register({
        payload: { username: "wendy", password: "pw-wendy123" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "wendy", password: "pw-wendy123" },
      });
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
