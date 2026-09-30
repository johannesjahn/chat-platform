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
import { ChatApi, type GameLobby } from "./Api.ts";
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
import { GamesHandlerLive } from "./GamesHandler.ts";
import { NotificationsHandlerLive } from "./NotificationsHandler.ts";
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
import { gameLobbies, gameResults } from "./db/schema.ts";
import {
  ANTICIPATION_MS,
  basePoints,
  buildReflexPlan,
  comboMultiplier,
  FALSE_START_PENALTY,
  MAX_ROUND_POINTS,
  REFLEX_ARENA_ASPECT,
  REFLEX_COUNTDOWN_MS,
  REFLEX_DECOY_VARIANTS,
  REFLEX_INTRO_MS,
  REFLEX_KINDS,
  REFLEX_ROUNDS,
  REFLEX_SYMBOLS,
  REFLEX_TARGET_RADIUS,
  REFLEX_WINDOW_MS,
  scoreReflex,
  type ReflexPlan,
  type ReflexPlanRound,
  type ReflexTap,
} from "./games/reflex.ts";

// Reflex Rush end to end: the pure schedule/scoring module first, then the
// game through the real HTTP API on the same harness as games.test.ts.

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
  Layer.provide(NotificationsHandlerLive),
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

// --- The schedule and the scoring (pure) ------------------------------------

test("a plan is deterministic per seed and differs between seeds", () => {
  expect(buildReflexPlan(1234)).toEqual(buildReflexPlan(1234));
  expect(buildReflexPlan(1234)).not.toEqual(buildReflexPlan(4321));
});

test("every plan opens on a plain go, uses every kind, and never repeats one back to back", () => {
  for (let seed = 0; seed < 300; seed++) {
    const { rounds } = buildReflexPlan(seed);
    expect(rounds).toHaveLength(REFLEX_ROUNDS);
    expect(rounds[0]!.kind).toBe("go");
    for (const kind of REFLEX_KINDS) {
      expect(rounds.some((round) => round.kind === kind)).toBe(true);
    }
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i]!.kind).not.toBe(rounds[i - 1]!.kind);
    }
  }
});

test("rounds follow each other in time, with every cue inside the armed wait", () => {
  for (let seed = 0; seed < 300; seed++) {
    const plan = buildReflexPlan(seed);
    let previousClose = -1;
    for (const round of plan.rounds) {
      expect(round.armAt).toBeGreaterThan(previousClose);
      const armed = round.armAt + REFLEX_INTRO_MS;
      expect(round.signalAt).toBeGreaterThan(armed);
      expect(round.closeAt - round.signalAt).toBe(REFLEX_WINDOW_MS[round.kind]);
      for (const cue of round.cues) {
        expect(cue.at).toBeGreaterThan(armed);
        expect(cue.at).toBeLessThan(round.signalAt);
      }
      if (round.kind === "decoy") {
        expect(round.cues.length).toBeGreaterThanOrEqual(1);
        for (const cue of round.cues) {
          expect(cue.variant).toBeLessThan(REFLEX_DECOY_VARIANTS);
        }
      } else if (round.kind === "match") {
        expect(round.cues.length).toBeGreaterThanOrEqual(2);
        expect(round.symbol).toBeLessThan(REFLEX_SYMBOLS);
        for (const [i, cue] of round.cues.entries()) {
          // Never the symbol to hit on — and never the same one twice
          // running, so each flash is visibly a new one.
          expect(cue.variant).not.toBe(round.symbol);
          if (i > 0) expect(cue.variant).not.toBe(round.cues[i - 1]!.variant);
        }
      } else {
        expect(round.cues).toEqual([]);
      }
      expect(round.direction !== null).toBe(round.kind === "arrow");
      expect(round.target !== null).toBe(round.kind === "target");
      if (round.target) {
        for (const value of [round.target.x, round.target.y]) {
          expect(value).toBeGreaterThan(0.1);
          expect(value).toBeLessThan(0.9);
        }
      }
      previousClose = round.closeAt;
    }
    expect(plan.closeAt).toBe(previousClose);
    expect(plan.endsAt).toBeGreaterThan(plan.closeAt);
  }
});

// A tap that nails `round` in `reactionMs`.
const hitOf = (round: ReflexPlanRound, reactionMs: number): ReflexTap => ({
  early: false,
  reactionMs,
  direction: round.direction,
  x: round.target?.x ?? null,
  y: round.target?.y ?? null,
});

const MISS: ReflexTap = {
  early: false,
  reactionMs: null,
  direction: null,
  x: null,
  y: null,
};

const scored = (plan: ReflexPlan, taps: ReadonlyArray<ReflexTap>) => {
  const result = scoreReflex(plan, taps);
  if (!result.ok) throw new Error(result.reason);
  return result;
};

test("hits score by speed, and a clean streak builds a combo", () => {
  const plan = buildReflexPlan(7);
  const result = scored(
    plan,
    plan.rounds.map((round) => hitOf(round, 250)),
  );
  expect(result.accuracy).toBe(100);
  result.rounds.forEach((round, index) => {
    expect(round.outcome).toBe("hit");
    expect(round.points).toBe(
      Math.round(
        basePoints(plan.rounds[index]!.kind, 250) * comboMultiplier(index),
      ),
    );
  });
  expect(result.score).toBe(
    result.rounds.reduce((sum, round) => sum + round.points, 0),
  );
  // Faster is worth more, down to a floor, up to a ceiling.
  expect(basePoints("go", 200)).toBeGreaterThan(basePoints("go", 300));
  expect(basePoints("go", 5_000)).toBeGreaterThan(0);
  expect(basePoints("go", ANTICIPATION_MS)).toBe(MAX_ROUND_POINTS);
  // Aiming is harder than seeing green, so the same time is worth more.
  expect(basePoints("target", 400)).toBeGreaterThan(basePoints("go", 400));
});

test("jumping the gun, missing, a wrong arrow and an off-target hit each break the streak", () => {
  const plan = buildReflexPlan(99);
  const arrow = plan.rounds.findIndex((round) => round.kind === "arrow");
  const target = plan.rounds.findIndex((round) => round.kind === "target");
  const taps = plan.rounds.map((round) => hitOf(round, 300));
  taps[0] = { ...MISS, early: true };
  taps[1] = hitOf(plan.rounds[1]!, ANTICIPATION_MS - 1);
  taps[2] = MISS;
  const wrongWay = { up: "down", down: "up", left: "right", right: "left" };
  taps[arrow] = {
    ...taps[arrow]!,
    direction: wrongWay[plan.rounds[arrow]!.direction!] as "up",
  };
  const bullseye = plan.rounds[target]!.target!;
  taps[target] = {
    ...taps[target]!,
    x: bullseye.x > 0.5 ? bullseye.x - 0.3 : bullseye.x + 0.3,
  };
  const result = scored(plan, taps);
  expect(result.rounds[0]).toEqual({
    outcome: "early",
    reactionMs: null,
    points: -FALSE_START_PENALTY,
  });
  expect(result.rounds[1]!.outcome).toBe("early");
  expect(result.rounds[2]).toEqual({
    outcome: "miss",
    reactionMs: null,
    points: 0,
  });
  expect(result.rounds[arrow]!.outcome).toBe("wrong");
  expect(result.rounds[target]!.outcome).toBe("wrong");
  expect(result.rounds[arrow]!.points).toBe(0);
  // Right after a broken streak, a hit is worth its base points only.
  const next = Math.max(arrow, target) + 1;
  if (next < plan.rounds.length && next !== arrow && next !== target) {
    expect(result.rounds[next]!.points).toBe(
      basePoints(plan.rounds[next]!.kind, 300),
    );
  }
  const hits = result.rounds.filter((r) => r.outcome === "hit").length;
  expect(result.accuracy).toBe(Math.round((hits / REFLEX_ROUNDS) * 1000) / 10);
});

test("a hit on the edge of the target counts, the arena's aspect included", () => {
  const plan = buildReflexPlan(5);
  const index = plan.rounds.findIndex((round) => round.kind === "target");
  const { x, y } = plan.rounds[index]!.target!;
  const tapAt = (dx: number, dy: number) => {
    const taps = plan.rounds.map((round) => hitOf(round, 400));
    taps[index] = { ...taps[index]!, x: x + dx, y: y + dy };
    return scored(plan, taps).rounds[index]!.outcome;
  };
  expect(tapAt(REFLEX_TARGET_RADIUS * 0.95, 0)).toBe("hit");
  // Vertically, a radius spans more of the arena's (shorter) height.
  expect(tapAt(0, REFLEX_TARGET_RADIUS * REFLEX_ARENA_ASPECT * 0.95)).toBe(
    "hit",
  );
  expect(tapAt(REFLEX_TARGET_RADIUS * 2, 0)).toBe("wrong");
});

test("the score never goes below zero, and a game must report every round", () => {
  const plan = buildReflexPlan(3);
  const allEarly = scored(
    plan,
    plan.rounds.map(() => ({ ...MISS, early: true })),
  );
  expect(allEarly.score).toBe(0);
  expect(allEarly.accuracy).toBe(0);
  expect(
    scoreReflex(
      plan,
      plan.rounds.slice(1).map(() => MISS),
    ).ok,
  ).toBe(false);
});

// --- Through the API ---------------------------------------------------------

// Rewinds a started game's clock so it's `elapsedMs` past its start, keeping
// its length — the countdown and rounds are real wall-clock time.
const fastForward = (lobbyId: number, elapsedMs: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [lobby] = yield* Effect.promise(() =>
      db.select().from(gameLobbies).where(eq(gameLobbies.id, lobbyId)),
    );
    const length = lobby!.endsAt!.getTime() - lobby!.startsAt!.getTime();
    const startsAt = new Date(Date.now() - elapsedMs);
    yield* Effect.promise(() =>
      db
        .update(gameLobbies)
        .set({ startsAt, endsAt: new Date(startsAt.getTime() + length) })
        .where(eq(gameLobbies.id, lobbyId)),
    );
  });

const game = { path: { game: "reflex" as const } };
const lobbyPath = (id: number) => ({ path: { id } });

// The plan as the API hands it out, back on offsets from the start.
const planOf = (lobby: GameLobby): ReflexPlan => {
  const startsAt = lobby.startsAt!;
  const rounds = lobby.reflex!.rounds.map((round) => ({
    ...round,
    armAt: round.armAt - startsAt,
    signalAt: round.signalAt - startsAt,
    closeAt: round.closeAt - startsAt,
    cues: round.cues.map((cue) => ({ ...cue, at: cue.at - startsAt })),
  }));
  const closeAt = rounds.at(-1)!.closeAt;
  return { rounds, closeAt, endsAt: lobby.endsAt! - startsAt };
};

test("a solo game runs start → finish, scored server-side and settled onto the leaderboard", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);

      const created = yield* a.games.createGameLobby(game);
      expect(created.minPlayers).toBe(1);
      // The schedule is secret until the start.
      expect(created.reflex).toEqual({
        introMs: REFLEX_INTRO_MS,
        rounds: [],
        results: [],
      });

      const before = Date.now();
      const started = yield* a.games.startGameLobby(lobbyPath(created.id));
      expect(started.phase).toBe("countdown");
      expect(started.startsAt! - before).toBeGreaterThanOrEqual(
        REFLEX_COUNTDOWN_MS - 50,
      );
      // The seed stays server-side; the schedule it lays out is sent.
      expect(started.passage).toBeNull();
      expect(started.reflex!.rounds).toHaveLength(REFLEX_ROUNDS);
      const plan = planOf(started);
      expect(started.reflex!.rounds[0]!.armAt).toBe(started.startsAt!);

      const taps = plan.rounds.map((round) => hitOf(round, 250));
      // Not before the last round has been played.
      yield* expectFailure(
        a.games.finishReflex({ ...lobbyPath(created.id), payload: { taps } }),
        "InvalidGameRequest",
        "The game isn't over yet",
      );

      yield* fastForward(created.id, plan.closeAt + 100);
      const finished = yield* a.games.finishReflex({
        ...lobbyPath(created.id),
        payload: { taps },
      });
      const me = finished.players[0]!;
      const expected = scored(plan, taps);
      expect(me.score).toBe(expected.score);
      expect(me.accuracy).toBe(100);
      expect(me.place).toBe(1);
      expect(finished.phase).toBe("finished");
      expect(finished.reflex!.results).toEqual([
        { userId: alice.user.id, rounds: [...expected.rounds] },
      ]);

      yield* expectFailure(
        a.games.finishReflex({ ...lobbyPath(created.id), payload: { taps } }),
        "InvalidGameRequest",
        "You already finished",
      );

      // Settled exactly once (the finish read the game over, and so will
      // this one).
      yield* a.games.getGameLobby(lobbyPath(created.id));
      const db = yield* Db;
      const results = yield* Effect.promise(() =>
        db.select().from(gameResults),
      );
      expect(
        results.map((r) => [r.game, r.userId, r.score, r.place, r.playerCount]),
      ).toEqual([["reflex", alice.user.id, expected.score, 1, 1]]);
      const board = yield* a.games.getLeaderboard({
        ...game,
        urlParams: {},
      });
      expect(board.me?.bestScore).toBe(expected.score);
      expect(board.me?.wins).toBe(0);

      // A rematch clears the breakdown with the rest of the result.
      const rematched = yield* a.games.rematchGameLobby(lobbyPath(created.id));
      expect(rematched.phase).toBe("waiting");
      expect(rematched.players[0]!.score).toBeNull();
      expect(rematched.reflex!.results).toEqual([]);
      expect(rematched.reflex!.rounds).toEqual([]);
    }),
  ));

test("a duel places by score once everyone is in, and a no-show is left off", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const bob = yield* registerAndLogin("bob", "s3cret-pw");
      const carol = yield* registerAndLogin("carol", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const b = yield* makeAuthedClient(bob.accessToken);
      const c = yield* makeAuthedClient(carol.accessToken);

      const created = yield* a.games.createGameLobby(game);
      yield* b.games.joinGameLobby(lobbyPath(created.id));
      yield* c.games.joinGameLobby(lobbyPath(created.id));
      const started = yield* a.games.startGameLobby(lobbyPath(created.id));
      const plan = planOf(started);
      yield* fastForward(created.id, plan.closeAt + 100);

      // Alice submits first but slower; Bob overtakes her.
      const afterAlice = yield* a.games.finishReflex({
        ...lobbyPath(created.id),
        payload: { taps: plan.rounds.map((round) => hitOf(round, 400)) },
      });
      expect(afterAlice.phase).toBe("racing");
      expect(
        afterAlice.players.find((p) => p.user.id === alice.user.id)!.place,
      ).toBe(1);
      const afterBob = yield* b.games.finishReflex({
        ...lobbyPath(created.id),
        payload: { taps: plan.rounds.map((round) => hitOf(round, 220)) },
      });
      const placeOf = (lobby: GameLobby, id: number) =>
        lobby.players.find((p) => p.user.id === id)!.place;
      expect(placeOf(afterBob, bob.user.id)).toBe(1);
      expect(placeOf(afterBob, alice.user.id)).toBe(2);
      expect(placeOf(afterBob, carol.user.id)).toBeNull();
      // Carol never submits; the game is over once its time is up (and
      // past the network grace, closed to her).
      expect(afterBob.phase).toBe("racing");
      yield* fastForward(created.id, plan.endsAt + 2_500);
      const over = yield* a.games.getGameLobby(lobbyPath(created.id));
      expect(over.phase).toBe("finished");
      yield* expectFailure(
        c.games.finishReflex({
          ...lobbyPath(created.id),
          payload: { taps: plan.rounds.map((round) => hitOf(round, 200)) },
        }),
        "InvalidGameRequest",
        "The game is over",
      );

      const db = yield* Db;
      const results = yield* Effect.promise(() =>
        db.select().from(gameResults).orderBy(gameResults.place),
      );
      expect(results.map((r) => [r.userId, r.place, r.playerCount])).toEqual([
        [bob.user.id, 1, 3],
        [alice.user.id, 2, 3],
      ]);
      const board = yield* b.games.getLeaderboard({ ...game, urlParams: {} });
      expect(board.me?.wins).toBe(1);
    }),
  ));

test("finishing is only for seated players of a started Reflex Rush game", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "s3cret-pw");
      const bob = yield* registerAndLogin("bob", "s3cret-pw");
      const a = yield* makeAuthedClient(alice.accessToken);
      const b = yield* makeAuthedClient(bob.accessToken);
      const taps = Array.from({ length: REFLEX_ROUNDS }, () => MISS);

      const created = yield* a.games.createGameLobby(game);
      yield* expectFailure(
        a.games.finishReflex({ ...lobbyPath(created.id), payload: { taps } }),
        "InvalidGameRequest",
        "The game has not started",
      );
      yield* a.games.startGameLobby(lobbyPath(created.id));
      yield* expectFailure(
        b.games.finishReflex({ ...lobbyPath(created.id), payload: { taps } }),
        "Forbidden",
      );
      // A typing lobby has no reaction rounds to report.
      const typing = yield* b.games.createGameLobby({
        path: { game: "typing" },
      });
      yield* expectFailure(
        b.games.finishReflex({ ...lobbyPath(typing.id), payload: { taps } }),
        "InvalidGameRequest",
        "This isn't a Reflex Rush lobby",
      );
      // …and a reflex lobby has no race to finish.
      yield* expectFailure(
        a.games.finishRace({
          ...lobbyPath(created.id),
          payload: { typed: "", errors: 0 },
        }),
        "InvalidGameRequest",
      );
    }),
  ));
