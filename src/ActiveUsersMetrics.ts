import { gte, sql } from "drizzle-orm";
import { Duration, Effect, Layer, Metric } from "effect";
import { Db, type DrizzleDb, dbQuery } from "./Db.ts";
import { activeUsers } from "./Metrics.ts";
import { users } from "./db/schema.ts";
import {
  claimJobRun,
  forkTicker,
  readJobResult,
  recordJobResult,
} from "./scheduledJobs.ts";

// DAU/WAU/MAU (issue #196) — deliberately a single numeric gauge per window,
// never a per-user breakdown (see the issue's GDPR-driven scoping
// discussion). "Active" here means "created at least one piece of content"
// (a post, comment, like, or message) within the window — the same
// activity signal contentCreatedTotal (Metrics.ts) counts in aggregate,
// just windowed and deduplicated by user instead. Only the resulting count
// ever leaves Postgres; no user id is labeled onto a metric.
const WINDOWS: ReadonlyArray<{ readonly label: string; readonly ms: number }> =
  [
    { label: "1d", ms: Duration.toMillis(Duration.days(1)) },
    { label: "7d", ms: Duration.toMillis(Duration.days(7)) },
    { label: "30d", ms: Duration.toMillis(Duration.days(30)) },
  ];

// How far behind someone's latest content `users.last_active_at` may be
// (see db/schema.ts): its triggers (migration 0041, which hard-codes the
// same interval) only move it once it's this far behind, so a window can
// miss someone whose activity all fell in its first quarter hour. Coarse
// enough that a busy user's sends almost never write to `users`, fine
// against the smallest window.
export const ACTIVITY_RESOLUTION = Duration.minutes(15);

// Distinct users active since each of `sinces`, in one pass over `users`
// (issue #831). This used to take the distinct authors of each content
// table's window — sequential scans that grew with history and took 1.3s
// on 4.2M messages.
export const countActiveUsersSince = (
  db: DrizzleDb,
  sinces: ReadonlyArray<Date>,
): Effect.Effect<number[]> => {
  if (sinces.length === 0) return Effect.succeed([]);
  const earliest = new Date(Math.min(...sinces.map((d) => d.getTime())));
  return dbQuery(() =>
    db
      .select(
        Object.fromEntries(
          sinces.map((since, i) => [
            `w${i}`,
            sql<number>`count(*) filter (where ${users.lastActiveAt} >= ${since})`.mapWith(
              Number,
            ),
          ]),
        ),
      )
      .from(users)
      .where(gte(users.lastActiveAt, earliest)),
  ).pipe(
    Effect.map((rows) => sinces.map((_, i) => Number(rows[0]?.[`w${i}`] ?? 0))),
  );
};

// Recomputes every window's distinct-active-user count. Each is a fresh
// count over its own trailing period, so the gauge always reflects the
// current window rather than drifting from some earlier baseline.
export type ActiveUserCounts = Record<string, number>;
export const computeActiveUserCounts: Effect.Effect<
  ActiveUserCounts,
  never,
  Db
> = Effect.gen(function* () {
  const db = yield* Db;
  const now = Date.now();
  const totals = yield* countActiveUsersSince(
    db,
    WINDOWS.map((window) => new Date(now - window.ms)),
  );
  const counts: ActiveUserCounts = {};
  WINDOWS.forEach((window, i) => {
    counts[window.label] = totals[i] ?? 0;
  });
  return counts;
});

const setActiveUserGauges = (counts: ActiveUserCounts) =>
  Effect.forEach(
    WINDOWS,
    (window) => {
      const count = counts[window.label];
      return typeof count === "number"
        ? Metric.update(
            Metric.withAttributes(activeUsers, { window: window.label }),
            count,
          )
        : Effect.void;
    },
    { discard: true },
  );

// Recomputes every window and sets the `active_users{window}` gauges.
export const updateActiveUserGauges: Effect.Effect<void, never, Db> =
  computeActiveUserCounts.pipe(Effect.flatMap(setActiveUserGauges));

const JOB_NAME = "active-users";

// One tick on one replica. Only the replica that claims the run scans the
// tables (issue #831) and stores the counts; every replica then sets its
// gauge from the stored counts, since Prometheus scrapes each replica and a
// replica that skipped the scan must still report the current number.
export const activeUsersTick: Effect.Effect<void, never, Db> = Effect.gen(
  function* () {
    if (yield* claimJobRun(JOB_NAME, REFRESH_INTERVAL)) {
      const counts = yield* computeActiveUserCounts;
      yield* recordJobResult(JOB_NAME, counts);
      yield* setActiveUserGauges(counts);
      return;
    }
    const stored = yield* readJobResult(JOB_NAME);
    if (stored && typeof stored === "object") {
      yield* setActiveUserGauges(stored as ActiveUserCounts);
    }
  },
);

// Hourly is frequent enough for a dashboard number that only needs to be
// roughly current, and cheap enough not to matter against the query volume
// the app's actual endpoints generate — same reasoning as
// RefreshTokenCleanup.ts's interval.
const REFRESH_INTERVAL = Duration.hours(1);

// Ticks for as long as the layer stays built, as a background fiber tied to
// the layer's scope (interrupted on shutdown) — same pattern as
// RefreshTokenCleanupLive.
export const ActiveUsersMetricsLive = Layer.effectDiscard(
  forkTicker(activeUsersTick),
);
