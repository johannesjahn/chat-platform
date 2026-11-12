// Keeps this client's own writes from being fetched twice (issue #753).
//
// Creating a post or a comment publishes a realtime event (`post_changed` /
// `comment_changed`) to everyone who'd see it — this client included. The
// creating client already has the new row from its mutation response and
// writes it into the cache itself, so applying the echo too only refetches
// what's already there. But the event carries no actor, and it can arrive on
// either side of the response: the server publishes before it answers.
//
// So while a create is in flight, events in its scope are *held*; once it
// settles, the one naming the id it created is dropped and the rest are
// applied. An echo that only arrives after the response is recognised from
// the remembered id. Another tab or device of the same user has no write in
// flight, so it applies the event like anyone else's. A create that fails
// remembers nothing, so a held event is applied — if the row was stored and
// only the response was lost, the echo is what brings it in.
//
// Pure (no browser/React imports) and clock-injectable, so it's unit-tested
// on its own (see ownWrites.test.ts).

export type OwnWriteScope = string;

// Post ids and comment ids are separate sequences, so each scope keeps its
// own set. A comment's echo is scoped to its post (a reply's echo carries the
// post id too), which is all `comment_changed` lets this side key on.
export const OWN_POST_SCOPE: OwnWriteScope = "post";
export const ownCommentScope = (postId: number): OwnWriteScope =>
  `comments:${postId}`;

// How long a created id is remembered for an echo that's still on its way,
// and the longest an event is held for a create that never settles.
export const OWN_WRITE_REMEMBER_MS = 30_000;
export const OWN_WRITE_MAX_HOLD_MS = 10_000;

type Options = {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  rememberMs?: number;
  maxHoldMs?: number;
};

export type OwnWriteTracker = {
  // Marks a create in `scope` as in flight. Call the returned function once
  // it settles, with the id it created (or null if it failed); calling it
  // again is a no-op, and it's called for you after `maxHoldMs`.
  begin(scope: OwnWriteScope): (createdId: number | null) => void;
  // Routes an incoming event for row `id`: drops it if it's an echo of this
  // client's own create, holds it while a create in its scope is in flight,
  // and otherwise runs `apply` straight away.
  intercept(scope: OwnWriteScope, id: number, apply: () => void): void;
};

const defaultSetTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export function createOwnWriteTracker(options: Options = {}): OwnWriteTracker {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const rememberMs = options.rememberMs ?? OWN_WRITE_REMEMBER_MS;
  const maxHoldMs = options.maxHoldMs ?? OWN_WRITE_MAX_HOLD_MS;

  const pending = new Map<OwnWriteScope, number>();
  const held = new Map<
    OwnWriteScope,
    Array<{ id: number; apply: () => void }>
  >();
  // scope -> id -> expiry
  const recent = new Map<OwnWriteScope, Map<number, number>>();

  // True (and forgets it) if `id` is a remembered own create in `scope`.
  function consumeRecent(scope: OwnWriteScope, id: number): boolean {
    const ids = recent.get(scope);
    if (!ids) return false;
    const t = now();
    for (const [rememberedId, expiresAt] of ids) {
      if (expiresAt <= t) ids.delete(rememberedId);
    }
    const hit = ids.delete(id);
    if (ids.size === 0) recent.delete(scope);
    return hit;
  }

  function flush(scope: OwnWriteScope): void {
    const events = held.get(scope);
    held.delete(scope);
    for (const event of events ?? []) {
      if (!consumeRecent(scope, event.id)) event.apply();
    }
  }

  return {
    begin(scope) {
      pending.set(scope, (pending.get(scope) ?? 0) + 1);
      let settled = false;
      const settle = (createdId: number | null) => {
        if (settled) return;
        settled = true;
        cancelTimer();
        if (createdId !== null) {
          let ids = recent.get(scope);
          if (!ids) recent.set(scope, (ids = new Map()));
          ids.set(createdId, now() + rememberMs);
        }
        const left = (pending.get(scope) ?? 1) - 1;
        if (left > 0) {
          pending.set(scope, left);
          return;
        }
        pending.delete(scope);
        flush(scope);
      };
      const cancelTimer = setTimer(() => settle(null), maxHoldMs);
      return settle;
    },
    intercept(scope, id, apply) {
      if (consumeRecent(scope, id)) return;
      if ((pending.get(scope) ?? 0) > 0) {
        let events = held.get(scope);
        if (!events) held.set(scope, (events = []));
        events.push({ id, apply });
        return;
      }
      apply();
    },
  };
}

// The one tracker the app shares: the create paths (lib/createPost.ts,
// CommentsSection.tsx) begin writes on it, `useRealtimeSocket` routes the
// post/comment events through it.
export const ownWrites = createOwnWriteTracker();
