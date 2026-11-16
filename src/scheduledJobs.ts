import { sql } from "drizzle-orm";
import { Duration, Effect, Random, Schedule } from "effect";
import { Db, dbQuery } from "./Db.ts";
import { scheduledJobs } from "./db/schema.ts";

// Background jobs that must run once per interval across the whole
// deployment, not once per replica (issue #831). Every replica scheduled its
// own copy of the hourly jobs, so N replicas did the work N times — the
// active-users refresh is a full scan of four tables, so each new replica
// added another set of them.
//
// Each replica still ticks (every `CLAIM_TICK`), but a tick only runs the job
// if it *claims* it: one atomic upsert that moves `scheduled_jobs.last_run_at`
// forward only when the last run is older than the job's interval. Exactly
// one concurrent claimant wins; the rest see no row and skip. No session
// lock is held, so this works behind a transaction-mode PgBouncer (#830),
// and a replica that dies mid-run just leaves the next claim to whoever ticks
// after the interval.

// How often each replica checks whether a job is due. A job runs at most
// this late after its interval elapses.
export const CLAIM_TICK = Duration.minutes(5);

// Claims `name` for a run if its last run is at least `every` ago (or it
// never ran). True on exactly one of any number of concurrent callers.
export const claimJobRun = (name: string, every: Duration.Duration) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const seconds = Duration.toSeconds(every);
    const rows = yield* dbQuery(() =>
      db
        .insert(scheduledJobs)
        .values({ name, lastRunAt: sql`now()` })
        .onConflictDoUpdate({
          target: scheduledJobs.name,
          set: { lastRunAt: sql`now()` },
          setWhere: sql`${scheduledJobs.lastRunAt} <= now() - make_interval(secs => ${seconds})`,
        })
        .returning({ name: scheduledJobs.name }),
    );
    return rows.length > 0;
  });

// Stores what a run produced, for replicas that didn't run it.
export const recordJobResult = (name: string, result: unknown) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* dbQuery(() =>
      db
        .update(scheduledJobs)
        .set({ result })
        .where(sql`${scheduledJobs.name} = ${name}`),
    );
  });

// The latest stored result of `name`, or undefined if it never ran.
export const readJobResult = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbQuery(() =>
      db
        .select({ result: scheduledJobs.result })
        .from(scheduledJobs)
        .where(sql`${scheduledJobs.name} = ${name}`),
    );
    return rows[0]?.result ?? undefined;
  });

// One tick: run `job` if this replica claims it, then `afterTick` either
// way (e.g. to pick up the result another replica stored).
export const runIfClaimed = <R>(
  name: string,
  every: Duration.Duration,
  job: Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    if (yield* claimJobRun(name, every)) yield* job;
  });

// Schedules `tick` on this replica for the life of the layer: first after a
// random delay (so a rolling deploy doesn't start every replica's ticks in
// lockstep), then every `CLAIM_TICK`.
export const forkTicker = <R>(tick: Effect.Effect<void, never, R>) =>
  Effect.forkScoped(
    Effect.gen(function* () {
      const jitter = yield* Random.nextIntBetween(0, 60_000);
      yield* Effect.sleep(Duration.millis(jitter));
      yield* tick.pipe(Effect.repeat(Schedule.spaced(CLAIM_TICK)));
    }),
  );
