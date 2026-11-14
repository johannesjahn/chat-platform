import { and, asc, eq, gte, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  LEADERBOARD_SIZE,
  type LeaderboardEntry,
  type LeaderboardPeriod,
} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { gameResults, users } from "../db/schema.ts";

import { type GamesDeps, type GamesHandlers } from "./handlerKit.ts";
import { publicUserColumns, toPublicUser } from "../users/userViews.ts";

const DAY_MS = 24 * 60 * 60_000;

const PERIOD_MS: Record<LeaderboardPeriod, number | null> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  all: null,
};

const round1 = (value: number) => Math.round(value * 10) / 10;

const leaderboardEntry = (row: {
  rank: number;
  bestScore: number;
  averageScore: number;
  averageAccuracy: number;
  races: number;
  wins: number;
  user: Parameters<typeof toPublicUser>[0];
}): LeaderboardEntry => ({
  rank: row.rank,
  user: toPublicUser(row.user),
  bestScore: round1(row.bestScore),
  averageScore: round1(row.averageScore),
  averageAccuracy: round1(row.averageAccuracy),
  races: row.races,
  wins: row.wins,
});

export const leaderboardHandlers = ({ db }: GamesDeps) =>
  ({
    getLeaderboard: ({ params: { game }, query: urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const period = urlParams.period ?? "all";
        const windowMs = PERIOD_MS[period];

        // Per-player aggregates, ranked by best score, in one pass. `rank()`
        // (not `row_number()`) so equal bests share a rank.
        const stats = db.$with("stats").as(
          db
            .select({
              userId: gameResults.userId,
              bestScore: sql<number>`max(${gameResults.score})`.as(
                "best_score",
              ),
              averageScore: sql<number>`avg(${gameResults.score})`.as(
                "average_score",
              ),
              averageAccuracy: sql<number>`avg(${gameResults.accuracy})`.as(
                "average_accuracy",
              ),
              races: sql<number>`cast(count(*) as int)`.as("races"),
              wins: sql<number>`cast(count(*) filter (where ${gameResults.place} = 1 and ${gameResults.playerCount} > 1) as int)`.as(
                "wins",
              ),
              rank: sql<number>`cast(rank() over (order by max(${gameResults.score}) desc) as int)`.as(
                "rank",
              ),
            })
            .from(gameResults)
            .where(
              windowMs === null
                ? eq(gameResults.game, game)
                : and(
                    eq(gameResults.game, game),
                    gte(gameResults.createdAt, new Date(Date.now() - windowMs)),
                  ),
            )
            .groupBy(gameResults.userId),
        );
        const rows = yield* Effect.tryPromise(() =>
          db
            .with(stats)
            .select({
              rank: stats.rank,
              bestScore: stats.bestScore,
              averageScore: stats.averageScore,
              averageAccuracy: stats.averageAccuracy,
              races: stats.races,
              wins: stats.wins,
              user: publicUserColumns,
            })
            .from(stats)
            .innerJoin(users, eq(users.id, stats.userId))
            .where(
              or(
                sql`${stats.rank} <= ${LEADERBOARD_SIZE}`,
                eq(stats.userId, currentUser.id),
              ),
            )
            .orderBy(asc(stats.rank), asc(stats.userId)),
        ).pipe(Effect.orDie);

        const entries = rows.map(leaderboardEntry);
        return {
          game,
          period,
          // Ties at the cutoff can rank more than LEADERBOARD_SIZE players
          // inside it; the slice keeps the table a fixed size.
          entries: entries
            .filter((entry) => entry.rank <= LEADERBOARD_SIZE)
            .slice(0, LEADERBOARD_SIZE),
          me: entries.find((entry) => entry.user.id === currentUser.id) ?? null,
        };
      }),
  }) satisfies GamesHandlers;
