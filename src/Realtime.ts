import { Context, Effect, Layer } from "effect";

// Pushed to every participant of a chat whenever something in it changes
// (new message, read receipt, rename, participants added/removed).
export type ChatEvent = {
  readonly type: "chat_updated";
  readonly chatId: number;
};

// Pushed to every connected user whenever a post is created, edited, or
// deleted — the feed has no notion of "participants", so unlike chat events
// this goes out to everyone, not a filtered subset.
export type PostEvent = {
  readonly type: "post_changed";
  readonly postId: number;
};

// Both event payloads deliberately carry no data beyond an id — clients
// refetch the affected queries over the existing REST endpoints rather than
// trusting a duplicated copy of the state pushed over the socket.
export type RealtimeEvent = ChatEvent | PostEvent;

// A connected client's outbound channel — bound to one open `/ws` socket.
type Writer = (chunk: string) => Effect.Effect<void, unknown>;

// Tracks which users currently have a live `/ws` connection, so:
//  - chat mutations can notify only the participants of the affected chat
//    (`notifyUsers`);
//  - post mutations can notify every connected user, since the feed is
//    public to any signed-in user (`broadcastAll`).
export class RealtimeConnections extends Context.Tag("RealtimeConnections")<
  RealtimeConnections,
  {
    readonly register: (
      userId: number,
      write: Writer,
    ) => Effect.Effect<() => void>;
    readonly notifyUsers: (
      userIds: Iterable<number>,
      event: RealtimeEvent,
    ) => Effect.Effect<void>;
    readonly broadcastAll: (event: RealtimeEvent) => Effect.Effect<void>;
  }
>() {}

export const RealtimeConnectionsLive = Layer.sync(RealtimeConnections, () => {
  const byUser = new Map<number, Set<Writer>>();

  const writeAll = (writers: Iterable<Writer>, payload: string) =>
    Effect.gen(function* () {
      for (const write of writers) {
        yield* write(payload).pipe(Effect.ignore);
      }
    });

  const register: Context.Tag.Service<
    typeof RealtimeConnections
  >["register"] = (userId, write) =>
    Effect.sync(() => {
      const set = byUser.get(userId) ?? new Set();
      set.add(write);
      byUser.set(userId, set);
      return () => {
        const current = byUser.get(userId);
        if (!current) return;
        current.delete(write);
        if (current.size === 0) byUser.delete(userId);
      };
    });

  const notifyUsers: Context.Tag.Service<
    typeof RealtimeConnections
  >["notifyUsers"] = (userIds, event) =>
    Effect.gen(function* () {
      const payload = JSON.stringify(event);
      const seen = new Set<number>();
      for (const userId of userIds) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        const writers = byUser.get(userId);
        if (!writers) continue;
        yield* writeAll(writers, payload);
      }
    });

  const broadcastAll: Context.Tag.Service<
    typeof RealtimeConnections
  >["broadcastAll"] = (event) =>
    Effect.gen(function* () {
      const payload = JSON.stringify(event);
      for (const writers of byUser.values()) {
        yield* writeAll(writers, payload);
      }
    });

  return { register, notifyUsers, broadcastAll };
});
