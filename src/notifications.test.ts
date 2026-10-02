import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { Db } from "./Db.ts";
import { gameLobbies, gameResults } from "./db/schema.ts";
import { makeTestRun } from "./testApi.ts";

// Same shape as games.test.ts's harness: `effect` also gets `Db` directly,
// sharing the API layer's in-memory instance, so a test can fast-forward a
// race's clock (move `startsAt` into the past — no endpoint lets it) and seed
// back-dated results for the leaderboard.
const run = makeTestRun();

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

const makeAuthedClient = (token: string) =>
  HttpApiClient.make(ChatApi, {
    baseUrl: "http://localhost",
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
  });

const registerAndLogin = (username: string, password: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return { user, accessToken };
  });

const expectFailure = <A, E>(
  effect: Effect.Effect<A, E, never>,
  tag: string,
  message?: string,
) =>
  Effect.gen(function* () {
    const result = yield* effect.pipe(Effect.flip);
    const error = result as { _tag: string; message?: string };
    expect(error._tag).toBe(tag);
    if (message !== undefined) expect(error.message).toBe(message);
  });

const setup = (username: string) =>
  Effect.gen(function* () {
    const { user, accessToken } = yield* registerAndLogin(
      username,
      "pw-testpass",
    );
    const client = yield* makeAuthedClient(accessToken);
    return { user, client };
  });

type Client = Effect.Success<ReturnType<typeof makeAuthedClient>>;

const inbox = (client: Client) =>
  client.notifications.listNotifications({ query: {} });

// --- Posts & comments -------------------------------------------------------

test("commenting on someone's post notifies its author, with an excerpt", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "hello world" },
      });
      const comment = yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "nice   post\n\nreally" },
      });

      const page = yield* inbox(alice.client);
      expect(page.unreadCount).toBe(1);
      expect(page.notifications).toHaveLength(1);
      const [n] = page.notifications;
      expect(n!.type).toBe("comment");
      expect(n!.actor.username).toBe("bob");
      expect(n!.postId).toBe(post.id);
      expect(n!.commentId).toBe(comment.id);
      expect(n!.excerpt).toBe("nice post really");
      expect(n!.read).toBe(false);

      // The actor hears nothing about their own action.
      expect((yield* inbox(bob.client)).notifications).toHaveLength(0);
    }),
  ));

test("commenting on your own post doesn't notify you", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "mine" },
      });
      yield* alice.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "talking to myself" },
      });
      expect((yield* inbox(alice.client)).unreadCount).toBe(0);
    }),
  ));

test("a reply notifies the parent comment's author (and the post author only via their own comment)", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const carol = yield* setup("carol");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });
      const comment = yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "first" },
      });
      const reply = yield* carol.client.comments.createReply({
        params: { id: comment.id },
        payload: { content: "a reply" },
      });

      const bobInbox = yield* inbox(bob.client);
      expect(bobInbox.notifications.map((n) => n.type)).toEqual(["reply"]);
      expect(bobInbox.notifications[0]!.commentId).toBe(reply.id);
      expect(bobInbox.notifications[0]!.postId).toBe(post.id);
      // Alice only has bob's top-level comment, not carol's reply to it.
      expect(
        (yield* inbox(alice.client)).notifications.map((n) => n.type),
      ).toEqual(["comment"]);
    }),
  ));

test("reacting notifies the author, and un-reacting takes it back", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "react to me" },
      });
      const comment = yield* alice.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "and to me" },
      });

      yield* bob.client.comments.addPostReaction({
        params: { id: post.id },
        payload: { emoji: "❤️" },
      });
      // A repeat of the same reaction is a no-op, not a second notification.
      yield* bob.client.comments.addPostReaction({
        params: { id: post.id },
        payload: { emoji: "❤️" },
      });
      yield* bob.client.comments.addCommentReaction({
        params: { id: comment.id },
        payload: { emoji: "👍" },
      });

      const page = yield* inbox(alice.client);
      expect(
        page.notifications.map((n) => [n.type, n.emoji, n.commentId]),
      ).toEqual([
        ["reaction", "👍", comment.id],
        ["reaction", "❤️", null],
      ]);
      expect(page.notifications[0]!.excerpt).toBe("and to me");
      expect(page.notifications[1]!.excerpt).toBe("react to me");

      yield* bob.client.comments.removePostReaction({
        params: { id: post.id },
        payload: { emoji: "❤️" },
      });
      const after = yield* inbox(alice.client);
      expect(after.notifications.map((n) => n.emoji)).toEqual(["👍"]);
      expect(after.unreadCount).toBe(1);
    }),
  ));

test("@mentions in posts and comments notify the named users, case-insensitively", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("Bob");
      const carol = yield* setup("carol");
      const post = yield* alice.client.posts.createPost({
        payload: {
          contentType: "text",
          content: "hey @bob and @nobody, mail me at alice@example.com",
        },
      });
      const bobInbox = yield* inbox(bob.client);
      expect(bobInbox.notifications.map((n) => n.type)).toEqual(["mention"]);
      expect(bobInbox.notifications[0]!.postId).toBe(post.id);
      expect(bobInbox.notifications[0]!.commentId).toBeNull();

      // Mentioning the post's author in a comment on their post doesn't
      // double up on the "comment" notification they already get.
      const comment = yield* carol.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "@alice @Bob." },
      });
      expect(
        (yield* inbox(alice.client)).notifications.map((n) => n.type),
      ).toEqual(["comment"]);
      const bobAgain = yield* inbox(bob.client);
      expect(bobAgain.notifications.map((n) => n.type)).toEqual([
        "mention",
        "mention",
      ]);
      expect(bobAgain.notifications[0]!.commentId).toBe(comment.id);
    }),
  ));

test("editing only pings names the edit added", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const carol = yield* setup("carol");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "hi @bob" },
      });
      yield* alice.client.posts.updatePost({
        params: { id: post.id },
        payload: { contentType: "text", content: "hi @bob and @carol" },
      });
      expect((yield* inbox(bob.client)).notifications).toHaveLength(1);
      expect((yield* inbox(carol.client)).notifications).toHaveLength(1);

      const comment = yield* alice.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "no one" },
      });
      yield* alice.client.comments.updateComment({
        params: { id: comment.id },
        payload: { content: "now @carol" },
      });
      const carolInbox = yield* inbox(carol.client);
      expect(carolInbox.notifications).toHaveLength(2);
      expect(carolInbox.notifications[0]!.commentId).toBe(comment.id);
    }),
  ));

test("deleting a comment takes its notifications with it", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });
      const comment = yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "oops" },
      });
      expect((yield* inbox(alice.client)).unreadCount).toBe(1);
      yield* bob.client.comments.deleteComment({ params: { id: comment.id } });
      const page = yield* inbox(alice.client);
      expect(page.notifications).toHaveLength(0);
      expect(page.unreadCount).toBe(0);
    }),
  ));

test("blocking or muting someone silences their notifications, past and future", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });
      yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "before" },
      });
      yield* alice.client.users.setBlock({
        params: { id: bob.user.id },
        payload: { type: "mute" },
      });
      // The earlier notification is hidden too.
      let page = yield* inbox(alice.client);
      expect(page.notifications).toHaveLength(0);
      expect(page.unreadCount).toBe(0);

      yield* bob.client.comments.createComment({
        params: { id: post.id },
        payload: { content: "after" },
      });
      yield* alice.client.users.removeBlock({ params: { id: bob.user.id } });
      // Unmuting brings back the old one, but nothing was recorded while
      // muted.
      page = yield* inbox(alice.client);
      expect(page.notifications.map((n) => n.excerpt)).toEqual(["before"]);
    }),
  ));

// --- Read state & pagination -----------------------------------------------

test("mark one / mark all read, and someone else's id is a 404", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });
      for (const content of ["one", "two", "three"]) {
        yield* bob.client.comments.createComment({
          params: { id: post.id },
          payload: { content },
        });
      }
      const page = yield* inbox(alice.client);
      expect(page.unreadCount).toBe(3);

      const first = page.notifications[0]!;
      expect(
        yield* alice.client.notifications.markNotificationRead({
          params: { id: first.id },
        }),
      ).toEqual({ count: 2 });
      // Idempotent.
      expect(
        yield* alice.client.notifications.markNotificationRead({
          params: { id: first.id },
        }),
      ).toEqual({ count: 2 });
      expect(
        yield* alice.client.notifications.getUnreadNotificationCount(),
      ).toEqual({ count: 2 });

      yield* expectFailure(
        bob.client.notifications.markNotificationRead({
          params: { id: first.id },
        }),
        "NotFound",
      );

      expect(
        yield* alice.client.notifications.markAllNotificationsRead(),
      ).toEqual({ count: 0 });
      const after = yield* inbox(alice.client);
      expect(after.notifications.every((n) => n.read)).toBe(true);
    }),
  ));

test("the inbox pages newest-first with a keyset cursor", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const post = yield* alice.client.posts.createPost({
        payload: { contentType: "text", content: "post" },
      });
      for (let i = 1; i <= 5; i++) {
        yield* bob.client.comments.createComment({
          params: { id: post.id },
          payload: { content: `c${i}` },
        });
      }
      const first = yield* alice.client.notifications.listNotifications({
        query: { limit: 2 },
      });
      expect(first.notifications.map((n) => n.excerpt)).toEqual(["c5", "c4"]);
      expect(first.nextCursor).not.toBeNull();
      const second = yield* alice.client.notifications.listNotifications({
        query: { limit: 2, cursor: first.nextCursor! },
      });
      expect(second.notifications.map((n) => n.excerpt)).toEqual(["c3", "c2"]);
      const third = yield* alice.client.notifications.listNotifications({
        query: { limit: 2, cursor: second.nextCursor! },
      });
      expect(third.notifications.map((n) => n.excerpt)).toEqual(["c1"]);
      expect(third.nextCursor).toBeNull();

      yield* expectFailure(
        alice.client.notifications.listNotifications({
          query: { cursor: "not-a-cursor" },
        }),
        "InvalidNotificationRequest",
      );
    }),
  ));

// --- Games ------------------------------------------------------------------

const game = { params: { game: "typing" as const } };
const lobbyPath = (id: number) => ({ params: { id } });

test("inviting a user to a lobby notifies them once, linking to the lobby", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      const carol = yield* setup("carol");
      const lobby = yield* alice.client.games.createGameLobby(game);

      yield* alice.client.games.inviteToGameLobby({
        ...lobbyPath(lobby.id),
        payload: { userId: bob.user.id },
      });
      // A repeat invite while the first is unread doesn't stack.
      yield* alice.client.games.inviteToGameLobby({
        ...lobbyPath(lobby.id),
        payload: { userId: bob.user.id },
      });
      const page = yield* inbox(bob.client);
      expect(page.notifications).toHaveLength(1);
      const [n] = page.notifications;
      expect(n!.type).toBe("game_invite");
      expect(n!.actor.username).toBe("alice");
      expect(n!.game).toBe("typing");
      expect(n!.lobbyId).toBe(lobby.id);
      expect(n!.excerpt).toBeNull();

      // Only seated players can invite.
      yield* expectFailure(
        carol.client.games.inviteToGameLobby({
          ...lobbyPath(lobby.id),
          payload: { userId: bob.user.id },
        }),
        "Forbidden",
      );
      yield* expectFailure(
        alice.client.games.inviteToGameLobby({
          ...lobbyPath(lobby.id),
          payload: { userId: alice.user.id },
        }),
        "InvalidGameRequest",
      );
      yield* expectFailure(
        alice.client.games.inviteToGameLobby({
          ...lobbyPath(lobby.id),
          payload: { userId: 999_999 },
        }),
        "NotFound",
      );

      yield* bob.client.games.joinGameLobby(lobbyPath(lobby.id));
      yield* expectFailure(
        alice.client.games.inviteToGameLobby({
          ...lobbyPath(lobby.id),
          payload: { userId: bob.user.id },
        }),
        "InvalidGameRequest",
        "That player is already in this lobby",
      );

      yield* alice.client.games.startGameLobby(lobbyPath(lobby.id));
      yield* expectFailure(
        alice.client.games.inviteToGameLobby({
          ...lobbyPath(lobby.id),
          payload: { userId: carol.user.id },
        }),
        "InvalidGameRequest",
      );
    }),
  ));

test("taking someone's all-time #1 spot notifies them; beating your own record doesn't", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const alice = yield* setup("alice");
      const bob = yield* setup("bob");
      // Bob holds the record with a modest score.
      yield* Effect.promise(() =>
        db.insert(gameResults).values({
          game: "typing",
          userId: bob.user.id,
          lobbyId: null,
          round: 1,
          score: 5,
          accuracy: 100,
          durationMs: 60_000,
          place: 1,
          playerCount: 1,
        }),
      );

      const race = () =>
        Effect.gen(function* () {
          const lobby = yield* alice.client.games.createGameLobby(game);
          const started = yield* alice.client.games.startGameLobby(
            lobbyPath(lobby.id),
          );
          // Twenty seconds in: a fast but plausible finish.
          const startsAt = new Date(Date.now() - 20_000);
          yield* Effect.promise(() =>
            db
              .update(gameLobbies)
              .set({
                startsAt,
                endsAt: new Date(startsAt.getTime() + 180_000),
              })
              .where(eq(gameLobbies.id, lobby.id)),
          );
          yield* alice.client.games.finishRace({
            ...lobbyPath(lobby.id),
            payload: { typed: started.passage!, errors: 0 },
          });
          return lobby;
        });

      const lobby = yield* race();
      const page = yield* inbox(bob.client);
      expect(page.notifications).toHaveLength(1);
      expect(page.notifications[0]!.type).toBe("game_record");
      expect(page.notifications[0]!.actor.username).toBe("alice");
      expect(page.notifications[0]!.game).toBe("typing");
      expect(page.notifications[0]!.lobbyId).toBe(lobby.id);

      // Alice now holds the record; beating it again pings nobody.
      yield* race();
      expect((yield* inbox(bob.client)).notifications).toHaveLength(1);
      expect((yield* inbox(alice.client)).notifications).toHaveLength(0);
    }),
  ));
