import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import {
  DRAWING_HEIGHT,
  Forbidden,
  MAX_DRAWING_POINTS,
  type DrawingStroke,
  type GameId,
} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import {
  gameBluffs,
  gameDrawings,
  gameLobbies,
  gameVotes,
} from "../db/schema.ts";
import { buildBallot } from "./drawing/ballot.ts";
import {
  bluffsFor,
  participantsOf,
  type DrawingGameRows,
} from "./drawing/model.ts";
import { DRAWING_PACKS, findDrawingPack } from "./drawing/packs/index.ts";
import { isTooCloseToPrompt, normalizeTitle } from "./drawing/prompts.ts";
import { DRAWING_SUBMIT_GRACE_MS } from "./drawing/rules.ts";
import { currentStage, type TimelineStage } from "./drawing/timeline.ts";
import { GAME_RULES } from "./rules.ts";
import { type GamesDeps, type GamesHandlers } from "./handlerKit.ts";
import {
  invalid,
  loadLobbyOr404,
  loadSnapshot,
  notifyLobbyChanged,
  requireHost,
  settingsOf,
  touchLobby,
  type LobbySnapshot,
} from "./lobbyStore.ts";
import { buildLobby } from "./settlement.ts";

// A started Sketchy game's state, or a 400 for anything else — the common
// preamble of every Sketchy submission.
const requireDrawingGame = (snapshot: LobbySnapshot) =>
  snapshot.drawing && snapshot.lobby.status === "started"
    ? Effect.succeed(snapshot.drawing)
    : invalid(
        snapshot.drawing
          ? "The game hasn't started yet"
          : "This isn't a Sketchy lobby",
      );

// A caller dealt into this Sketchy game and still seated. Someone who left
// keeps their place in the schedule (their drawing still plays out), but
// leaving forfeits — they aren't on the final record, so they mustn't be
// able to sway anyone else's score with a bluff or a vote. Anyone can
// still open the lobby's page to spectate, so this has to be enforced here.
const requireSeatedParticipant = (
  snapshot: LobbySnapshot,
  rows: DrawingGameRows,
  userId: number,
) =>
  !participantsOf(rows).includes(userId)
    ? Effect.fail(new Forbidden({ message: "You're not playing in this game" }))
    : !snapshot.players.some((player) => player.user.id === userId)
      ? Effect.fail(new Forbidden({ message: "You left this game" }))
      : Effect.void;

// A drawing's strokes as the schema can't check them on its own: points
// come in (x, y) pairs, y stays on the canvas, and the whole drawing keeps
// to the point budget.
const validateStrokes = (strokes: ReadonlyArray<DrawingStroke>) => {
  let total = 0;
  for (const stroke of strokes) {
    if (stroke.points.length % 2 !== 0) {
      return invalid("Every stroke point needs an x and a y");
    }
    for (let i = 1; i < stroke.points.length; i += 2) {
      if (stroke.points[i]! > DRAWING_HEIGHT) {
        return invalid("A stroke goes off the canvas");
      }
    }
    total += stroke.points.length / 2;
  }
  return total > MAX_DRAWING_POINTS
    ? invalid("That drawing has too many points")
    : Effect.void;
};

// The draw stage a drawing submitted `now` belongs to: the one in progress,
// or one whose timer ran out within the grace period.
const drawStageAt = (timeline: ReadonlyArray<TimelineStage>, now: number) =>
  timeline.find(
    (stage) =>
      stage.kind === "draw" &&
      stage.startedAt <= now &&
      now < stage.endsAt + DRAWING_SUBMIT_GRACE_MS,
  );

// The drawing in the spotlight, if the game is in a `kind` stage right now.
const spotlightAt = (
  drawing: NonNullable<LobbySnapshot["drawing"]>,
  kind: "bluff" | "vote",
  now: number,
) => {
  const stage = currentStage(drawing.timeline, now);
  if (stage?.kind !== kind || stage.drawingId === null) return null;
  return (
    drawing.rows.drawings.find((row) => row.id === stage.drawingId) ?? null
  );
};

export const drawingHandlers = ({ db, connections }: GamesDeps) =>
  ({
    listDrawingPacks: () =>
      Effect.succeed({
        packs: DRAWING_PACKS.map((pack) => ({
          slug: pack.slug,
          name: pack.name,
          icon: pack.icon,
          description: pack.description,
          samples: pack.prompts.slice(0, 3),
          promptCount: pack.prompts.length,
        })),
      }),
    updateDrawingSettings: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const lobby = yield* loadLobbyOr404(db, id);
        if (GAME_RULES[lobby.game as GameId].kind !== "drawing") {
          return yield* invalid("This game has no settings");
        }
        yield* requireHost(lobby, currentUser.id, "change the settings");
        if (lobby.status !== "waiting") {
          return yield* invalid(
            "Settings can only be changed before the game starts",
          );
        }
        const packs = [...new Set(payload.packs)];
        const unknown = packs.find((slug) => !findDrawingPack(slug));
        if (unknown !== undefined) {
          return yield* invalid(`Unknown theme pack: ${unknown}`);
        }
        const updated = yield* Effect.tryPromise(() =>
          db
            .update(gameLobbies)
            .set({
              settings: {
                // In the picker's order, whatever order they were sent in.
                packs: DRAWING_PACKS.map((pack) => pack.slug).filter((slug) =>
                  packs.includes(slug),
                ),
                rounds: payload.rounds,
                recentPrompts: settingsOf(lobby).recentPrompts ?? [],
              },
              updatedAt: new Date(),
            })
            .where(
              and(eq(gameLobbies.id, id), eq(gameLobbies.status, "waiting")),
            )
            .returning({ id: gameLobbies.id }),
        ).pipe(Effect.orDie);
        if (updated.length === 0) {
          return yield* invalid(
            "Settings can only be changed before the game starts",
          );
        }
        yield* notifyLobbyChanged(connections, lobby);
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
    submitDrawing: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* validateStrokes(payload.strokes);
        const snapshot = yield* loadSnapshot(db, id);
        const game = yield* requireDrawingGame(snapshot);
        yield* requireSeatedParticipant(snapshot, game.rows, currentUser.id);
        const stage = drawStageAt(game.timeline, snapshot.now);
        if (!stage) return yield* invalid("It isn't time to draw");
        const mine = game.rows.drawings.find(
          (row) => row.turn === stage.turn && row.artistId === currentUser.id,
        );
        if (!mine) return yield* invalid("You have nothing to draw");
        const saved = yield* Effect.tryPromise(() =>
          db
            .update(gameDrawings)
            .set({
              strokes: payload.strokes,
              submittedAt: new Date(snapshot.now),
            })
            .where(
              and(
                eq(gameDrawings.id, mine.id),
                isNull(gameDrawings.submittedAt),
              ),
            )
            .returning({ id: gameDrawings.id }),
        ).pipe(Effect.orDie);
        if (saved.length === 0) {
          return yield* invalid("You already submitted your drawing");
        }
        yield* touchLobby(db, id);
        yield* notifyLobbyChanged(connections, snapshot.lobby);
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
    submitBluff: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const snapshot = yield* loadSnapshot(db, id);
        const game = yield* requireDrawingGame(snapshot);
        yield* requireSeatedParticipant(snapshot, game.rows, currentUser.id);
        const drawing = spotlightAt(game, "bluff", snapshot.now);
        if (!drawing) return yield* invalid("It isn't time to bluff");
        if (drawing.artistId === currentUser.id) {
          return yield* invalid("You can't bluff on your own drawing");
        }
        const normalized = normalizeTitle(payload.text);
        if (normalized.length === 0) {
          return yield* invalid("Write a title with some words in it");
        }
        if (isTooCloseToPrompt(payload.text, drawing.prompt)) {
          return yield* invalid("Too close to the truth — try another.");
        }
        const bluffs = bluffsFor(game.rows, drawing.id);
        if (bluffs.some((bluff) => bluff.authorId === currentUser.id)) {
          return yield* invalid("You already wrote a bluff for this one");
        }
        if (bluffs.some((bluff) => normalizeTitle(bluff.text) === normalized)) {
          return yield* invalid("Someone already wrote that — try another.");
        }
        // Stamped with the instant the stage was checked against, so the
        // timeline sees it land inside the stage (see `stageEnd`).
        const inserted = yield* Effect.tryPromise(() =>
          db
            .insert(gameBluffs)
            .values({
              drawingId: drawing.id,
              authorId: currentUser.id,
              text: payload.text,
              normalized,
              createdAt: new Date(snapshot.now),
            })
            .onConflictDoNothing()
            .returning({ id: gameBluffs.id }),
        ).pipe(Effect.orDie);
        // Lost a race with a double-submit (this author already has a
        // bluff here) or with an identical bluff from someone else — the
        // two unique constraints `onConflictDoNothing` can hit.
        if (inserted.length === 0) {
          const own = yield* Effect.tryPromise(() =>
            db
              .select({ id: gameBluffs.id })
              .from(gameBluffs)
              .where(
                and(
                  eq(gameBluffs.drawingId, drawing.id),
                  eq(gameBluffs.authorId, currentUser.id),
                ),
              )
              .limit(1),
          ).pipe(Effect.orDie);
          return yield* invalid(
            own.length > 0
              ? "You already wrote a bluff for this one"
              : "Someone already wrote that — try another.",
          );
        }
        yield* touchLobby(db, id);
        yield* notifyLobbyChanged(connections, snapshot.lobby);
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
    submitVote: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const snapshot = yield* loadSnapshot(db, id);
        const game = yield* requireDrawingGame(snapshot);
        yield* requireSeatedParticipant(snapshot, game.rows, currentUser.id);
        const drawing = spotlightAt(game, "vote", snapshot.now);
        if (!drawing) return yield* invalid("It isn't time to vote");
        if (drawing.artistId === currentUser.id) {
          return yield* invalid("You can't vote on your own drawing");
        }
        const choice = buildBallot(drawing, bluffsFor(game.rows, drawing.id))[
          payload.answer
        ];
        if (!choice) return yield* invalid("That answer isn't on the ballot");
        if (choice.kind === "bluff" && choice.authorId === currentUser.id) {
          return yield* invalid("You can't vote for your own bluff");
        }
        const inserted = yield* Effect.tryPromise(() =>
          db
            .insert(gameVotes)
            .values({
              drawingId: drawing.id,
              voterId: currentUser.id,
              bluffId: choice.kind === "bluff" ? choice.bluffId : null,
              createdAt: new Date(snapshot.now),
            })
            .onConflictDoNothing()
            .returning({ id: gameVotes.id }),
        ).pipe(Effect.orDie);
        if (inserted.length === 0) {
          return yield* invalid("You already voted on this one");
        }
        yield* touchLobby(db, id);
        yield* notifyLobbyChanged(connections, snapshot.lobby);
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
  }) satisfies GamesHandlers;
