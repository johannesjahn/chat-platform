import { expect, test } from "bun:test";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ChatApi, MAX_GAME_LOBBY_PLAYERS } from "./Api.ts";
import { AdminHandlerLive } from "./AdminHandler.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { SearchHandlerLive } from "./SearchHandler.ts";
import { Db } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { JwtLive } from "./Jwt.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
import { GamesHandlerLive, lobbyPhase } from "./GamesHandler.ts";
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
import { gameLobbies, gameResults, users } from "./db/schema.ts";
import { MAX_PLAUSIBLE_WPM, TYPING_COUNTDOWN_MS } from "./games/typing.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(EngagementHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(SearchHandlerLive),
  Layer.provide(AttachmentsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(AdminHandlerLive),
  Layer.provide(GamesHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(TokenVersionCacheLive),
  Layer.provide(InMemoryPresenceStoreLive),
  Layer.provide(InMemoryRateLimiterLive),
  Layer.provide(JwtLive),
  Layer.provide(SanitizeDecodeErrorsLive),
  Layer.provide(InMemoryWsTicketLive),
  Layer.provide(AttachmentStorageLive),
);

const { getTestDb } = makeTestDbAccessor();

// Same shape as admin.test.ts's harness: `effect` also gets `Db` directly,
// sharing the API layer's in-memory instance, so a test can fast-forward a
// race's clock (move `startsAt` into the past — no endpoint lets it) and seed
// back-dated results for the leaderboard.
const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Db>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
  const TestDbLive = Layer.succeed(Db, db);

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      ApiLive.pipe(
        Layer.provide(TestDbLive),
        Layer.provide(InMemoryPubSubLive),
      ),
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
      effect.pipe(Effect.provide(TestClientLayer), Effect.provide(TestDbLive)),
    );
  } finally {
    await dispose();
  }
};

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
    const result = yield* effect.pipe(Effect.either);
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const error = result.left as { _tag: string; message?: string };
      expect(error._tag).toBe(tag);
      if (message !== undefined) expect(error.message).toBe(message);
    }
  });

// Rewinds a started race's clock so it's `elapsedMs` into racing — the
// countdown is real wall-clock time, and no endpoint lets a test skip it.
const fastForward = (lobbyId: number, elapsedMs: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const startsAt = new Date(Date.now() - elapsedMs);
    yield* Effect.promise(() =>
      db
        .update(gameLobbies)
        .set({ startsAt, endsAt: new Date(startsAt.getTime() + 180_000) })
        .where(eq(gameLobbies.id, lobbyId)),
    );
  });

const game = { path: { game: "typing" as const } };
const lobbyPath = (id: number) => ({ path: { id } });

test("lobbyPhase walks waiting → countdown → racing → finished off the clock", () => {
  const startsAt = new Date(10_000);
  const endsAt = new Date(20_000);
  const started = { status: "started" as const, startsAt, endsAt };
  const racing = [{ durationMs: null }, { durationMs: 5_000 }];

  expect(
    lobbyPhase({ status: "waiting", startsAt: null, endsAt: null }, [], 0),
  ).toBe("waiting");
  expect(lobbyPhase(started, racing, 9_999)).toBe("countdown");
  expect(lobbyPhase(started, racing, 10_000)).toBe("racing");
  expect(lobbyPhase(started, racing, 20_000)).toBe("finished");
  // Everyone crossing the line ends the race early.
  expect(
    lobbyPhase(started, [{ durationMs: 4_000 }, { durationMs: 5_000 }], 12_000),
  ).toBe("finished");
});

test("creating a lobby seats the caller as host and hides the passage until the start", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const c = yield* makeAuthedClient(alice.accessToken);

      const lobby = yield* c.games.createGameLobby(game);
      expect(lobby.game).toBe("typing");
      expect(lobby.hostId).toBe(alice.user.id);
      expect(lobby.phase).toBe("waiting");
      expect(lobby.passage).toBeNull();
      expect(lobby.startsAt).toBeNull();
      expect(lobby.maxPlayers).toBe(MAX_GAME_LOBBY_PLAYERS);
      expect(lobby.players.map((p) => p.user.username)).toEqual(["alice"]);

      const { lobbies } = yield* c.games.listGameLobbies(game);
      expect(lobbies.map((l) => l.id)).toEqual([lobby.id]);
    }),
  ));

test("a race runs start → finish with a server-timed, server-scored result", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const bob = yield* registerAndLogin("bob", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const b = yield* makeAuthedClient(bob.accessToken);

      const created = yield* a.games.createGameLobby(game);
      const joined = yield* b.games.joinGameLobby(lobbyPath(created.id));
      expect(joined.players.map((p) => p.user.username)).toEqual([
        "alice",
        "bob",
      ]);

      // Only the host starts.
      yield* expectFailure(
        b.games.startGameLobby(lobbyPath(created.id)),
        "Forbidden",
      );
      const before = Date.now();
      const started = yield* a.games.startGameLobby(lobbyPath(created.id));
      expect(started.phase).toBe("countdown");
      expect(started.passage).toEqual(expect.any(String));
      expect(started.startsAt! - before).toBeGreaterThanOrEqual(
        TYPING_COUNTDOWN_MS - 50,
      );
      // Starting twice is refused rather than re-rolling the passage.
      yield* expectFailure(
        a.games.startGameLobby(lobbyPath(created.id)),
        "InvalidGameRequest",
      );
      const passage = started.passage!;

      // No finishing during the countdown.
      yield* expectFailure(
        a.games.finishRace({
          ...lobbyPath(created.id),
          payload: { typed: passage, errors: 0 },
        }),
        "InvalidGameRequest",
        "The race has not started",
      );

      yield* fastForward(created.id, 60_000);

      // The text has to actually match.
      yield* expectFailure(
        a.games.finishRace({
          ...lobbyPath(created.id),
          payload: { typed: passage.slice(0, -1), errors: 0 },
        }),
        "InvalidGameRequest",
        "Typed text does not match the passage",
      );

      const afterAlice = yield* a.games.finishRace({
        ...lobbyPath(created.id),
        payload: { typed: passage, errors: passage.length },
      });
      const aliceRow = afterAlice.players.find(
        (p) => p.user.username === "alice",
      )!;
      expect(aliceRow.place).toBe(1);
      expect(aliceRow.durationMs).toBeGreaterThanOrEqual(60_000);
      // ~a minute for the passage: WPM is its length in 5-char words.
      expect(aliceRow.score).toBeCloseTo(passage.length / 5, 0);
      // As many wrong keystrokes as right ones: half accurate.
      expect(aliceRow.accuracy).toBe(50);
      expect(afterAlice.phase).toBe("racing");

      // A second finish from the same player is refused.
      yield* expectFailure(
        a.games.finishRace({
          ...lobbyPath(created.id),
          payload: { typed: passage, errors: 0 },
        }),
        "InvalidGameRequest",
        "You already finished",
      );

      const afterBob = yield* b.games.finishRace({
        ...lobbyPath(created.id),
        payload: { typed: passage, errors: 0 },
      });
      const bobRow = afterBob.players.find((p) => p.user.username === "bob")!;
      expect(bobRow.place).toBe(2);
      expect(bobRow.accuracy).toBe(100);
      expect(afterBob.phase).toBe("finished");

      const db = yield* Db;
      const results = yield* Effect.promise(() =>
        db.select().from(gameResults).orderBy(gameResults.place),
      );
      expect(
        results.map((r) => [r.userId, r.place, r.playerCount, r.round]),
      ).toEqual([
        [alice.user.id, 1, 2, 1],
        [bob.user.id, 2, 2, 1],
      ]);
    }),
  ));

test("finishing implausibly fast is rejected and never reaches the leaderboard", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const lobby = yield* a.games.createGameLobby(game);
      const started = yield* a.games.startGameLobby(lobbyPath(lobby.id));
      const passage = started.passage!;
      // Just fast enough to be over the ceiling.
      const tooFastMs = Math.floor(
        (passage.length / 5 / (MAX_PLAUSIBLE_WPM + 50)) * 60_000,
      );
      yield* fastForward(lobby.id, tooFastMs);

      yield* expectFailure(
        a.games.finishRace({
          ...lobbyPath(lobby.id),
          payload: { typed: passage, errors: 0 },
        }),
        "InvalidGameRequest",
        "Finish time is not plausible",
      );
      const board = yield* a.games.getLeaderboard({
        ...game,
        urlParams: {},
      });
      expect(board.entries).toEqual([]);
      expect(board.me).toBeNull();
    }),
  ));

test("finishing is only for seated players, and not after the time limit", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const eve = yield* registerAndLogin("eve", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const e = yield* makeAuthedClient(eve.accessToken);
      const lobby = yield* a.games.createGameLobby(game);
      const started = yield* a.games.startGameLobby(lobbyPath(lobby.id));

      // A spectator can look but not race — and can't sit down mid-race.
      const watched = yield* e.games.getGameLobby(lobbyPath(lobby.id));
      expect(watched.passage).toBe(started.passage);
      yield* expectFailure(
        e.games.joinGameLobby(lobbyPath(lobby.id)),
        "InvalidGameRequest",
        "This race has already started",
      );
      yield* fastForward(lobby.id, 30_000);
      yield* expectFailure(
        e.games.finishRace({
          ...lobbyPath(lobby.id),
          payload: { typed: started.passage!, errors: 0 },
        }),
        "Forbidden",
      );

      // Past `endsAt` (plus grace) the race is closed.
      yield* fastForward(lobby.id, 200_000);
      yield* expectFailure(
        a.games.finishRace({
          ...lobbyPath(lobby.id),
          payload: { typed: started.passage!, errors: 0 },
        }),
        "InvalidGameRequest",
        "The race is over",
      );
      const after = yield* a.games.getGameLobby(lobbyPath(lobby.id));
      expect(after.phase).toBe("finished");
    }),
  ));

test("a full lobby turns new players away", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const bob = yield* registerAndLogin("bob", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const b = yield* makeAuthedClient(bob.accessToken);
      const lobby = yield* a.games.createGameLobby(game);
      const db = yield* Db;
      yield* Effect.promise(() =>
        db
          .update(gameLobbies)
          .set({ maxPlayers: 1 })
          .where(eq(gameLobbies.id, lobby.id)),
      );
      yield* expectFailure(
        b.games.joinGameLobby(lobbyPath(lobby.id)),
        "InvalidGameRequest",
        "This lobby is full",
      );
    }),
  ));

test("the host leaving hands the lobby on, and the last one out closes it", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const bob = yield* registerAndLogin("bob", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const b = yield* makeAuthedClient(bob.accessToken);
      const lobby = yield* a.games.createGameLobby(game);
      yield* b.games.joinGameLobby(lobbyPath(lobby.id));

      yield* a.games.leaveGameLobby(lobbyPath(lobby.id));
      const handedOver = yield* b.games.getGameLobby(lobbyPath(lobby.id));
      expect(handedOver.hostId).toBe(bob.user.id);
      expect(handedOver.players.map((p) => p.user.username)).toEqual(["bob"]);

      yield* b.games.leaveGameLobby(lobbyPath(lobby.id));
      yield* expectFailure(
        b.games.getGameLobby(lobbyPath(lobby.id)),
        "NotFound",
      );
    }),
  ));

test("sitting down in one lobby stands you up from any other", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const bob = yield* registerAndLogin("bob", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const b = yield* makeAuthedClient(bob.accessToken);
      const first = yield* a.games.createGameLobby(game);
      const second = yield* b.games.createGameLobby(game);
      yield* b.games.joinGameLobby(lobbyPath(first.id));

      // Bob was alone in his own lobby, so leaving it closed it.
      yield* expectFailure(
        b.games.getGameLobby(lobbyPath(second.id)),
        "NotFound",
      );
      const { lobbies } = yield* a.games.listGameLobbies(game);
      expect(lobbies.map((l) => [l.id, l.players.length])).toEqual([
        [first.id, 2],
      ]);
    }),
  ));

test("quick play joins an open lobby with room, or opens one", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const bob = yield* registerAndLogin("bob", "s3cret-pw");
      const carol = yield* registerAndLogin("carol", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const b = yield* makeAuthedClient(bob.accessToken);
      const c = yield* makeAuthedClient(carol.accessToken);

      const opened = yield* a.games.quickPlay(game);
      expect(opened.hostId).toBe(alice.user.id);
      // Quick play again while seated keeps you where you are.
      const same = yield* a.games.quickPlay(game);
      expect(same.id).toBe(opened.id);

      const joined = yield* b.games.quickPlay(game);
      expect(joined.id).toBe(opened.id);
      expect(joined.players).toHaveLength(2);

      // A lobby that's already racing isn't joinable, so quick play opens a
      // fresh one instead.
      yield* a.games.startGameLobby(lobbyPath(opened.id));
      const fresh = yield* c.games.quickPlay(game);
      expect(fresh.id).not.toBe(opened.id);
      expect(fresh.hostId).toBe(carol.user.id);
    }),
  ));

test("a rematch resets the lobby for another round once the race is over", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const bob = yield* registerAndLogin("bob", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const b = yield* makeAuthedClient(bob.accessToken);
      const lobby = yield* a.games.createGameLobby(game);
      yield* b.games.joinGameLobby(lobbyPath(lobby.id));
      const started = yield* a.games.startGameLobby(lobbyPath(lobby.id));

      yield* expectFailure(
        a.games.rematchGameLobby(lobbyPath(lobby.id)),
        "InvalidGameRequest",
      );

      yield* fastForward(lobby.id, 60_000);
      for (const client of [a, b]) {
        yield* client.games.finishRace({
          ...lobbyPath(lobby.id),
          payload: { typed: started.passage!, errors: 0 },
        });
      }
      yield* expectFailure(
        b.games.rematchGameLobby(lobbyPath(lobby.id)),
        "Forbidden",
      );

      const rematch = yield* a.games.rematchGameLobby(lobbyPath(lobby.id));
      expect(rematch.phase).toBe("waiting");
      expect(rematch.round).toBe(2);
      expect(rematch.passage).toBeNull();
      expect(rematch.players.map((p) => [p.score, p.place])).toEqual([
        [null, null],
        [null, null],
      ]);

      // The next round never repeats the passage just raced.
      const next = yield* a.games.startGameLobby(lobbyPath(lobby.id));
      expect(next.passage).not.toBe(started.passage);
    }),
  ));

test("the leaderboard ranks by best score, counts wins, and always includes me", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const [speedy, steady] = yield* Effect.promise(() =>
        db
          .insert(users)
          .values([
            { username: "speedy", passwordHash: "x" },
            { username: "steady", passwordHash: "x" },
          ])
          .returning({ id: users.id }),
      );
      const daysAgo = (days: number) =>
        new Date(Date.now() - days * 24 * 60 * 60_000);
      const result = (
        userId: number,
        score: number,
        place: number,
        playerCount: number,
        createdAt: Date,
      ) => ({
        game: "typing",
        userId,
        round: 1,
        score,
        accuracy: 90,
        durationMs: 30_000,
        place,
        playerCount,
        createdAt,
      });
      yield* Effect.promise(() =>
        db.insert(gameResults).values([
          // Speedy's best is old — outside the weekly window.
          result(speedy!.id, 120, 1, 3, daysAgo(10)),
          result(speedy!.id, 60, 2, 3, daysAgo(0.5)),
          result(steady!.id, 80, 1, 2, daysAgo(2)),
          result(steady!.id, 70, 1, 2, daysAgo(3)),
          // A solo "win" isn't a win.
          result(alice.user.id, 50, 1, 1, daysAgo(0.1)),
        ]),
      );
      const a = yield* makeAuthedClient(alice.accessToken);

      const all = yield* a.games.getLeaderboard({ ...game, urlParams: {} });
      expect(all.period).toBe("all");
      expect(
        all.entries.map((e) => [e.rank, e.user.username, e.bestScore]),
      ).toEqual([
        [1, "speedy", 120],
        [2, "steady", 80],
        [3, "alice", 50],
      ]);
      const steadyEntry = all.entries[1]!;
      expect(steadyEntry.races).toBe(2);
      expect(steadyEntry.wins).toBe(2);
      expect(steadyEntry.averageScore).toBe(75);
      expect(all.me?.wins).toBe(0);
      expect(all.me?.rank).toBe(3);

      const week = yield* a.games.getLeaderboard({
        ...game,
        urlParams: { period: "week" },
      });
      expect(week.entries.map((e) => [e.user.username, e.bestScore])).toEqual([
        ["steady", 80],
        ["speedy", 60],
        ["alice", 50],
      ]);

      const day = yield* a.games.getLeaderboard({
        ...game,
        urlParams: { period: "day" },
      });
      expect(day.entries.map((e) => e.user.username)).toEqual([
        "speedy",
        "alice",
      ]);
    }),
  ));
