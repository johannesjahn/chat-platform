import { Context, Effect, Layer, Metric } from "effect";
import { websocketConnectionsActive } from "./Metrics.ts";
import { PresenceStore } from "./Presence.ts";
import { PubSub } from "./PubSub.ts";

// Pushed to every participant of a chat whenever something in it changes
// (new message, read receipt, rename, participants added/removed). `version`
// mirrors the chat's `version` column (see db/schema.ts) as of this
// mutation, letting a client that's tracking the last version it observed
// for a chat detect deterministically whether it missed an event in between
// (issue #55) — e.g. a gap wider than one, or a redelivery of a version it's
// already applied — rather than only being able to refetch blindly.
export type ChatEvent = {
  readonly type: "chat_updated";
  readonly chatId: number;
  readonly version: number;
};

// Pushed to every user who had access to a chat the moment it's deleted
// (see `deleteChat`/`leaveChat` in ChatsHandler.ts) — a dedicated event
// rather than a `chat_updated` with a bumped version because there's no
// surviving row to bump: the chat, its participants, and its messages are
// already gone by the time this is published. Clients drop it from any
// cached list/detail view unconditionally, without going through the
// version staleness check `chat_updated` uses (issue #66).
export type ChatDeletedEvent = {
  readonly type: "chat_deleted";
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
export type RealtimeEvent =
  ChatEvent | ChatDeletedEvent | PostEvent | PresenceEvent | TypingEvent;

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
    // Ids of every user with a live `/ws` connection *anywhere* right now
    // (see PresenceStore, which is what actually answers this — correctly
    // cross-instance when Redis-backed). Used to hand a freshly-connecting
    // client its initial presence snapshot (see RealtimeSocket.ts) — after
    // that, live transitions arrive as `PresenceEvent`s pushed through the
    // usual broadcast path.
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
// only ever lives on the instance that accepted it, and `byUser` exists only
// to know which local writers to call when a message needs delivering here —
// but delivery goes through PubSub (see PubSub.ts) so that a mutation
// handled by *any* instance reaches participants connected to *any other*
// instance too, not just the one that happened to process the mutation.
// Whether a *user* (as opposed to one specific connection) is online is a
// separate question, answered by PresenceStore (see Presence.ts) rather than
// by the size of this instance's own local `byUser` entry.
export const RealtimeConnectionsLive = Layer.effect(
  RealtimeConnections,
  Effect.gen(function* () {
    const pubsub = yield* PubSub;
    const presenceStore = yield* PresenceStore;
    const byUser = new Map<number, Set<Writer>>();

    // A dead/broken socket write must never fail the mutation that triggered
    // it (same reasoning as notifyUsers/broadcastAll's Effect.ignore below),
    // but silently dropping it left no trace a connection had gone bad.
    // Logging here at least leaves a trail.
    const logDroppedWrite = (userId: number, error: unknown) =>
      Effect.logWarning(
        "RealtimeConnections: dropped delivery, connection write failed",
      ).pipe(Effect.annotateLogs({ userId, error: String(error) }));

    const writeAll = (
      writers: Iterable<Writer>,
      payload: string,
      userId: number,
    ) =>
      Effect.gen(function* () {
        for (const write of writers) {
          yield* write(payload).pipe(
            Effect.catchAll((error) => logDroppedWrite(userId, error)),
          );
        }
      });

    const deliverLocally = (message: string) =>
      Effect.gen(function* () {
        const envelope = JSON.parse(message) as Envelope;
        const payload = JSON.stringify(envelope.event);

        if (envelope.scope === "all") {
          for (const [userId, writers] of byUser) {
            yield* writeAll(writers, payload, userId);
          }
          return;
        }

        const seen = new Set<number>();
        for (const userId of envelope.userIds) {
          if (seen.has(userId)) continue;
          seen.add(userId);
          const writers = byUser.get(userId);
          if (!writers) continue;
          yield* writeAll(writers, payload, userId);
        }
      });

    yield* pubsub.subscribe(CHANNEL, deliverLocally);

    // Best-effort, like the local delivery it replaces: a mutation
    // succeeding shouldn't fail just because the realtime push couldn't be
    // published (e.g. Redis briefly unreachable). Logged rather than plain
    // `Effect.ignore`d so a publish failure — which drops the event for
    // every instance, not just this one — leaves a trail.
    const logPublishFailure = (envelope: Envelope, error: unknown) =>
      Effect.logWarning(
        "RealtimeConnections: failed to publish realtime event, delivery dropped",
      ).pipe(Effect.annotateLogs({ envelope, error: String(error) }));

    const notifyUsers: Context.Tag.Service<
      typeof RealtimeConnections
    >["notifyUsers"] = (userIds, event) => {
      const envelope = {
        scope: "users",
        userIds: [...userIds],
        event,
      } satisfies Envelope;
      return pubsub
        .publish(CHANNEL, JSON.stringify(envelope))
        .pipe(Effect.catchAll((error) => logPublishFailure(envelope, error)));
    };

    const broadcastAll: Context.Tag.Service<
      typeof RealtimeConnections
    >["broadcastAll"] = (event) => {
      const envelope = { scope: "all", event } satisfies Envelope;
      return pubsub
        .publish(CHANNEL, JSON.stringify(envelope))
        .pipe(Effect.catchAll((error) => logPublishFailure(envelope, error)));
    };

    const register: Context.Tag.Service<
      typeof RealtimeConnections
    >["register"] = (userId, write) =>
      Effect.gen(function* () {
        const set = byUser.get(userId) ?? new Set();
        set.add(write);
        byUser.set(userId, set);
        // One live `/ws` socket on this instance, for VictoriaMetrics'
        // `websocket_connections_active` gauge (see Metrics.ts) — a count of
        // *connections*, not of online *users* (PresenceStore, below, is the
        // latter): a user with two tabs open holds two of these.
        yield* Metric.increment(websocketConnectionsActive);
        // PresenceStore.connect reports whether this was the *global*
        // transition to online (across every instance), not just whether
        // this instance's own local set was empty a moment ago — a second
        // tab landing on a different instance must not re-announce a user
        // who's already online via the first.
        const cameOnline = yield* presenceStore.connect(userId);
        if (cameOnline) {
          yield* broadcastAll({ type: "presence", userId, online: true });
        }
        return () => {
          const current = byUser.get(userId);
          if (current) {
            current.delete(write);
            if (current.size === 0) byUser.delete(userId);
          }
          Effect.runFork(Metric.incrementBy(websocketConnectionsActive, -1));
          // Called from a plain sync cleanup callback
          // (`Effect.ensuring(Effect.sync(unregister))` in
          // RealtimeSocket.ts), which can't itself `yield*` — same
          // `runFork` idiom PubSub.ts's `subscribe` uses to bridge an
          // Effect into a non-Effect callback. Always tells PresenceStore
          // about the disconnect (even if this user had other local
          // connections left on *this* instance) — it's the one that knows
          // whether any connection, anywhere, is still holding them online.
          Effect.runFork(
            presenceStore
              .disconnect(userId)
              .pipe(
                Effect.flatMap((wentOffline) =>
                  wentOffline
                    ? broadcastAll({ type: "presence", userId, online: false })
                    : Effect.void,
                ),
              ),
          );
        };
      });

    const onlineUserIds: Context.Tag.Service<
      typeof RealtimeConnections
    >["onlineUserIds"] = presenceStore.onlineUserIds;

    return { register, notifyUsers, broadcastAll, onlineUserIds };
  }),
);
