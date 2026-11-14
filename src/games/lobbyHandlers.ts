import { and, asc, desc, eq, gt, isNull, lt, ne } from "drizzle-orm";
import { Effect, Metric } from "effect";
import {
  Forbidden,
  InvalidGameRequest,
  NotFound,
  TooManyRequests,
  type GameId,
} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import {
  gameDrawings,
  gameLobbies,
  gameLobbyPlayers,
  notifications,
  users,
  type DrawingLobbySettings,
} from "../db/schema.ts";
import { promptPool } from "./drawing/packs/index.ts";
import { dealPrompts, secureRandomInt, shuffled } from "./drawing/prompts.ts";
import { DEFAULT_DRAWING_SETTINGS } from "./drawing/rules.ts";
import { worstCaseDurationMs } from "./drawing/timeline.ts";
import { buildReflexPlan, reflexSeedToPassage } from "./reflex.ts";
import { GAME_RULES } from "./rules.ts";
import { rateLimitRejectionsTotal } from "../Metrics.ts";
import { createNotifications } from "../notifications.ts";
import { RateLimiter } from "../RateLimiter.ts";
import { RealtimeConnections } from "../Realtime.ts";
import { type GamesDeps, type GamesHandlers } from "./handlerKit.ts";
import {
  dieOnVanishedLobby,
  invalid,
  loadLobby,
  loadLobbyOr404,
  loadPlayers,
  loadSnapshot,
  loadSnapshots,
  notifyLobbyChanged,
  requireHost,
  settingsOf,
  toApiLobby,
  touchLobby,
} from "./lobbyStore.ts";
import { buildLobby, settleIfOver } from "./settlement.ts";

// A lobby nobody has touched (joined, left, started, finished, rematched)
// for this long is presumed abandoned — a closed tab never says goodbye — and
// is left out of the lobby browser and quick play.
const STALE_LOBBY_MS = 15 * 60_000;

// Long past stale: creating a lobby sweeps these away entirely, so abandoned
// rows don't accumulate without needing a background job.
const DEAD_LOBBY_MS = 6 * 60 * 60_000;

// The lobby browser shows at most this many lobbies.
const MAX_LISTED_LOBBIES = 30;

// Unseats `userId` from `lobbyId`: the last player out closes the lobby, and
// a departing host hands it to whoever has been seated longest.
const leaveLobby = (
  db: DrizzleDb,
  connections: RealtimeConnections["Service"],
  lobbyId: number,
  userId: number,
) =>
  Effect.gen(function* () {
    const removed = yield* dbQuery(() =>
      db
        .delete(gameLobbyPlayers)
        .where(
          and(
            eq(gameLobbyPlayers.lobbyId, lobbyId),
            eq(gameLobbyPlayers.userId, userId),
          ),
        )
        .returning({ id: gameLobbyPlayers.id }),
    );
    if (removed.length === 0) return;

    const lobby = yield* loadLobby(db, lobbyId);
    if (!lobby) return;
    const remaining = yield* dbQuery(() =>
      db
        .select({ userId: gameLobbyPlayers.userId })
        .from(gameLobbyPlayers)
        .where(eq(gameLobbyPlayers.lobbyId, lobbyId))
        .orderBy(asc(gameLobbyPlayers.joinedAt), asc(gameLobbyPlayers.id)),
    );

    if (remaining.length === 0) {
      yield* dbQuery(() =>
        db.delete(gameLobbies).where(eq(gameLobbies.id, lobbyId)),
      );
    } else if (lobby.hostId === userId) {
      yield* touchLobby(db, lobbyId, { hostId: remaining[0]!.userId });
    } else {
      yield* touchLobby(db, lobbyId);
    }
    yield* notifyLobbyChanged(connections, lobby);
  });

// One lobby at a time: sitting down somewhere new stands you up everywhere
// else, so a forgotten tab can't leave a ghost seat behind.
const leaveOtherLobbies = (
  db: DrizzleDb,
  connections: RealtimeConnections["Service"],
  userId: number,
  keepLobbyId: number | null,
) =>
  Effect.gen(function* () {
    const seats = yield* dbQuery(() =>
      db
        .select({ lobbyId: gameLobbyPlayers.lobbyId })
        .from(gameLobbyPlayers)
        .where(
          keepLobbyId === null
            ? eq(gameLobbyPlayers.userId, userId)
            : and(
                eq(gameLobbyPlayers.userId, userId),
                ne(gameLobbyPlayers.lobbyId, keepLobbyId),
              ),
        ),
    );
    yield* Effect.forEach(
      seats,
      (seat) => leaveLobby(db, connections, seat.lobbyId, userId),
      { discard: true },
    );
  });

const joinLobby = (
  db: DrizzleDb,
  connections: RealtimeConnections["Service"],
  lobbyId: number,
  userId: number,
) =>
  Effect.gen(function* () {
    const lobby = yield* loadLobbyOr404(db, lobbyId);
    const players = (yield* loadPlayers(db, [lobbyId])).get(lobbyId) ?? [];
    if (players.some((player) => player.user.id === userId)) {
      return yield* buildLobby({ db, connections }, lobbyId, userId);
    }
    if (lobby.status !== "waiting") {
      return yield* Effect.fail(
        new InvalidGameRequest({ message: "This game has already started" }),
      );
    }
    if (players.length >= lobby.maxPlayers) {
      return yield* Effect.fail(
        new InvalidGameRequest({ message: "This lobby is full" }),
      );
    }
    yield* leaveOtherLobbies(db, connections, userId, lobbyId);
    yield* dbQuery(() =>
      db
        .insert(gameLobbyPlayers)
        .values({ lobbyId, userId })
        .onConflictDoNothing(),
    );
    yield* touchLobby(db, lobbyId);
    yield* notifyLobbyChanged(connections, lobby);
    return yield* buildLobby({ db, connections }, lobbyId, userId);
  });

const createLobby = (
  db: DrizzleDb,
  connections: RealtimeConnections["Service"],
  game: GameId,
  userId: number,
) =>
  Effect.gen(function* () {
    yield* leaveOtherLobbies(db, connections, userId, null);
    // Opportunistic cleanup of long-abandoned lobbies (their seats cascade).
    yield* dbQuery(() =>
      db
        .delete(gameLobbies)
        .where(lt(gameLobbies.updatedAt, new Date(Date.now() - DEAD_LOBBY_MS))),
    );
    const rules = GAME_RULES[game];
    const [lobby] = yield* dbQuery(() =>
      db
        .insert(gameLobbies)
        .values({
          game,
          hostId: userId,
          maxPlayers: rules.maxPlayers,
          settings: rules.kind === "drawing" ? DEFAULT_DRAWING_SETTINGS : null,
        })
        .returning(),
    );
    yield* dbQuery(() =>
      db.insert(gameLobbyPlayers).values({ lobbyId: lobby!.id, userId }),
    );
    yield* notifyLobbyChanged(connections, lobby!);
    return yield* buildLobby({ db, connections }, lobby!.id, userId);
  });

// Each invite drops a notification into someone else's inbox, so it gets the
// same kind of per-user cap as the engagement writes (see
// EngagementHandler.ts) — generous for a human filling a lobby, but a bound
// on scripting invites at the whole user directory.
const GAME_INVITE_MAX_PER_USER = 30;

const GAME_INVITE_WINDOW_SECONDS = 60;

const enforceInviteLimit = (limiter: RateLimiter["Service"], userId: number) =>
  Effect.gen(function* () {
    const result = yield* limiter.consume(
      `games:invite:user:${userId}`,
      GAME_INVITE_MAX_PER_USER,
      GAME_INVITE_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      yield* Metric.update(
        Metric.withAttributes(rateLimitRejectionsTotal, {
          limiter: "game_invite",
        }),
        1,
      );
      return yield* Effect.fail(
        new TooManyRequests({
          message: "Too many invites. Please try again later.",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
    }
  });

// Prompts dealt recently by this process, across every lobby, newest last. A
// fresh lobby has no rematch history, so without this two games on the same
// pack would each draw from the full pool and repeat prompts often. Per
// process on purpose: it only nudges variety, it isn't correctness state.
const RECENT_DEALT_CAP = 240;

const recentlyDealt: string[] = [];

const rememberDealt = (prompts: ReadonlyArray<string>) => {
  recentlyDealt.push(...prompts);
  if (recentlyDealt.length > RECENT_DEALT_CAP)
    recentlyDealt.splice(0, recentlyDealt.length - RECENT_DEALT_CAP);
};

// Deals a Sketchy game: every seated player gets one drawing per round, each
// with a distinct prompt from the selected packs, in a shuffled order per
// round. Null when the packs can't cover the deal.
const dealDrawings = (
  lobbyId: number,
  playerIds: ReadonlyArray<number>,
  settings: DrawingLobbySettings,
) => {
  const prompts = dealPrompts(
    promptPool(settings.packs),
    playerIds.length * settings.rounds,
    [...(settings.recentPrompts ?? []), ...recentlyDealt],
  );
  if (!prompts) return null;
  rememberDealt(prompts);
  return Array.from({ length: settings.rounds }, (_, index) => index + 1)
    .flatMap((turn) =>
      shuffled(playerIds, secureRandomInt).map((artistId, position) => ({
        lobbyId,
        artistId,
        turn,
        position,
      })),
    )
    .map((drawing, index) => ({
      ...drawing,
      prompt: prompts[index]!,
      shuffleSeed: secureRandomInt(0x7fff_ffff),
    }));
};

export const lobbyHandlers = ({ limiter, db, connections }: GamesDeps) =>
  ({
    listGameLobbies: ({ params: { game } }) =>
      Effect.gen(function* () {
        const now = Date.now();
        const lobbies = yield* dbQuery(() =>
          db
            .select()
            .from(gameLobbies)
            .where(
              and(
                eq(gameLobbies.game, game),
                gt(gameLobbies.updatedAt, new Date(now - STALE_LOBBY_MS)),
              ),
            )
            .orderBy(desc(gameLobbies.updatedAt), desc(gameLobbies.id))
            .limit(MAX_LISTED_LOBBIES),
        );
        const snapshots = yield* loadSnapshots(db, lobbies);
        return {
          lobbies: snapshots
            // A finished game is only interesting to the people in it,
            // until the host rematches it back to "waiting".
            .filter((snapshot) => snapshot.phase !== "finished")
            .map((snapshot) => toApiLobby(snapshot, null)),
        };
      }),
    createGameLobby: ({ params: { game } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        return yield* createLobby(db, connections, game, currentUser.id);
      }).pipe(dieOnVanishedLobby),
    quickPlay: ({ params: { game } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const now = Date.now();
        const open = yield* dbQuery(() =>
          db
            .select()
            .from(gameLobbies)
            .where(
              and(
                eq(gameLobbies.game, game),
                eq(gameLobbies.status, "waiting"),
                gt(gameLobbies.updatedAt, new Date(now - STALE_LOBBY_MS)),
              ),
            )
            .orderBy(desc(gameLobbies.updatedAt)),
        );
        const players = yield* loadPlayers(
          db,
          open.map((lobby) => lobby.id),
        );
        // Already waiting somewhere? Stay put rather than hop lobbies.
        const seated = open.find((lobby) =>
          (players.get(lobby.id) ?? []).some(
            (player) => player.user.id === currentUser.id,
          ),
        );
        if (seated)
          return yield* buildLobby(
            { db, connections },
            seated.id,
            currentUser.id,
          );
        // Fullest lobby with room first — gets a race going soonest.
        const candidate = open
          .filter(
            (lobby) => (players.get(lobby.id)?.length ?? 0) < lobby.maxPlayers,
          )
          .sort(
            (a, b) =>
              (players.get(b.id)?.length ?? 0) -
              (players.get(a.id)?.length ?? 0),
          )[0];
        if (candidate) {
          const joined = yield* joinLobby(
            db,
            connections,
            candidate.id,
            currentUser.id,
          ).pipe(Effect.option);
          if (joined._tag === "Some") return joined.value;
        }
        return yield* createLobby(db, connections, game, currentUser.id);
      }).pipe(dieOnVanishedLobby),
    getGameLobby: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
    joinGameLobby: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        return yield* joinLobby(db, connections, id, currentUser.id);
      }),
    leaveGameLobby: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* loadLobbyOr404(db, id);
        yield* leaveLobby(db, connections, id, currentUser.id);
      }),
    startGameLobby: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const lobby = yield* loadLobbyOr404(db, id);
        yield* requireHost(lobby, currentUser.id, "start the game");
        const rules = GAME_RULES[lobby.game as GameId];
        const players = (yield* loadPlayers(db, [id])).get(id) ?? [];
        if (lobby.status !== "waiting") {
          return yield* invalid("The game already started");
        }
        if (players.length < rules.minPlayers) {
          return yield* invalid(
            `This game needs at least ${rules.minPlayers} players`,
          );
        }
        const startsAt = new Date(Date.now() + rules.countdownMs);

        if (rules.kind === "race" || rules.kind === "reflex") {
          let passage: string;
          let lengthMs: number;
          if (rules.kind === "race") {
            passage = rules.pickPassage(lobby.passage);
            lengthMs = rules.timeLimitMs;
          } else {
            const seed = secureRandomInt(0x7fff_ffff);
            passage = reflexSeedToPassage(seed);
            lengthMs = buildReflexPlan(seed).endsAt;
          }
          // Conditional on still "waiting", so a double-click (or two
          // tabs) can't restart a race that's already counting down.
          const started = yield* dbQuery(() =>
            db
              .update(gameLobbies)
              .set({
                status: "started",
                passage,
                startsAt,
                endsAt: new Date(startsAt.getTime() + lengthMs),
                updatedAt: new Date(),
              })
              .where(
                and(eq(gameLobbies.id, id), eq(gameLobbies.status, "waiting")),
              )
              .returning({ id: gameLobbies.id }),
          );
          if (started.length === 0) {
            return yield* invalid("The game already started");
          }
        } else {
          const settings = settingsOf(lobby);
          const drawings = dealDrawings(
            id,
            players.map((player) => player.user.id),
            settings,
          );
          if (!drawings) {
            return yield* invalid(
              "The selected packs don't have enough prompts for this many players",
            );
          }
          // The deal and the status flip land together: a reader must
          // never see a started game with no drawings (its timeline would
          // be empty, i.e. over before it began).
          const started = yield* dbQuery(() =>
            db.transaction(async (tx) => {
              const flipped = await tx
                .update(gameLobbies)
                .set({
                  status: "started",
                  startsAt,
                  endsAt: new Date(
                    startsAt.getTime() +
                      worstCaseDurationMs(players.length, settings.rounds),
                  ),
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(gameLobbies.id, id),
                    eq(gameLobbies.status, "waiting"),
                  ),
                )
                .returning({ id: gameLobbies.id });
              if (flipped.length === 0) return false;
              await tx.insert(gameDrawings).values(drawings);
              return true;
            }),
          );
          if (!started) return yield* invalid("The game already started");
        }
        yield* notifyLobbyChanged(connections, lobby);
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
    inviteToGameLobby: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const lobby = yield* loadLobbyOr404(db, id);
        const players = (yield* loadPlayers(db, [id])).get(id) ?? [];
        if (!players.some((player) => player.user.id === currentUser.id)) {
          return yield* Effect.fail(
            new Forbidden({
              message: "Only players in this lobby can invite others",
            }),
          );
        }
        if (payload.userId === currentUser.id) {
          return yield* Effect.fail(
            new InvalidGameRequest({ message: "You can't invite yourself" }),
          );
        }
        if (lobby.status !== "waiting") {
          return yield* invalid(
            "Invites can only be sent before the game starts",
          );
        }
        if (players.some((player) => player.user.id === payload.userId)) {
          return yield* Effect.fail(
            new InvalidGameRequest({
              message: "That player is already in this lobby",
            }),
          );
        }
        if (players.length >= lobby.maxPlayers) {
          return yield* Effect.fail(
            new InvalidGameRequest({ message: "This lobby is full" }),
          );
        }
        const invitee = yield* dbQuery(() =>
          db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, payload.userId))
            .limit(1),
        );
        if (invitee.length === 0) {
          return yield* Effect.fail(
            new NotFound({ message: "User not found" }),
          );
        }
        yield* enforceInviteLimit(limiter, currentUser.id);
        // Re-inviting someone who hasn't opened the last invite to this
        // same lobby yet is a no-op rather than a second inbox entry.
        const pending = yield* dbQuery(() =>
          db
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, payload.userId),
                eq(notifications.actorId, currentUser.id),
                eq(notifications.type, "game_invite"),
                eq(notifications.lobbyId, id),
                isNull(notifications.readAt),
              ),
            )
            .limit(1),
        );
        if (pending.length > 0) return;
        // A recipient who blocked/muted the caller is silently skipped
        // inside createNotifications — the response is the same either
        // way, so an invite can't be used to probe for a block.
        yield* createNotifications({ db, connections }, [
          {
            userId: payload.userId,
            actorId: currentUser.id,
            type: "game_invite",
            game: lobby.game,
            lobbyId: id,
          },
        ]);
      }),
    rematchGameLobby: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const snapshot = yield* loadSnapshot(db, id);
        const { lobby, drawing } = snapshot;
        yield* requireHost(lobby, currentUser.id, "start a rematch");
        if (snapshot.phase !== "finished") {
          return yield* invalid("The current game hasn't finished yet");
        }
        // A rematch wipes the game it replaces, so its results must be
        // on record first — normally a read already did this.
        yield* settleIfOver({ db, connections }, snapshot);
        // The typing race keeps `passage` (hidden while waiting — see
        // toApiLobby) so the next start can avoid repeating it; Sketchy
        // carries its prompts over in its settings for the same reason.
        const reset = yield* dbQuery(() =>
          db
            .update(gameLobbies)
            .set({
              status: "waiting",
              round: lobby.round + 1,
              startsAt: null,
              endsAt: null,
              updatedAt: new Date(),
              ...(drawing && {
                settings: {
                  packs: drawing.settings.packs,
                  rounds: drawing.settings.rounds,
                  // Accumulates over rematches so a long session keeps
                  // cycling through the pool instead of ping-ponging.
                  recentPrompts: [
                    ...(drawing.settings.recentPrompts ?? []),
                    ...drawing.rows.drawings.map((row) => row.prompt),
                  ].slice(-RECENT_DEALT_CAP),
                },
              }),
            })
            .where(
              and(eq(gameLobbies.id, id), eq(gameLobbies.round, lobby.round)),
            )
            .returning({ id: gameLobbies.id }),
        );
        if (reset.length > 0) {
          yield* dbQuery(() =>
            db
              .update(gameLobbyPlayers)
              .set({
                durationMs: null,
                score: null,
                accuracy: null,
                place: null,
                detail: null,
              })
              .where(eq(gameLobbyPlayers.lobbyId, id)),
          );
          // Bluffs and votes go with their drawings (cascade).
          yield* dbQuery(() =>
            db.delete(gameDrawings).where(eq(gameDrawings.lobbyId, id)),
          );
          yield* notifyLobbyChanged(connections, lobby);
        }
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
  }) satisfies GamesHandlers;
