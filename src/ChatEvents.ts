import { Context, Effect, Layer } from "effect";

// Pushed to every participant of a chat whenever something in it changes
// (new message, read receipt, rename, participants added/removed). The
// payload deliberately carries no data beyond the chat id — clients refetch
// the affected queries over the existing REST endpoints rather than trusting
// a duplicated copy of the state pushed over the socket.
export type ChatEvent = {
  readonly type: "chat_updated";
  readonly chatId: number;
};

// A connected client's outbound channel — bound to one open `/ws` socket.
type Writer = (chunk: string) => Effect.Effect<void, unknown>;

// Tracks which users currently have a live `/ws` connection so chat mutations
// can notify only the participants of the affected chat, instead of every
// connected client.
export class ChatConnections extends Context.Tag("ChatConnections")<
  ChatConnections,
  {
    readonly register: (
      userId: number,
      write: Writer,
    ) => Effect.Effect<() => void>;
    readonly notifyUsers: (
      userIds: Iterable<number>,
      event: ChatEvent,
    ) => Effect.Effect<void>;
  }
>() {}

export const ChatConnectionsLive = Layer.sync(ChatConnections, () => {
  const byUser = new Map<number, Set<Writer>>();

  const register: Context.Tag.Service<typeof ChatConnections>["register"] = (
    userId,
    write,
  ) =>
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
    typeof ChatConnections
  >["notifyUsers"] = (userIds, event) =>
    Effect.gen(function* () {
      const payload = JSON.stringify(event);
      const seen = new Set<number>();
      for (const userId of userIds) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        const writers = byUser.get(userId);
        if (!writers) continue;
        for (const write of writers) {
          yield* write(payload).pipe(Effect.ignore);
        }
      }
    });

  return { register, notifyUsers };
});
