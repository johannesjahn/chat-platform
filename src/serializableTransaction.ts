import { Duration, Effect, Schedule } from "effect";
import type { DrizzleDb } from "./Db.ts";

// A few handlers (createDirectChat, addParticipants, joinViaInvite) run a
// check-then-write in a `serializable` transaction so concurrent requests
// can't both pass the check. Postgres enforces that by aborting one side with
// a serialization failure (SQLSTATE 40001), and its docs are explicit that
// callers must be ready to retry such a transaction. Without a retry every
// abort reached the client as a 500 — and not only for genuine races:
// serializable isolation tracks reads by index page, not by row, so it also
// aborts transactions touching *unrelated* rows. A load test creating direct
// chats for 20 different pairs at once lost 14 of them that way.
//
// A retry reruns the whole transaction from a fresh snapshot, so its checks
// see whatever the winner committed — e.g. a losing createDirectChat for the
// same pair now finds and returns the chat the other request created.

export type Transaction = Parameters<
  Parameters<DrizzleDb["transaction"]>[0]
>[0];

// 40001 is the serialization failure itself; 40P01 (deadlock detected) is
// the same kind of "you lost a race, try again" abort, reached when two
// transactions take row locks in opposite orders (e.g. both bumping an
// invite's useCount while inserting participants).
const RETRYABLE_SQLSTATES: ReadonlySet<unknown> = new Set(["40001", "40P01"]);

// Small, jittered backoff: conflicts are between requests landing within
// milliseconds of each other, and jitter keeps the retries from colliding
// again in lockstep. Each round of a pile-up commits at least one contender,
// so a burst of N racing requests can need about N retries — the budget is
// sized for a burst of ~a dozen (a group's members all redeeming an invite at
// once), and the delay is capped so the worst case still answers in well
// under a second. Bounded, so a pathological hot spot still fails (as a 500)
// instead of looping. src/chats.postgres.integration.test.ts measures this
// against a real Postgres: at half this budget its bursts already 500.
export const SERIALIZABLE_MAX_RETRIES = 10;
const RETRY_SCHEDULE = Schedule.exponential("5 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.millis(100))),
  ),
  Schedule.jittered,
);

// Drivers disagree on where the SQLSTATE goes — Bun.sql's PostgresError puts
// it in `errno` (its `code` is a generic "ERR_POSTGRES_SERVER_ERROR"), PGlite
// in `code` — and drizzle wraps it in its own "Failed query" error, which
// Effect.tryPromise wraps again. So walk the `cause` chain and accept either.
export const isRetryableAbort = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const { code, errno, cause } = current as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (RETRYABLE_SQLSTATES.has(code) || RETRYABLE_SQLSTATES.has(errno))
      return true;
    current = cause;
  }
  return false;
};

// Runs `run` in a serializable transaction, retrying on serialization
// failures and deadlocks. Any other error — and a serialization failure that outlasts the
// retries — dies, same as an unexpected DB error anywhere else. `run` may be
// called more than once, so it must not have side effects outside `tx`.
export const serializableTransaction = <A>(
  db: DrizzleDb,
  run: (tx: Transaction) => Promise<A>,
): Effect.Effect<A> =>
  Effect.tryPromise(() =>
    db.transaction(run, { isolationLevel: "serializable" }),
  ).pipe(
    Effect.retry({
      while: isRetryableAbort,
      schedule: RETRY_SCHEDULE,
      times: SERIALIZABLE_MAX_RETRIES,
    }),
    Effect.orDie,
  );
