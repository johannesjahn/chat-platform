import { HttpApiBuilder } from "@effect/platform";
import { count, eq, gte, sql } from "drizzle-orm";
import { union, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import { Effect, Metric, MetricState } from "effect";
import packageJson from "../package.json" with { type: "json" };
import {
  ChatApi,
  DEFAULT_ADMIN_TIMELINE_DAYS,
  Forbidden,
  type AdminActivityWindow,
  type AdminActivityWindowLabel,
  type AdminDependencyHealth,
  type AdminRuntimeHealth,
  type AdminTimelinePoint,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { PubSub } from "./PubSub.ts";
import {
  attachments,
  chats,
  comments,
  likes,
  messages,
  posts,
  users,
} from "./db/schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// `key` indexes the per-table `WindowedCounts` below; `days` sizes the
// trailing window the active-user count is computed over.
const WINDOWS: ReadonlyArray<{
  readonly label: AdminActivityWindowLabel;
  readonly days: number;
  readonly key: "d1" | "d7" | "d30";
}> = [
  { label: "1d", days: 1, key: "d1" },
  { label: "7d", days: 7, key: "d7" },
  { label: "30d", days: 30, key: "d30" },
];

// `cast(... as int)` on every aggregate below for the same reason drizzle's
// own `count()` helper does it: Postgres `count()` is a bigint, which both
// drivers (PGlite and Bun.sql, see Db.ts) hand back as a *string* rather
// than a number. Casting in SQL keeps every field of the response a real
// number without a parse step per row.
const INT = (fragment: ReturnType<typeof sql>) =>
  sql<number>`cast(${fragment} as int)`;

// `count(*) filter (where ...)` rather than one query per window: all three
// trailing windows over a table are the same scan, so folding them into a
// single query turns 3 round trips per table into 1.
const countSince = (createdAt: PgColumn, since: Date) =>
  INT(sql`count(*) filter (where ${gte(createdAt, since)})`);

type WindowedCounts = {
  readonly total: number;
  readonly d1: number;
  readonly d7: number;
  readonly d30: number;
};

const ZERO_COUNTS: WindowedCounts = { total: 0, d1: 0, d7: 0, d30: 0 };

// Lifetime total plus one count per trailing window, for a single table.
const windowedCounts = (
  db: DrizzleDb,
  table: PgTable,
  createdAt: PgColumn,
  since: Readonly<Record<"d1" | "d7" | "d30", Date>>,
): Effect.Effect<WindowedCounts> =>
  Effect.tryPromise(() =>
    db
      .select({
        total: count(),
        d1: countSince(createdAt, since.d1),
        d7: countSince(createdAt, since.d7),
        d30: countSince(createdAt, since.d30),
      })
      .from(table),
  ).pipe(
    Effect.map((rows) => rows[0] ?? ZERO_COUNTS),
    Effect.orDie,
  );

const totalCount = (db: DrizzleDb, table: PgTable): Effect.Effect<number> =>
  Effect.tryPromise(() => db.select({ total: count() }).from(table)).pipe(
    Effect.map((rows) => rows[0]?.total ?? 0),
    Effect.orDie,
  );

// Bytes currently held in the object store for attachments still referenced
// by a row (orphans are swept separately — see AttachmentCleanup.ts).
// `coalesce` because `sum()` over zero rows is null, not 0.
const attachmentBytes = (db: DrizzleDb): Effect.Effect<number> =>
  Effect.tryPromise(() =>
    db
      .select({ bytes: INT(sql`coalesce(sum(${attachments.size}), 0)`) })
      .from(attachments),
  ).pipe(
    Effect.map((rows) => rows[0]?.bytes ?? 0),
    Effect.orDie,
  );

// Distinct users who created *any* content in the window — the same
// definition `active_users{window}` uses (see ActiveUsersMetrics.ts), but
// computed fresh per request rather than read off that gauge, which only
// refreshes hourly and would make the dashboard's DAU lag by up to an hour.
//
// A `UNION` (not `UNION ALL`) of the four id sets wrapped in a count, so
// Postgres does the dedup and returns one integer — the id set itself never
// crosses into the app, which is also what keeps this an aggregate and not
// a per-user breakdown (see the Api.ts section comment).
const countActiveUsersSince = (
  db: DrizzleDb,
  since: Date,
): Effect.Effect<number> => {
  const activeIds = union(
    db
      .select({ userId: posts.authorId })
      .from(posts)
      .where(gte(posts.createdAt, since)),
    db
      .select({ userId: comments.authorId })
      .from(comments)
      .where(gte(comments.createdAt, since)),
    db
      .select({ userId: likes.userId })
      .from(likes)
      .where(gte(likes.createdAt, since)),
    db
      .select({ userId: messages.senderId })
      .from(messages)
      .where(gte(messages.createdAt, since)),
  ).as("active_user_ids");

  return Effect.tryPromise(() =>
    db.select({ total: count() }).from(activeIds),
  ).pipe(
    Effect.map((rows) => rows[0]?.total ?? 0),
    Effect.orDie,
  );
};

// `YYYY-MM-DD` in UTC. `created_at` is a naive `timestamp` column holding
// UTC instants (drizzle encodes Dates with `toISOString()` — see
// db/schema.ts), so a plain `date_trunc` already truncates on UTC days and
// needs no `at time zone` conversion.
const utcDay = (createdAt: PgColumn) =>
  sql<string>`to_char(date_trunc('day', ${createdAt}), 'YYYY-MM-DD')`;

// Rows per UTC day for one table, as a `YYYY-MM-DD` -> count map. Only days
// that actually have rows come back; `buildTimeline` zero-fills the rest.
const dailyCounts = (
  db: DrizzleDb,
  table: PgTable,
  createdAt: PgColumn,
  since: Date,
): Effect.Effect<ReadonlyMap<string, number>> => {
  const day = utcDay(createdAt);
  return Effect.tryPromise(() =>
    db
      .select({ day, total: INT(sql`count(*)`) })
      .from(table)
      .where(gte(createdAt, since))
      .groupBy(day),
  ).pipe(
    Effect.map((rows) => new Map(rows.map((row) => [row.day, row.total]))),
    Effect.orDie,
  );
};

const startOfUtcDay = (epochMs: number): Date => {
  const date = new Date(epochMs);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
};

const utcDayKey = (date: Date): string => date.toISOString().slice(0, 10);

// One entry per day for the whole requested range, oldest first — including
// days nothing happened on, so the chart renders a continuous axis rather
// than silently compressing quiet days away.
const buildTimeline = (
  firstDay: Date,
  days: number,
  counts: Readonly<{
    signups: ReadonlyMap<string, number>;
    posts: ReadonlyMap<string, number>;
    comments: ReadonlyMap<string, number>;
    messages: ReadonlyMap<string, number>;
  }>,
): ReadonlyArray<AdminTimelinePoint> =>
  Array.from({ length: days }, (_, offset) => {
    const date = utcDayKey(new Date(firstDay.getTime() + offset * DAY_MS));
    return {
      date,
      signups: counts.signups.get(date) ?? 0,
      posts: counts.posts.get(date) ?? 0,
      comments: counts.comments.get(date) ?? 0,
      messages: counts.messages.get(date) ?? 0,
    };
  });

// Round-trips a dependency and times it, folding a failure into
// `reachable: false` rather than failing the whole request — a dashboard
// whose whole job is reporting that Redis is down shouldn't 500 because
// Redis is down.
const probe = (
  name: AdminDependencyHealth["name"],
  backend: string,
  check: Effect.Effect<unknown, unknown>,
): Effect.Effect<AdminDependencyHealth> =>
  Effect.gen(function* () {
    const start = performance.now();
    const result = yield* Effect.either(check);
    return {
      name,
      backend,
      reachable: result._tag === "Right",
      // Tenths of a millisecond: an embedded PGlite `select 1` routinely
      // lands under 1ms, and a flat `0` reads as "not measured".
      latencyMs:
        result._tag === "Right"
          ? Math.round((performance.now() - start) * 10) / 10
          : null,
    };
  });

type RuntimeCounters = Omit<
  AdminRuntimeHealth,
  "status" | "version" | "uptimeSeconds" | "dependencies" | "errorRate"
>;

// Reads the live `effect/Metric` registry — the exact same snapshot
// `/metrics` renders (see Metrics.ts) — instead of a second set of
// counters. Everything here is therefore *this process's* total since
// start: with more than one replica the dashboard reflects whichever
// instance served the request, which is why Prometheus remains the
// deployment-wide view.
const runtimeCounters: Effect.Effect<RuntimeCounters> = Effect.map(
  Metric.snapshot,
  (pairs) => {
    let requestsTotal = 0;
    let serverErrorsTotal = 0;
    let rateLimitRejectionsTotal = 0;
    let dbQueryErrorsTotal = 0;
    let websocketConnections = 0;

    for (const pair of pairs) {
      const { name, tags } = pair.metricKey;
      const state = pair.metricState;

      if (MetricState.isCounterState(state)) {
        const value = Number(state.count);
        if (name === "http_requests_total") {
          requestsTotal += value;
          const status = tags.find((tag) => tag.key === "status")?.value;
          if (status !== undefined && Number(status) >= 500)
            serverErrorsTotal += value;
        } else if (name === "rate_limit_rejections_total") {
          rateLimitRejectionsTotal += value;
        } else if (name === "db_query_errors_total") {
          dbQueryErrorsTotal += value;
        }
      } else if (
        MetricState.isGaugeState(state) &&
        name === "websocket_connections_active"
      ) {
        websocketConnections = Number(state.value);
      }
    }

    return {
      requestsTotal,
      serverErrorsTotal,
      rateLimitRejectionsTotal,
      dbQueryErrorsTotal,
      websocketConnections,
    };
  },
);

export const AdminHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "admin",
  (handlers) =>
    handlers.handle("getAdminStats", ({ urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        if (currentUser.role !== "admin")
          return yield* Effect.fail(
            new Forbidden({
              message: "Only admins can view platform statistics",
            }),
          );

        const db = yield* Db;
        const pubsub = yield* PubSub;

        const now = Date.now();
        const since = {
          d1: new Date(now - DAY_MS),
          d7: new Date(now - 7 * DAY_MS),
          d30: new Date(now - 30 * DAY_MS),
        } as const;

        const days = urlParams.days ?? DEFAULT_ADMIN_TIMELINE_DAYS;
        // The range ends with *today*, so it starts `days - 1` whole days
        // before the current UTC day — `days: 1` means today alone.
        const firstDay = new Date(
          startOfUtcDay(now).getTime() - (days - 1) * DAY_MS,
        );

        // Everything below is independent, so it all goes out at once
        // rather than serially — the endpoint is as slow as its slowest
        // query, not their sum.
        const [
          userCounts,
          postCounts,
          commentCounts,
          messageCounts,
          reactionCounts,
          chatTotal,
          attachmentTotal,
          bytes,
          activeUserCounts,
          timelineCounts,
          dependencies,
          counters,
          adminTotal,
        ] = yield* Effect.all(
          [
            windowedCounts(db, users, users.createdAt, since),
            windowedCounts(db, posts, posts.createdAt, since),
            windowedCounts(db, comments, comments.createdAt, since),
            windowedCounts(db, messages, messages.createdAt, since),
            windowedCounts(db, likes, likes.createdAt, since),
            totalCount(db, chats),
            totalCount(db, attachments),
            attachmentBytes(db),
            Effect.all(
              WINDOWS.map((window) =>
                countActiveUsersSince(db, new Date(now - window.days * DAY_MS)),
              ),
              { concurrency: "unbounded" },
            ),
            Effect.all(
              {
                signups: dailyCounts(db, users, users.createdAt, firstDay),
                posts: dailyCounts(db, posts, posts.createdAt, firstDay),
                comments: dailyCounts(
                  db,
                  comments,
                  comments.createdAt,
                  firstDay,
                ),
                messages: dailyCounts(
                  db,
                  messages,
                  messages.createdAt,
                  firstDay,
                ),
              },
              { concurrency: "unbounded" },
            ),
            Effect.all(
              [
                probe(
                  "database",
                  process.env.DATABASE_URL ? "postgres" : "pglite",
                  Effect.tryPromise(() => db.execute("select 1")),
                ),
                probe(
                  "pubsub",
                  process.env.REDIS_URL ? "redis" : "memory",
                  pubsub.ping,
                ),
              ],
              { concurrency: "unbounded" },
            ),
            runtimeCounters,
            Effect.tryPromise(() =>
              db
                .select({ total: count() })
                .from(users)
                .where(eq(users.role, "admin")),
            ).pipe(
              Effect.map((rows) => rows[0]?.total ?? 0),
              Effect.orDie,
            ),
          ],
          { concurrency: "unbounded" },
        );

        const activity: ReadonlyArray<AdminActivityWindow> = WINDOWS.map(
          (window, index) => ({
            window: window.label,
            activeUsers: activeUserCounts[index] ?? 0,
            newUsers: userCounts[window.key],
            newPosts: postCounts[window.key],
            newComments: commentCounts[window.key],
            newMessages: messageCounts[window.key],
            newReactions: reactionCounts[window.key],
          }),
        );

        return {
          generatedAt: now,
          totals: {
            users: userCounts.total,
            admins: adminTotal,
            posts: postCounts.total,
            comments: commentCounts.total,
            chats: chatTotal,
            messages: messageCounts.total,
            reactions: reactionCounts.total,
            attachments: attachmentTotal,
            attachmentBytes: bytes,
          },
          activity,
          timeline: buildTimeline(firstDay, days, timelineCounts),
          health: {
            status: dependencies.every((dependency) => dependency.reachable)
              ? ("ok" as const)
              : ("degraded" as const),
            version: packageJson.version,
            uptimeSeconds: Math.round(process.uptime()),
            dependencies,
            ...counters,
            errorRate:
              counters.requestsTotal === 0
                ? 0
                : counters.serverErrorsTotal / counters.requestsTotal,
          },
        };
      }),
    ),
);
