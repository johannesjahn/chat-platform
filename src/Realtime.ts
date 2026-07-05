import { Context, Effect, Layer } from "effect";
import { PubSub } from "./PubSub.ts";

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

// The channel every RealtimeConnectionsLive instance publishes to and
// subscribes on — one process-wide topic is enough since each message
// already carries its own targeting (see Envelope).
const CHANNEL = "chat-platform:realtime";

type Envelope =
  | {
      readonly scope: "users";
      readonly userIds: ReadonlyArray<number>;
      readonly event: RealtimeEvent;
    }
  | { readonly scope: "all"; readonly event: RealtimeEvent };

// Registration (`byUser`) stays local to this process — a `/ws` connection
// only ever lives on the instance that accepted it — but delivery goes
// through PubSub (see PubSub.ts) so that a mutation handled by *any*
// instance reaches participants connected to *any other* instance too, not
// just the one that happened to process the mutation.
export const RealtimeConnectionsLive = Layer.effect(
  RealtimeConnections,
  Effect.gen(function* () {
    const pubsub = yield* PubSub;
    const byUser = new Map<number, Set<Writer>>();

    const writeAll = (writers: Iterable<Writer>, payload: string) =>
      Effect.gen(function* () {
        for (const write of writers) {
          yield* write(payload).pipe(Effect.ignore);
        }
      });

    const deliverLocally = (message: string) =>
      Effect.gen(function* () {
        const envelope = JSON.parse(message) as Envelope;
        const payload = JSON.stringify(envelope.event);

        if (envelope.scope === "all") {
          for (const writers of byUser.values()) {
            yield* writeAll(writers, payload);
          }
          return;
        }

        const seen = new Set<number>();
        for (const userId of envelope.userIds) {
          if (seen.has(userId)) continue;
          seen.add(userId);
          const writers = byUser.get(userId);
          if (!writers) continue;
          yield* writeAll(writers, payload);
        }
      });

    yield* pubsub.subscribe(CHANNEL, deliverLocally);

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

    // Best-effort, like the local delivery it replaces: a mutation
    // succeeding shouldn't fail just because the realtime push couldn't be
    // published (e.g. Redis briefly unreachable).
    const notifyUsers: Context.Tag.Service<
      typeof RealtimeConnections
    >["notifyUsers"] = (userIds, event) =>
      pubsub
        .publish(
          CHANNEL,
          JSON.stringify({
            scope: "users",
            userIds: [...userIds],
            event,
          } satisfies Envelope),
        )
        .pipe(Effect.ignore);

    const broadcastAll: Context.Tag.Service<
      typeof RealtimeConnections
    >["broadcastAll"] = (event) =>
      pubsub
        .publish(
          CHANNEL,
          JSON.stringify({ scope: "all", event } satisfies Envelope),
        )
        .pipe(Effect.ignore);

    return { register, notifyUsers, broadcastAll };
  }),
);
