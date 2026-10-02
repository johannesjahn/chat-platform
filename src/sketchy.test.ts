import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ChatApi, type DrawingStroke, type GameLobby } from "./Api.ts";
import { Db } from "./Db.ts";
import { PubSub } from "./PubSub.ts";
import {
  gameBluffs,
  gameDrawings,
  gameLobbies,
  gameResults,
  gameVotes,
} from "./db/schema.ts";
import { DRAWING_COUNTDOWN_MS } from "./games/drawing/rules.ts";
import { revealDurationMs } from "./games/drawing/timeline.ts";
import { makeTestRun } from "./testApi.ts";

// Sketchy (issue #440) end to end through the real HTTP API. Same harness as
// games.test.ts, with one addition: the PubSub every realtime event fans
// out through records what it's given, so a test can check that no event
// ever carries anything secret.

process.env.JWT_SECRET ??= "test-secret";

// Every message published during the current test.
let published: string[] = [];
const RecordingPubSubLive = Layer.succeed(PubSub, {
  publish: (_channel, message) =>
    Effect.sync(() => {
      published.push(message);
    }),
  subscribe: () => Effect.void,
  ping: Effect.void,
});

const run = makeTestRun({
  pubSub: RecordingPubSubLive,
  beforeEach: () => {
    published = [];
  },
});

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

type Client = Effect.Success<ReturnType<typeof makeAuthedClient>>;
type Player = {
  readonly id: number;
  readonly name: string;
  readonly c: Client;
};

const signUp = (username: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({
      payload: { username, password: "s3cret-pw" },
    });
    const { accessToken } = yield* c.users.login({
      payload: { username, password: "s3cret-pw" },
    });
    return {
      id: user.id,
      name: username,
      c: yield* makeAuthedClient(accessToken),
    } satisfies Player;
  });

const expectFailure = <A, E>(
  effect: Effect.Effect<A, E, never>,
  tag: string,
  message?: string,
) =>
  Effect.gen(function* () {
    const result = yield* effect.pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const error = result.failure as { _tag: string; message?: string };
      expect(error._tag).toBe(tag);
      if (message !== undefined) expect(error.message).toBe(message);
    }
  });

const drawingGame = { params: { game: "drawing" as const } };
const at = (id: number) => ({ params: { id } });
const SCRIBBLE: DrawingStroke[] = [
  { color: 1, brush: "thick", points: [10, 10, 200, 150, 400, 300] },
];

// Moves a game `ms` further along: every timestamp its timeline is derived
// from shifts into the past together, exactly as if that much time had
// passed — no endpoint lets a test skip the clock.
const advance = (lobbyId: number, ms: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const shift = sql`(${ms} * interval '1 millisecond')`;
    yield* Effect.promise(async () => {
      await db
        .update(gameLobbies)
        .set({
          startsAt: sql`${gameLobbies.startsAt} - ${shift}`,
          endsAt: sql`${gameLobbies.endsAt} - ${shift}`,
        })
        .where(eq(gameLobbies.id, lobbyId));
      const ids = db
        .select({ id: gameDrawings.id })
        .from(gameDrawings)
        .where(eq(gameDrawings.lobbyId, lobbyId));
      await db
        .update(gameDrawings)
        .set({ submittedAt: sql`${gameDrawings.submittedAt} - ${shift}` })
        .where(eq(gameDrawings.lobbyId, lobbyId));
      await db
        .update(gameBluffs)
        .set({ createdAt: sql`${gameBluffs.createdAt} - ${shift}` })
        .where(sql`${gameBluffs.drawingId} in ${ids}`);
      await db
        .update(gameVotes)
        .set({ createdAt: sql`${gameVotes.createdAt} - ${shift}` })
        .where(sql`${gameVotes.drawingId} in ${ids}`);
    });
  });

// The dealt prompts, straight from the database — what must never leak.
const promptsOf = (lobbyId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.promise(() =>
      db
        .select({
          id: gameDrawings.id,
          artistId: gameDrawings.artistId,
          prompt: gameDrawings.prompt,
        })
        .from(gameDrawings)
        .where(eq(gameDrawings.lobbyId, lobbyId)),
    );
    return new Map(rows.map((row) => [row.id, row]));
  });

// Three players seated in a fresh Sketchy lobby, host first.
const threePlayerLobby = Effect.gen(function* () {
  const alice = yield* signUp("alice");
  const bob = yield* signUp("bob");
  const carol = yield* signUp("carol");
  const lobby = yield* alice.c.games.createGameLobby(drawingGame);
  yield* bob.c.games.joinGameLobby(at(lobby.id));
  yield* carol.c.games.joinGameLobby(at(lobby.id));
  return { lobby, players: [alice, bob, carol] as const };
});

const spotlightOf = (lobby: GameLobby) => {
  const stage = lobby.drawing!.stage!;
  return lobby.drawing!.drawings.find((d) => d.id === stage.drawingId)!;
};

test("the host picks theme packs and rounds; everyone sees them", () =>
  run(
    Effect.gen(function* () {
      const { lobby, players } = yield* threePlayerLobby;
      const [alice, bob] = players;
      expect(lobby.minPlayers).toBe(3);
      expect(lobby.maxPlayers).toBe(8);
      expect(lobby.drawing).toMatchObject({
        packs: ["classics"],
        rounds: 1,
        stage: null,
        drawings: [],
      });

      const { packs } = yield* alice.c.games.listDrawingPacks();
      expect(packs.map((pack) => pack.slug)).toEqual([
        "classics",
        "animals",
        "food",
        "movies",
        "office",
        "fantasy",
        "absurd",
      ]);
      for (const pack of packs) {
        expect(pack.samples).toHaveLength(3);
        expect(pack.promptCount).toBeGreaterThanOrEqual(60);
        // Samples only — never the whole list a voter could look up.
        expect(Object.keys(pack)).not.toContain("prompts");
      }

      yield* expectFailure(
        bob.c.games.updateDrawingSettings({
          ...at(lobby.id),
          payload: { packs: ["food"], rounds: 2 },
        }),
        "Forbidden",
      );
      yield* expectFailure(
        alice.c.games.updateDrawingSettings({
          ...at(lobby.id),
          payload: { packs: ["food", "made-up"], rounds: 2 },
        }),
        "InvalidGameRequest",
        "Unknown theme pack: made-up",
      );
      yield* expectFailure(
        alice.c.games.updateDrawingSettings({
          ...at(lobby.id),
          payload: { packs: [], rounds: 2 },
        }),
        "SchemaError",
      );

      published = [];
      const updated = yield* alice.c.games.updateDrawingSettings({
        ...at(lobby.id),
        payload: { packs: ["absurd", "animals", "absurd"], rounds: 2 },
      });
      // De-duplicated, in the picker's order.
      expect(updated.drawing).toMatchObject({
        packs: ["animals", "absurd"],
        rounds: 2,
      });
      // Pushed to the room (id-only; clients refetch)...
      expect(published.some((m) => m.includes('"game_lobby_updated"'))).toBe(
        true,
      );
      // ...and there for everyone who looks, the lobby browser included.
      const seen = yield* bob.c.games.getGameLobby(at(lobby.id));
      expect(seen.drawing!.packs).toEqual(["animals", "absurd"]);
      const { lobbies } = yield* bob.c.games.listGameLobbies(drawingGame);
      expect(lobbies[0]!.drawing).toMatchObject({
        packs: ["animals", "absurd"],
      });

      // Settings are Sketchy's alone.
      const typing = yield* alice.c.games.createGameLobby({
        params: { game: "typing" },
      });
      yield* expectFailure(
        alice.c.games.updateDrawingSettings({
          ...at(typing.id),
          payload: { packs: ["food"], rounds: 1 },
        }),
        "InvalidGameRequest",
        "This game has no settings",
      );
    }),
  ));

test("a game needs three players to start, and settings lock once it has", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* signUp("alice");
      const bob = yield* signUp("bob");
      const carol = yield* signUp("carol");
      const lobby = yield* alice.c.games.createGameLobby(drawingGame);
      yield* bob.c.games.joinGameLobby(at(lobby.id));
      yield* expectFailure(
        alice.c.games.startGameLobby(at(lobby.id)),
        "InvalidGameRequest",
        "This game needs at least 3 players",
      );
      yield* carol.c.games.joinGameLobby(at(lobby.id));
      yield* alice.c.games.updateDrawingSettings({
        ...at(lobby.id),
        payload: { packs: ["food"], rounds: 3 },
      });
      const started = yield* alice.c.games.startGameLobby(at(lobby.id));
      expect(started.phase).toBe("countdown");
      expect(started.passage).toBeNull();
      expect(started.drawing!.participantIds).toEqual(
        [alice.id, bob.id, carol.id].sort((x, y) => x - y),
      );

      // One distinct prompt per player per round, all from the chosen pack.
      const prompts = [...(yield* promptsOf(lobby.id)).values()];
      expect(prompts).toHaveLength(9);
      expect(new Set(prompts.map((p) => p.prompt)).size).toBe(9);

      yield* expectFailure(
        alice.c.games.updateDrawingSettings({
          ...at(lobby.id),
          payload: { packs: ["animals"], rounds: 1 },
        }),
        "InvalidGameRequest",
        "Settings can only be changed before the game starts",
      );
      // Nor can anyone new sit down.
      const dave = yield* signUp("dave");
      yield* expectFailure(
        dave.c.games.joinGameLobby(at(lobby.id)),
        "InvalidGameRequest",
        "This game has already started",
      );
      // And a Sketchy game has no race to finish.
      yield* expectFailure(
        alice.c.games.finishRace({
          ...at(lobby.id),
          payload: { typed: "x", errors: 0 },
        }),
        "InvalidGameRequest",
        "This game has no races to finish",
      );
    }),
  ));

test("a full round plays draw → bluff → vote → reveal → results, scored server-side", () =>
  run(
    Effect.gen(function* () {
      const { lobby, players } = yield* threePlayerLobby;
      const [alice] = players;
      const byId = new Map(players.map((p) => [p.id, p]));
      yield* alice.c.games.startGameLobby(at(lobby.id));
      const prompts = yield* promptsOf(lobby.id);

      // Nothing to draw during the countdown.
      yield* expectFailure(
        alice.c.games.submitDrawing({
          ...at(lobby.id),
          payload: { strokes: SCRIBBLE },
        }),
        "InvalidGameRequest",
        "It isn't time to draw",
      );
      yield* advance(lobby.id, DRAWING_COUNTDOWN_MS);

      // --- Draw ---------------------------------------------------------
      for (const player of players) {
        const view = yield* player.c.games.getGameLobby(at(lobby.id));
        expect(view.phase).toBe("racing");
        expect(view.drawing!.stage).toMatchObject({ kind: "draw", turn: 1 });
        const mine = [...prompts.values()].find(
          (p) => p.artistId === player.id,
        )!;
        expect(view.drawing!.myPrompt).toBe(mine.prompt);
      }

      // Strokes the schema can't vet on its own are still refused.
      yield* expectFailure(
        alice.c.games.submitDrawing({
          ...at(lobby.id),
          payload: {
            strokes: [{ color: 0, brush: "thin", points: [1, 2, 3] }],
          },
        }),
        "InvalidGameRequest",
        "Every stroke point needs an x and a y",
      );
      yield* expectFailure(
        alice.c.games.submitDrawing({
          ...at(lobby.id),
          payload: {
            strokes: [{ color: 0, brush: "thin", points: [1, 2, 3, 700] }],
          },
        }),
        "InvalidGameRequest",
        "A stroke goes off the canvas",
      );

      for (const player of players) {
        const after = yield* player.c.games.submitDrawing({
          ...at(lobby.id),
          payload: { strokes: SCRIBBLE },
        });
        if (player !== players[2]) {
          // Still drawing: others' drawings stay hidden.
          expect(after.drawing!.stage!.kind).toBe("draw");
          for (const entry of after.drawing!.drawings) {
            if (entry.artistId !== player.id) expect(entry.strokes).toBeNull();
          }
        }
      }
      yield* expectFailure(
        alice.c.games.submitDrawing({
          ...at(lobby.id),
          payload: { strokes: SCRIBBLE },
        }),
        "InvalidGameRequest",
      );

      // --- Bluff: everyone drew, so the first drawing is already up. -----
      let view = yield* alice.c.games.getGameLobby(at(lobby.id));
      expect(view.drawing!.stage!.kind).toBe("bluff");
      const first = spotlightOf(view);
      expect(first.strokes).toEqual(SCRIBBLE);
      const artist = byId.get(first.artistId)!;
      const [fooler, fooled] = players.filter((p) => p !== artist);
      const truth = prompts.get(first.id)!.prompt;

      yield* expectFailure(
        artist.c.games.submitBluff({
          ...at(lobby.id),
          payload: { text: "something else entirely" },
        }),
        "InvalidGameRequest",
        "You can't bluff on your own drawing",
      );
      yield* expectFailure(
        fooler!.c.games.submitBluff({
          ...at(lobby.id),
          payload: { text: `The ${truth.toUpperCase()}!` },
        }),
        "InvalidGameRequest",
        "Too close to the truth — try another.",
      );
      yield* fooler!.c.games.submitBluff({
        ...at(lobby.id),
        payload: { text: "A suspicious amount of soup" },
      });
      yield* expectFailure(
        fooled!.c.games.submitBluff({
          ...at(lobby.id),
          payload: { text: "a suspicious amount of SOUP" },
        }),
        "InvalidGameRequest",
        "Someone already wrote that — try another.",
      );
      view = yield* fooled!.c.games.submitBluff({
        ...at(lobby.id),
        payload: { text: "the world's loudest sandwich" },
      });

      // --- Vote: both bluffs are in, so voting opened early. -------------
      expect(view.drawing!.stage!.kind).toBe("vote");
      const ballot = spotlightOf(view).answers!;
      expect(ballot.map((a) => a.text).sort()).toEqual(
        [
          truth,
          "A suspicious amount of soup",
          "the world's loudest sandwich",
        ].sort(),
      );
      expect(ballot.every((a) => a.real === null && a.authorId === null)).toBe(
        true,
      );
      const realId = ballot.find((a) => a.text === truth)!.id;
      const foolerBluffId = ballot.find(
        (a) => a.text === "A suspicious amount of soup",
      )!.id;
      const foolersOwn = (yield* fooler!.c.games.getGameLobby(at(lobby.id)))
        .drawing!;
      expect(
        spotlightOf({ ...view, drawing: foolersOwn }).answers!.find(
          (a) => a.mine,
        )!.id,
      ).toBe(foolerBluffId);

      yield* expectFailure(
        artist.c.games.submitVote({
          ...at(lobby.id),
          payload: { answer: realId },
        }),
        "InvalidGameRequest",
        "You can't vote on your own drawing",
      );
      yield* expectFailure(
        fooler!.c.games.submitVote({
          ...at(lobby.id),
          payload: { answer: foolerBluffId },
        }),
        "InvalidGameRequest",
        "You can't vote for your own bluff",
      );
      yield* expectFailure(
        fooler!.c.games.submitVote({
          ...at(lobby.id),
          payload: { answer: 99 },
        }),
        "InvalidGameRequest",
        "That answer isn't on the ballot",
      );
      yield* fooler!.c.games.submitVote({
        ...at(lobby.id),
        payload: { answer: realId },
      });
      yield* expectFailure(
        fooler!.c.games.submitVote({
          ...at(lobby.id),
          payload: { answer: realId },
        }),
        "InvalidGameRequest",
        "You already voted on this one",
      );
      view = yield* fooled!.c.games.submitVote({
        ...at(lobby.id),
        payload: { answer: foolerBluffId },
      });

      // --- Reveal ---------------------------------------------------------
      expect(view.drawing!.stage!.kind).toBe("reveal");
      const revealed = spotlightOf(view);
      expect(revealed.prompt).toBe(truth);
      const real = revealed.answers!.find((a) => a.real)!;
      expect(real).toMatchObject({
        text: truth,
        authorId: null,
        voterIds: [fooler!.id],
        points: 1000,
      });
      expect(
        revealed.answers!.find((a) => a.id === foolerBluffId),
      ).toMatchObject({
        real: false,
        authorId: fooler!.id,
        voterIds: [fooled!.id],
        points: 500,
      });
      // The fooling bluff flips first, the truth lands last.
      expect(real.revealAt!).toBeGreaterThan(
        revealed.answers!.find((a) => a.id === foolerBluffId)!.revealAt!,
      );

      // Once the reveal has played out, the scoreboard catches up.
      yield* advance(lobby.id, revealDurationMs(3));
      view = yield* alice.c.games.getGameLobby(at(lobby.id));
      const scores = new Map(
        view.drawing!.scores.map((s) => [s.userId, s.score]),
      );
      expect(scores.get(fooler!.id)).toBe(1500);
      expect(scores.get(artist.id)).toBe(1000);
      expect(scores.get(fooled!.id)).toBe(0);

      // --- The rest of the round times out; then the results. ------------
      yield* advance(lobby.id, 60 * 60_000);
      const done = yield* alice.c.games.getGameLobby(at(lobby.id));
      expect(done.phase).toBe("finished");
      expect(done.drawing!.stage).toBeNull();
      const podium = new Map(done.players.map((p) => [p.user.id, p]));
      expect(podium.get(fooler!.id)).toMatchObject({
        score: 1500,
        place: 1,
        accuracy: 100,
      });
      expect(podium.get(artist.id)).toMatchObject({ score: 1000, place: 2 });
      expect(podium.get(fooled!.id)).toMatchObject({ score: 0, place: 3 });
      // Every prompt is in the gallery now.
      expect(done.drawing!.drawings.map((d) => d.prompt).sort()).toEqual(
        [...prompts.values()].map((p) => p.prompt).sort(),
      );

      // Settled exactly once, however many reads find the game over.
      yield* players[1].c.games.getGameLobby(at(lobby.id));
      yield* players[2].c.games.getGameLobby(at(lobby.id));
      const db = yield* Db;
      const results = yield* Effect.promise(() =>
        db.select().from(gameResults).where(eq(gameResults.game, "drawing")),
      );
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.playerCount === 3 && r.round === 1)).toBe(
        true,
      );

      const board = yield* alice.c.games.getLeaderboard({
        ...drawingGame,
        query: {},
      });
      expect(board.entries[0]).toMatchObject({
        user: { id: fooler!.id },
        bestScore: 1500,
        wins: 1,
      });
    }),
  ));

test("no client can see another player's prompt before its reveal — in any response or event", () =>
  run(
    Effect.gen(function* () {
      const { lobby, players } = yield* threePlayerLobby;
      const [alice] = players;
      yield* alice.c.games.startGameLobby(at(lobby.id));
      const prompts = yield* promptsOf(lobby.id);
      yield* advance(lobby.id, DRAWING_COUNTDOWN_MS);

      // Every response any player gets from here on goes through this check.
      // `revealedIds`: drawings whose reveal has begun (the answer is then
      // fair game for everyone).
      const check = (
        viewer: (typeof players)[number],
        json: string,
        revealedIds: ReadonlySet<number>,
        onBallot: number | null,
      ) => {
        for (const [id, { artistId, prompt }] of prompts) {
          if (revealedIds.has(id) || artistId === viewer.id) continue;
          // The one exception: the spotlight's real title is on its own
          // ballot, as one unmarked line (checked separately below).
          if (id === onBallot) continue;
          expect(json).not.toContain(prompt);
        }
      };
      const lookAll = (revealedIds: ReadonlySet<number>) =>
        Effect.gen(function* () {
          for (const viewer of players) {
            const view = yield* viewer.c.games.getGameLobby(at(lobby.id));
            const stage = view.drawing!.stage;
            const onBallot = stage?.kind === "vote" ? stage.drawingId : null;
            check(viewer, JSON.stringify(view), revealedIds, onBallot);
            if (onBallot !== null) {
              const entry = spotlightOf(view);
              expect(
                entry.prompt === null || entry.artistId === viewer.id,
              ).toBe(true);
              expect(entry.answers!.every((a) => a.real === null)).toBe(true);
            }
            const list = yield* viewer.c.games.listGameLobbies(drawingGame);
            for (const { prompt } of prompts.values()) {
              expect(JSON.stringify(list)).not.toContain(prompt);
            }
          }
        });

      const revealed = new Set<number>();
      yield* lookAll(revealed);
      for (const player of players) {
        yield* player.c.games.submitDrawing({
          ...at(lobby.id),
          payload: { strokes: SCRIBBLE },
        });
        yield* lookAll(revealed);
      }
      // Each drawing in turn: bluffs, votes, reveal — looking at every step.
      for (let turn = 0; turn < players.length; turn++) {
        let view = yield* alice.c.games.getGameLobby(at(lobby.id));
        expect(view.drawing!.stage!.kind).toBe("bluff");
        const spotlight = spotlightOf(view);
        const guessers = players.filter((p) => p.id !== spotlight.artistId);
        for (const [index, guesser] of guessers.entries()) {
          yield* guesser.c.games.submitBluff({
            ...at(lobby.id),
            payload: { text: `made up title number ${turn}-${index}` },
          });
          yield* lookAll(revealed);
        }
        for (const guesser of guessers) {
          view = yield* guesser.c.games.getGameLobby(at(lobby.id));
          const pick = spotlightOf(view).answers!.find((a) => !a.mine)!;
          yield* guesser.c.games.submitVote({
            ...at(lobby.id),
            payload: { answer: pick.id },
          });
          if (guesser !== guessers.at(-1)) yield* lookAll(revealed);
        }
        revealed.add(spotlight.id);
        yield* lookAll(revealed);
        yield* advance(lobby.id, revealDurationMs(3));
      }

      // Realtime events are id-only: none of them ever carried a prompt, or
      // anything but a lobby id.
      expect(published.length).toBeGreaterThan(0);
      for (const message of published) {
        for (const { prompt } of prompts.values()) {
          expect(message).not.toContain(prompt);
        }
        expect(message).not.toContain("made up title");
      }
    }),
  ));

test("a player who drops out keeps their seat in the schedule without blocking it", () =>
  run(
    Effect.gen(function* () {
      const { lobby, players } = yield* threePlayerLobby;
      const [alice, bob, carol] = players;
      yield* alice.c.games.startGameLobby(at(lobby.id));
      yield* advance(lobby.id, DRAWING_COUNTDOWN_MS);
      yield* alice.c.games.submitDrawing({
        ...at(lobby.id),
        payload: { strokes: SCRIBBLE },
      });
      yield* bob.c.games.submitDrawing({
        ...at(lobby.id),
        payload: { strokes: SCRIBBLE },
      });
      // Carol closes her tab and never comes back.
      yield* carol.c.games.leaveGameLobby(at(lobby.id));
      // Leaving forfeits, so she can't act in the game any more — even
      // though she can still open the lobby to watch.
      yield* expectFailure(
        carol.c.games.submitDrawing({
          ...at(lobby.id),
          payload: { strokes: SCRIBBLE },
        }),
        "Forbidden",
        "You left this game",
      );

      // The draw stage waits out its timer, then plays on — her drawing
      // shows up blank rather than holding everyone up.
      let view = yield* alice.c.games.getGameLobby(at(lobby.id));
      expect(view.drawing!.stage!.kind).toBe("draw");
      yield* advance(lobby.id, 75_000);
      view = yield* alice.c.games.getGameLobby(at(lobby.id));
      expect(view.drawing!.stage!.kind).toBe("bluff");
      expect(view.drawing!.participantIds).toContain(carol.id);

      // A reload mid-round lands in exactly the same place.
      const again = yield* bob.c.games.getGameLobby(at(lobby.id));
      expect(again.drawing!.stage).toEqual(view.drawing!.stage);

      yield* advance(lobby.id, 60 * 60_000);
      view = yield* alice.c.games.getGameLobby(at(lobby.id));
      expect(view.phase).toBe("finished");
      const blank = view.drawing!.drawings.find(
        (d) => d.artistId === carol.id,
      )!;
      expect(blank).toMatchObject({ submitted: false, strokes: [] });

      // Leaving forfeits: only the players still seated are on record.
      const db = yield* Db;
      const results = yield* Effect.promise(() =>
        db.select().from(gameResults),
      );
      expect(results.map((r) => r.userId).sort()).toEqual(
        [alice.id, bob.id].sort((x, y) => x - y),
      );
    }),
  ));

test("a rematch clears the game, keeps the packs, and deals fresh prompts", () =>
  run(
    Effect.gen(function* () {
      const { lobby, players } = yield* threePlayerLobby;
      const [alice, bob] = players;
      yield* alice.c.games.startGameLobby(at(lobby.id));
      const firstDeal = [...(yield* promptsOf(lobby.id)).values()].map(
        (p) => p.prompt,
      );
      yield* expectFailure(
        alice.c.games.rematchGameLobby(at(lobby.id)),
        "InvalidGameRequest",
        "The current game hasn't finished yet",
      );
      yield* advance(lobby.id, 60 * 60_000);
      yield* expectFailure(
        bob.c.games.rematchGameLobby(at(lobby.id)),
        "Forbidden",
      );
      // Straight to a rematch, without anyone having looked at the results
      // first: they're still settled before the game is wiped.
      const rematched = yield* alice.c.games.rematchGameLobby(at(lobby.id));
      expect(rematched.phase).toBe("waiting");
      expect(rematched.round).toBe(2);
      expect(rematched.drawing).toMatchObject({
        packs: ["classics"],
        rounds: 1,
        drawings: [],
      });
      const db = yield* Db;
      expect(
        yield* Effect.promise(() => db.select().from(gameDrawings)),
      ).toHaveLength(0);
      expect(
        yield* Effect.promise(() => db.select().from(gameResults)),
      ).toHaveLength(3);

      yield* alice.c.games.startGameLobby(at(lobby.id));
      const secondDeal = [...(yield* promptsOf(lobby.id)).values()].map(
        (p) => p.prompt,
      );
      expect(secondDeal.filter((p) => firstDeal.includes(p))).toEqual([]);
    }),
  ));

test("the lobby chat closes while a game is in play, so nobody can type out a prompt", () =>
  run(
    Effect.gen(function* () {
      const { lobby, players } = yield* threePlayerLobby;
      const [alice, bob] = players;
      yield* bob.c.games.postGameChat({
        ...at(lobby.id),
        payload: { text: "ready when you are" },
      });
      const started = yield* alice.c.games.startGameLobby(at(lobby.id));
      expect(started.chatOpen).toBe(false);
      yield* expectFailure(
        bob.c.games.postGameChat({
          ...at(lobby.id),
          payload: { text: "mine is a cat" },
        }),
        "InvalidGameRequest",
      );
      yield* advance(lobby.id, 10_000);
      const drawing = yield* bob.c.games.getGameLobby(at(lobby.id));
      expect(drawing.phase).toBe("racing");
      expect(drawing.chatOpen).toBe(false);
      yield* expectFailure(
        bob.c.games.postGameChat({
          ...at(lobby.id),
          payload: { text: "mine is a cat" },
        }),
        "InvalidGameRequest",
      );

      // Once every prompt is out in the open, the chat reopens.
      yield* advance(lobby.id, 60 * 60_000);
      const over = yield* bob.c.games.getGameLobby(at(lobby.id));
      expect(over.phase).toBe("finished");
      expect(over.chatOpen).toBe(true);
      yield* bob.c.games.postGameChat({
        ...at(lobby.id),
        payload: { text: "gg" },
      });
      const { messages } = yield* alice.c.games.listGameChat(at(lobby.id));
      expect(messages.map((m) => m.text)).toEqual(["ready when you are", "gg"]);
    }),
  ));
