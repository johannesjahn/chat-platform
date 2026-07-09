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

// Pushed whenever a user's live-connection count transitions between zero and
// non-zero (see `register` below) — i.e. on their *first* connection (a tab
// opened, a page refreshed) or their *last* disconnection (every tab closed),
// not on every individual socket. Broadcast to everyone rather than scoped to
// a chat's participants: presence is a property of the user, not of any one
// conversation, so this mirrors `broadcastAll`'s reasoning for `PostEvent`.
export type PresenceEvent = {
  readonly type: "presence";
  readonly userId: number;
  readonly online: boolean;
};

// Pushed to a chat's other participants while `userId` is composing a
// message in it (see `POST /chats/:id/typing` in ChatsHandler.ts). Purely
// transient — the server keeps no "is typing" state at all, so there's no
// corresponding "stopped typing" event; a client that stops receiving fresh
// pushes for a given chat/user pair is expected to expire the indicator
// client-side after a short timeout (see web/src/lib/typing.ts).
export type TypingEvent = {
  readonly type: "typing";
  readonly chatId: number;
  readonly userId: number;
  readonly username: string;
};

// Event payloads mostly carry no data beyond an id — clients refetch the
// affected queries over the existing REST endpoints rather than trusting a
// duplicated copy of the state pushed over the socket. Presence/typing are
// the exception: there's no REST resource to refetch for "is this user
// currently online/typing", so those carry the full, self-contained state.
export type RealtimeEvent = ChatEvent | PostEvent | PresenceEvent | TypingEvent;

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
    // Ids of users with a live `/ws` connection registered on *this*
    // instance right now. Used to hand a freshly-connecting client its
    // initial presence snapshot (see RealtimeSocket.ts) — after that, live
    // transitions arrive as `PresenceEvent`s pushed through the usual
    // broadcast path. Note this is local-process state, same as `byUser`
    // below (see its comment): under horizontal scaling (`REDIS_URL` set,
    // multiple instances), a client's initial snapshot only reflects users
    // connected to the same instance it happened to land on, not the full
    // cross-instance picture — a gap `PresenceEvent`s (which do fan out via
    // PubSub) don't close by themselves, since they only fire on that
    // user's *own* connect/disconnect transition, not retroactively.
    readonly onlineUserIds: Effect.Effect<ReadonlyArray<number>>;
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

    const register: Context.Tag.Service<
      typeof RealtimeConnections
    >["register"] = (userId, write) =>
      Effect.gen(function* () {
        const set = byUser.get(userId) ?? new Set();
        const wasOffline = set.size === 0;
        set.add(write);
        byUser.set(userId, set);
        // Only the transition into "has at least one connection" is a
        // presence-worthy event — a second tab opening shouldn't re-announce
        // a user who's already online.
        if (wasOffline) {
          yield* broadcastAll({ type: "presence", userId, online: true });
        }
        return () => {
          const current = byUser.get(userId);
          if (!current) return;
          current.delete(write);
          if (current.size === 0) {
            byUser.delete(userId);
            // Called from a plain sync cleanup callback
            // (`Effect.ensuring(Effect.sync(unregister))` in
            // RealtimeSocket.ts), which can't itself `yield*` — same
            // `runFork` idiom PubSub.ts's `subscribe` uses to bridge an
            // Effect into a non-Effect callback.
            Effect.runFork(
              broadcastAll({ type: "presence", userId, online: false }),
            );
          }
        };
      });

    const onlineUserIds: Context.Tag.Service<
      typeof RealtimeConnections
    >["onlineUserIds"] = Effect.sync(() => [...byUser.keys()]);

    return { register, notifyUsers, broadcastAll, onlineUserIds };
  }),
);
