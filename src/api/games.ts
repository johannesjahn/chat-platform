import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";
import {
  REFLEX_DIRECTIONS,
  REFLEX_KINDS,
  REFLEX_ROUNDS,
} from "../games/reflex.ts";
import { isMinLength } from "./common.ts";
import { Forbidden, NotFound, TooManyRequests } from "./errors.ts";
import { User } from "./users.ts";

// --- Games (see GamesHandler.ts) -------------------------------------------
//
// The games feature is built to hold more than one game: lobbies, seats,
// realtime rooms, results, and the leaderboard are all keyed by a game slug,
// and only the rules of play (for the typing race: the passage bank and how
// a finish is scored — see src/games/typing.ts) are game-specific. Adding a
// game means adding its slug here plus its rules module; the lobby plumbing
// and the frontend's game-shell components (web/src/components/games) are
// shared.
//  - "typing":  Type Race — everyone races to type the same passage.
//  - "drawing": Sketchy — a Drawful-style party game: everyone draws a
//               secret prompt, bluffs fake titles for each other's drawings,
//               and votes for the real one (see src/games/drawing/).
//  - "reflex":  Reflex Rush — rounds of reaction tests (wait for green, dodge
//               the decoys, match the symbol, the arrow, the target), solo
//               or head to head (see src/games/reflex.ts).
export const GameId = Schema.Literals(["typing", "drawing", "reflex"]).annotate(
  {
    identifier: "GameId",
  },
);

export type GameId = typeof GameId.Type;

// Seats per typing lobby. Small on purpose: every racer's lane is on screen
// at once, and every progress frame fans out to the whole room. Each game
// sets its own bounds (see `GameRules` in src/games/rules.ts); a lobby
// reports them as `minPlayers`/`maxPlayers`.
export const MAX_GAME_LOBBY_PLAYERS = 6;

// The phase a lobby is in *right now*, derived at read time from what the
// host did and the clock (see `lobbyPhase` in games/lobbyStore.ts):
//  - "waiting":   gathering players; the host can start.
//  - "countdown": started, `startsAt` still in the future — the passage is
//                 revealed so racers can read ahead, but typing is locked.
//  - "racing":    between `startsAt` and `endsAt`, and someone hasn't
//                 finished yet.
//  - "finished":  everyone finished or `endsAt` passed; the host can rematch.
export const GameLobbyPhase = Schema.Literals([
  "waiting",
  "countdown",
  "racing",
  "finished",
]).annotate({ identifier: "GameLobbyPhase" });

export type GameLobbyPhase = typeof GameLobbyPhase.Type;

export const GameLobbyPlayer = Schema.Struct({
  user: User,
  joinedAt: Schema.Finite,
  // The four result fields are null until this player finishes the current
  // round. `score` is the game's headline number — words per minute for the
  // typing race, points for Sketchy (where `accuracy` is the share of this
  // player's votes that found the real title, and `durationMs` the length of
  // the whole game).
  durationMs: Schema.NullOr(Schema.Finite),
  score: Schema.NullOr(Schema.Finite),
  accuracy: Schema.NullOr(Schema.Finite),
  place: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "GameLobbyPlayer" });

export type GameLobbyPlayer = typeof GameLobbyPlayer.Type;

// --- Sketchy (the "drawing" game — see src/games/drawing/) -----------------
//
// Drawings are submitted as vector strokes on a fixed virtual canvas rather
// than as images: a few kilobytes of JSON, validated server-side, rendered
// (and replayed stroke by stroke) by the client at any size.
export const DRAWING_WIDTH = 800;

export const DRAWING_HEIGHT = 600;

// Colors are indexes into the client's fixed palette (`DRAWING_PALETTE` in
// web/src/lib/games/drawing.ts, which must stay this long) — the server only
// needs to know they're in range.
export const DRAWING_PALETTE_SIZE = 10;

// Hard caps on one drawing. A real 75-second sketch, with the client's point
// thinning, lands far below both.
export const MAX_DRAWING_STROKES = 400;

export const MAX_DRAWING_POINTS = 6000;

export const MAX_BLUFF_LENGTH = 60;

export const MIN_DRAWING_ROUNDS = 1;

export const MAX_DRAWING_ROUNDS = 3;

export const DrawingBrush = Schema.Literals(["thin", "thick"]).annotate({
  identifier: "DrawingBrush",
});

// One pen-down-to-pen-up line. `points` is flat — [x0, y0, x1, y1, …] — in
// whole canvas units; the pairing (even length, y within DRAWING_HEIGHT) and
// the drawing-wide point budget are checked by the handler, since a schema
// can only bound each number on its own.
export const DrawingStroke = Schema.Struct({
  color: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: DRAWING_PALETTE_SIZE - 1 }),
  ),
  brush: DrawingBrush,
  points: Schema.Array(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: DRAWING_WIDTH }),
    ),
  ).check(isMinLength(2), Schema.isMaxLength(MAX_DRAWING_POINTS * 2)),
}).annotate({ identifier: "DrawingStroke" });

export type DrawingStroke = typeof DrawingStroke.Type;

export const DrawingStrokes = Schema.Array(DrawingStroke).check(
  Schema.isMaxLength(MAX_DRAWING_STROKES),
);

// A theme pack, as the pack picker shows it. Deliberately *not* the prompt
// list — with it, a voter could look the real title up (see
// src/games/drawing/packs/).
export const DrawingPack = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  // A single emoji.
  icon: Schema.String,
  description: Schema.String,
  samples: Schema.Array(Schema.String),
  promptCount: Schema.Finite,
}).annotate({ identifier: "DrawingPack" });

export type DrawingPack = typeof DrawingPack.Type;

export const DrawingPackList = Schema.Struct({
  packs: Schema.Array(DrawingPack),
}).annotate({ identifier: "DrawingPackList" });

// Where a Sketchy game is inside the "racing" phase. Each round opens with a
// "draw" stage (everyone at once), then every drawing of that round takes a
// "bluff" → "vote" → "reveal" turn in the spotlight. Derived from the clock
// and the submissions at read time, exactly like `GameLobbyPhase`.
export const DrawingStageKind = Schema.Literals([
  "draw",
  "bluff",
  "vote",
  "reveal",
]).annotate({ identifier: "DrawingStageKind" });

export type DrawingStageKind = typeof DrawingStageKind.Type;

export const DrawingStage = Schema.Struct({
  kind: DrawingStageKind,
  // 1-based round within this game (see `rounds`).
  turn: Schema.Finite,
  // The drawing in the spotlight; null during "draw".
  drawingId: Schema.NullOr(Schema.Finite),
  // Epoch ms. `endsAt` can move *earlier* (everyone submitted) but never
  // later.
  startedAt: Schema.Finite,
  endsAt: Schema.Finite,
}).annotate({ identifier: "DrawingStage" });

export type DrawingStage = typeof DrawingStage.Type;

// One title on the vote ballot. Until the drawing's reveal, only `id`,
// `text` and `mine` are filled in — nothing in a pre-reveal answer tells the
// real title from a bluff.
export const DrawingAnswer = Schema.Struct({
  // Ballot position — what a vote submits.
  id: Schema.Finite,
  text: Schema.String,
  // The viewer can't vote for this one: it's their own bluff (or, for the
  // artist, their own prompt).
  mine: Schema.Boolean,
  real: Schema.NullOr(Schema.Boolean),
  // Who wrote this bluff; null for the real title.
  authorId: Schema.NullOr(Schema.Finite),
  voterIds: Schema.NullOr(Schema.Array(Schema.Finite)),
  // What this answer earned its author (the artist, for the real one).
  points: Schema.NullOr(Schema.Finite),
  // Epoch ms at which the live reveal turns this answer over — every client
  // plays the same sequence off the server's clock, the truth landing last.
  // Null for a bluff nobody picked (it isn't given a beat), and once the
  // game is over.
  revealAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "DrawingAnswer" });

export type DrawingAnswer = typeof DrawingAnswer.Type;

// One player's drawing, filtered for the viewer: strokes appear once the
// drawing reaches its bluff stage (the artist always sees their own), the
// prompt only at its reveal (the artist always knows theirs), the ballot
// from its vote stage on.
export const DrawingEntry = Schema.Struct({
  id: Schema.Finite,
  turn: Schema.Finite,
  // Order within the round's bluff/vote/reveal turns.
  position: Schema.Finite,
  artistId: Schema.Finite,
  submitted: Schema.Boolean,
  strokes: Schema.NullOr(DrawingStrokes),
  prompt: Schema.NullOr(Schema.String),
  revealed: Schema.Boolean,
  // How many bluffs/votes are in — the "3 of 5" progress, never who or what.
  bluffCount: Schema.Finite,
  voteCount: Schema.Finite,
  myBluff: Schema.NullOr(Schema.String),
  myVote: Schema.NullOr(Schema.Finite),
  answers: Schema.NullOr(Schema.Array(DrawingAnswer)),
}).annotate({ identifier: "DrawingEntry" });

export type DrawingEntry = typeof DrawingEntry.Type;

export const DrawingScore = Schema.Struct({
  userId: Schema.Finite,
  score: Schema.Finite,
}).annotate({ identifier: "DrawingScore" });

export const DrawingGame = Schema.Struct({
  // The host's picks (see `updateDrawingSettings`).
  packs: Schema.Array(Schema.String),
  rounds: Schema.Finite,
  // Null while waiting, counting down, or finished.
  stage: Schema.NullOr(DrawingStage),
  // The viewer's own secret prompt for the current round's draw stage.
  myPrompt: Schema.NullOr(Schema.String),
  // Everyone dealt into this game — fixed at the start, so a player who
  // leaves mid-game still has their drawing played out.
  participantIds: Schema.Array(Schema.Finite),
  drawings: Schema.Array(DrawingEntry),
  // Running totals over every drawing revealed so far, highest first.
  scores: Schema.Array(DrawingScore),
}).annotate({ identifier: "DrawingGame" });

export type DrawingGame = typeof DrawingGame.Type;

// --- Reflex Rush (the "reflex" game — see src/games/reflex.ts) -------------
//
// A game is a fixed schedule of rounds, laid out server-side from a secret
// seed when the host starts it. Every client plays the same schedule off
// the (server-corrected) clock, so everyone in a lobby gets each signal at
// the same instant.
export const ReflexKind = Schema.Literals(REFLEX_KINDS).annotate({
  identifier: "ReflexKind",
});

export type ReflexKind = typeof ReflexKind.Type;

export const ReflexDirection = Schema.Literals(REFLEX_DIRECTIONS).annotate({
  identifier: "ReflexDirection",
});

// Something shown before a round's signal: a decoy flash ("decoy", whose
// `variant` picks its look) or a wrong symbol ("match", whose `variant` is
// the symbol).
export const ReflexCue = Schema.Struct({
  at: Schema.Finite,
  variant: Schema.Finite,
}).annotate({ identifier: "ReflexCue" });

// One round. All times are epoch ms: the title card shows from `armAt`,
// presses count as false starts from `armAt + introMs` until `signalAt`,
// and the round is decided at `closeAt`.
export const ReflexRound = Schema.Struct({
  kind: ReflexKind,
  armAt: Schema.Finite,
  signalAt: Schema.Finite,
  closeAt: Schema.Finite,
  cues: Schema.Array(ReflexCue),
  // "match" only: the symbol to hit on.
  symbol: Schema.NullOr(Schema.Finite),
  // "arrow" only: the direction to press.
  direction: Schema.NullOr(ReflexDirection),
  // "target" only: its center, as fractions of the arena's width/height.
  target: Schema.NullOr(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
}).annotate({ identifier: "ReflexRound" });

export type ReflexRound = typeof ReflexRound.Type;

//  - "hit":   reacted in time (and, for an arrow or a target, correctly).
//  - "early": a false start — pressed before the signal (a decoy, a wrong
//             symbol), or within ANTICIPATION_MS of it.
//  - "miss":  never reacted within the window.
//  - "wrong": reacted in time, but with the wrong arrow or off the target.
export const ReflexOutcome = Schema.Literals([
  "hit",
  "early",
  "miss",
  "wrong",
]).annotate({ identifier: "ReflexOutcome" });

export const ReflexRoundResult = Schema.Struct({
  outcome: ReflexOutcome,
  reactionMs: Schema.NullOr(Schema.Finite),
  // Negative for a false start.
  points: Schema.Finite,
}).annotate({ identifier: "ReflexRoundResult" });

export type ReflexRoundResult = typeof ReflexRoundResult.Type;

export const ReflexPlayerResult = Schema.Struct({
  userId: Schema.Finite,
  rounds: Schema.Array(ReflexRoundResult),
}).annotate({ identifier: "ReflexPlayerResult" });

export const ReflexGame = Schema.Struct({
  // The title card's length before each round is armed.
  introMs: Schema.Finite,
  // Empty while waiting (the schedule is secret until the start).
  rounds: Schema.Array(ReflexRound),
  // The server-scored breakdown of everyone who has submitted their game.
  results: Schema.Array(ReflexPlayerResult),
}).annotate({ identifier: "ReflexGame" });

export type ReflexGame = typeof ReflexGame.Type;

export const GameLobby = Schema.Struct({
  id: Schema.Finite,
  game: GameId,
  hostId: Schema.Finite,
  phase: GameLobbyPhase,
  round: Schema.Finite,
  // Null while "waiting" — the text is only revealed once a race starts, so
  // nobody can rehearse it while the lobby fills. Always null in the lobby
  // browser listing.
  passage: Schema.NullOr(Schema.String),
  // Epoch ms; null while "waiting".
  startsAt: Schema.NullOr(Schema.Finite),
  endsAt: Schema.NullOr(Schema.Finite),
  // The server's clock when this response was built, so a client can correct
  // for its own clock skew when it renders the countdown and race timer.
  serverNow: Schema.Finite,
  // The host can't start with fewer seated players than this.
  minPlayers: Schema.Finite,
  maxPlayers: Schema.Finite,
  // Seated players, in join order.
  players: Schema.Array(GameLobbyPlayer),
  // Sketchy's state, filtered for the caller (see DrawingGame); null for
  // every other game. The lobby browser only ever gets the settings.
  drawing: Schema.NullOr(DrawingGame),
  // Reflex Rush's schedule and results (see ReflexGame); null for every
  // other game, and in the lobby browser.
  reflex: Schema.NullOr(ReflexGame),
  // Whether the lobby chat takes messages right now. Always open for the
  // typing race; closed while a Sketchy game is in play, since a chat line
  // is the easiest way to leak a secret prompt (reactions stay on).
  chatOpen: Schema.Boolean,
  createdAt: Schema.Finite,
}).annotate({ identifier: "GameLobby" });

export type GameLobby = typeof GameLobby.Type;

export const GameLobbyList = Schema.Struct({
  lobbies: Schema.Array(GameLobby),
}).annotate({ identifier: "GameLobbyList" });

// --- Lobby chat -------------------------------------------------------------
//
// A lobby's own little chat room — players and spectators alike. Lives and
// dies with the lobby (see `gameLobbyMessages` in db/schema.ts), and arrives
// live as an id-less `game_chat` event on the lobby's realtime room.
export const MAX_GAME_CHAT_LENGTH = 280;

// The chat shows (at most) this many of a lobby's newest messages.
export const GAME_CHAT_PAGE_SIZE = 50;

export const GameChatMessage = Schema.Struct({
  id: Schema.Finite,
  lobbyId: Schema.Finite,
  user: User,
  text: Schema.String,
  createdAt: Schema.Finite,
}).annotate({ identifier: "GameChatMessage" });

export type GameChatMessage = typeof GameChatMessage.Type;

export const GameChat = Schema.Struct({
  // Oldest first, ending with the newest. Leaves out anyone the caller has
  // blocked or muted.
  messages: Schema.Array(GameChatMessage),
}).annotate({ identifier: "GameChat" });

export const GameChatBody = Schema.Struct({
  text: Schema.Trim.check(
    isMinLength(1),
    Schema.isMaxLength(MAX_GAME_CHAT_LENGTH),
  ),
}).annotate({ identifier: "GameChatBody" });

// A finished race's submission. The server never takes a score from the
// client: it checks `typed` against the passage and times the finish off its
// own clock, and only `errors` (wrong keystrokes along the way, which it
// can't observe) is taken on trust — and it can only ever *lower* accuracy.
export const MAX_TYPED_LENGTH = 2000;

export const FinishRaceBody = Schema.Struct({
  typed: Schema.String.check(Schema.isMaxLength(MAX_TYPED_LENGTH)),
  errors: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 100_000 }),
  ),
}).annotate({ identifier: "FinishRaceBody" });

// A played Reflex Rush game, one entry per round in order. What's measured
// on the client — the reaction time — is judged, not trusted: under
// ANTICIPATION_MS it's a false start, an arrow must match the round's, a
// hit must land on the target. `early` is taken on trust, since it can only
// cost points.
export const ReflexTap = Schema.Struct({
  early: Schema.Boolean,
  reactionMs: Schema.NullOr(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 10_000 }),
    ),
  ),
  direction: Schema.NullOr(ReflexDirection),
  x: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  y: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
}).annotate({ identifier: "ReflexTap" });

export const FinishReflexBody = Schema.Struct({
  taps: Schema.Array(ReflexTap).check(Schema.isMaxLength(REFLEX_ROUNDS)),
}).annotate({ identifier: "FinishReflexBody" });

export const LeaderboardPeriod = Schema.Literals([
  "day",
  "week",
  "all",
]).annotate({ identifier: "LeaderboardPeriod" });

export type LeaderboardPeriod = typeof LeaderboardPeriod.Type;

export const LeaderboardEntry = Schema.Struct({
  rank: Schema.Finite,
  user: User,
  bestScore: Schema.Finite,
  averageScore: Schema.Finite,
  averageAccuracy: Schema.Finite,
  races: Schema.Finite,
  // First places in races against at least one opponent.
  wins: Schema.Finite,
}).annotate({ identifier: "LeaderboardEntry" });

export type LeaderboardEntry = typeof LeaderboardEntry.Type;

export const Leaderboard = Schema.Struct({
  game: GameId,
  period: LeaderboardPeriod,
  entries: Schema.Array(LeaderboardEntry),
  // The caller's own standing, even when it falls outside `entries` — null
  // when they have no results in the period.
  me: Schema.NullOr(LeaderboardEntry),
}).annotate({ identifier: "Leaderboard" });

export type Leaderboard = typeof Leaderboard.Type;

export const LEADERBOARD_SIZE = 25;

export class InvalidGameRequest extends Schema.TaggedError<InvalidGameRequest>()(
  "InvalidGameRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Anonymous (no `identifier`) for the reason in CLAUDE.md — a named path or
// query struct silently loses its parameters in the generated spec.
const GamePath = Schema.Struct({ game: GameId });

const GameLobbyIdPath = Schema.Struct({ id: Schema.Int });

export const LeaderboardQuery = Schema.Struct({
  period: Schema.optional(LeaderboardPeriod),
});

export const GameInviteBody = Schema.Struct({
  userId: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
}).annotate({ identifier: "GameInviteBody" });

export const DrawingSettingsBody = Schema.Struct({
  // Pack slugs (see `listDrawingPacks`); unknown ones are rejected.
  packs: Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(
    isMinLength(1),
    Schema.isMaxLength(20),
  ),
  rounds: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({
      minimum: MIN_DRAWING_ROUNDS,
      maximum: MAX_DRAWING_ROUNDS,
    }),
  ),
}).annotate({ identifier: "DrawingSettingsBody" });

export const SubmitDrawingBody = Schema.Struct({
  strokes: DrawingStrokes,
}).annotate({ identifier: "SubmitDrawingBody" });

export const SubmitBluffBody = Schema.Struct({
  text: Schema.Trim.check(isMinLength(1), Schema.isMaxLength(MAX_BLUFF_LENGTH)),
}).annotate({ identifier: "SubmitBluffBody" });

export const SubmitVoteBody = Schema.Struct({
  // A `DrawingAnswer.id` from the current ballot.
  answer: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SubmitVoteBody" });

export const GamesGroup = HttpApiGroup.make("games")
  .add(
    // Lobbies worth showing in the lobby browser: every lobby still
    // gathering players or mid-race, newest first. Abandoned ones (nobody
    // touched them in a while) are left out.
    HttpApiEndpoint.get("listGameLobbies", "/games/:game/lobbies", {
      params: GamePath,
      success: GameLobbyList,
    }).middleware(Authentication),
  )
  .add(
    // Opens a new lobby with the caller as host and only player. Leaves any
    // other lobby the caller was seated in first.
    HttpApiEndpoint.post("createGameLobby", "/games/:game/lobbies", {
      params: GamePath,
      success: GameLobby.pipe(HttpApiSchema.status(201)),
    }).middleware(Authentication),
  )
  .add(
    // Seats the caller in the fullest open lobby that still has room, or
    // opens a new one if there isn't any — the one-click "just let me race".
    HttpApiEndpoint.post("quickPlay", "/games/:game/quick-play", {
      params: GamePath,
      success: GameLobby,
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getGameLobby", "/games/lobbies/:id", {
      params: GameLobbyIdPath,
      success: GameLobby,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Idempotent for a player already seated. Only while "waiting" and not
    // full.
    HttpApiEndpoint.post("joinGameLobby", "/games/lobbies/:id/join", {
      params: GameLobbyIdPath,
      success: GameLobby,
      error: [NotFound, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Allowed in any phase. The last player out closes the lobby; a leaving
    // host hands the lobby to whoever joined next.
    HttpApiEndpoint.post("leaveGameLobby", "/games/lobbies/:id/leave", {
      params: GameLobbyIdPath,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Host-only, from "waiting": picks the passage and schedules the race a
    // short countdown from now.
    HttpApiEndpoint.post("startGameLobby", "/games/lobbies/:id/start", {
      params: GameLobbyIdPath,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Submits the caller's finished race — see FinishRaceBody for what is
    // (and isn't) trusted. Records the result for the leaderboard.
    HttpApiEndpoint.post("finishRace", "/games/lobbies/:id/finish", {
      params: GameLobbyIdPath,
      payload: FinishRaceBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Reflex Rush: submits the caller's whole game once its last round has
    // closed — see FinishReflexBody for what is (and isn't) trusted. Places
    // and leaderboard results are settled once everyone is in (or time's
    // up).
    HttpApiEndpoint.post("finishReflex", "/games/lobbies/:id/reflex", {
      params: GameLobbyIdPath,
      payload: FinishReflexBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Host-only, from "finished": resets the lobby to "waiting" for another
    // round with the same players.
    HttpApiEndpoint.post("rematchGameLobby", "/games/lobbies/:id/rematch", {
      params: GameLobbyIdPath,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Seated-players-only: invites another user into the caller's lobby. The
    // invitee gets a `game_invite` notification linking to it — nothing is
    // reserved for them, so a lobby that fills up or starts in the meantime
    // is simply not joinable when they arrive. Only while "waiting".
    HttpApiEndpoint.post("inviteToGameLobby", "/games/lobbies/:id/invite", {
      params: GameLobbyIdPath,
      payload: GameInviteBody,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, InvalidGameRequest, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // The lobby chat's newest messages (see GameChat).
    HttpApiEndpoint.get("listGameChat", "/games/lobbies/:id/chat", {
      params: GameLobbyIdPath,
      success: GameChat,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Says something in the lobby chat — anyone looking at the lobby may,
    // seated or spectating, while `chatOpen`. Rate-limited per user.
    HttpApiEndpoint.post("postGameChat", "/games/lobbies/:id/chat", {
      params: GameLobbyIdPath,
      payload: GameChatBody,
      success: GameChatMessage.pipe(HttpApiSchema.status(201)),
      error: [NotFound, InvalidGameRequest, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Sketchy's theme packs, for the host's pack picker — never the prompts
    // themselves (see DrawingPack).
    HttpApiEndpoint.get("listDrawingPacks", "/games/drawing/packs", {
      success: DrawingPackList,
    }).middleware(Authentication),
  )
  .add(
    // Host-only, while "waiting", Sketchy only: picks the theme packs and
    // round count. Everyone in the lobby sees the change live.
    HttpApiEndpoint.put(
      "updateDrawingSettings",
      "/games/lobbies/:id/settings",
      {
        params: GameLobbyIdPath,
        payload: DrawingSettingsBody,
        success: GameLobby,
        error: [NotFound, Forbidden, InvalidGameRequest],
      },
    ).middleware(Authentication),
  )
  .add(
    // Sketchy, "draw" stage: submits the caller's drawing for this round.
    // Once per drawing; a submission landing a moment after the timer is
    // still accepted, since the client sends whatever is on the canvas when
    // time runs out.
    HttpApiEndpoint.post("submitDrawing", "/games/lobbies/:id/drawing", {
      params: GameLobbyIdPath,
      payload: SubmitDrawingBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Sketchy, "bluff" stage: a fake title for the drawing in the spotlight.
    // Not for its artist; rejected if it's too close to the real prompt or
    // repeats another player's bluff.
    HttpApiEndpoint.post("submitBluff", "/games/lobbies/:id/bluff", {
      params: GameLobbyIdPath,
      payload: SubmitBluffBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Sketchy, "vote" stage: the caller's pick for the real title. Not for
    // the artist, and never for your own bluff.
    HttpApiEndpoint.post("submitVote", "/games/lobbies/:id/vote", {
      params: GameLobbyIdPath,
      payload: SubmitVoteBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Ranked by each player's best score in the period (default: all time).
    HttpApiEndpoint.get("getLeaderboard", "/games/:game/leaderboard", {
      params: GamePath,
      query: LeaderboardQuery,
      success: Leaderboard,
    }).middleware(Authentication),
  );
