import { gte } from "drizzle-orm";
import { Duration, Effect, Layer, Metric } from "effect";
import { Db, type DrizzleDb, dbQuery } from "./Db.ts";
import { activeUsers } from "./Metrics.ts";
import { comments, likes, messages, posts } from "./db/schema.ts";
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
// just windowed and deduplicated by user instead. Each query below selects
// only distinct user ids from one table, and the four sets are merged in
// memory; no user id is ever labeled onto a metric or persisted anywhere —
// only the resulting count reaches `activeUsers`.
const WINDOWS: ReadonlyArray<{ readonly label: string; readonly ms: number }> =
  [
    { label: "1d", ms: Duration.toMillis(Duration.days(1)) },
    { label: "7d", ms: Duration.toMillis(Duration.days(7)) },
    { label: "30d", ms: Duration.toMillis(Duration.days(30)) },
  ];

const countActiveUsersSince = (
  db: DrizzleDb,
  since: Date,
): Effect.Effect<number> =>
  dbQuery(() =>
    Promise.all([
      db
        .selectDistinct({ userId: posts.authorId })
        .from(posts)
        .where(gte(posts.createdAt, since)),
      db
        .selectDistinct({ userId: comments.authorId })
        .from(comments)
        .where(gte(comments.createdAt, since)),
      db
        .selectDistinct({ userId: likes.userId })
        .from(likes)
        .where(gte(likes.createdAt, since)),
      db
        .selectDistinct({ userId: messages.senderId })
        .from(messages)
        .where(gte(messages.createdAt, since)),
    ]),
  ).pipe(
    Effect.map(([postAuthors, commentAuthors, likers, senders]) => {
      const active = new Set<number>();
      for (const row of postAuthors) active.add(row.userId);
      for (const row of commentAuthors) active.add(row.userId);
      for (const row of likers) active.add(row.userId);
      for (const row of senders) active.add(row.userId);
      return active.size;
    }),
  );

// Recomputes every window's distinct-active-user count. Windows are computed
// independently (not incrementally) — each is a fresh `COUNT(DISTINCT
// user_id)`-equivalent over its own trailing period, so the gauge always
// reflects the current window rather than drifting from some earlier
// baseline. Only counts leave this — never user ids.
export type ActiveUserCounts = Record<string, number>;
export const computeActiveUserCounts: Effect.Effect<
  ActiveUserCounts,
  never,
  Db
> = Effect.gen(function* () {
  const db = yield* Db;
  const now = Date.now();
  const counts: ActiveUserCounts = {};
  for (const window of WINDOWS) {
    const since = new Date(now - window.ms);
    counts[window.label] = yield* countActiveUsersSince(db, since);
  }
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
