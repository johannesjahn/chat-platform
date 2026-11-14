import type { AttachmentStorage } from "../AttachmentStorage.ts";
import type { DrizzleDb } from "../Db.ts";
import type { GroupHandlers } from "../handlerKit.ts";
import type { RateLimiter } from "../RateLimiter.ts";
import type { RealtimeConnections } from "../Realtime.ts";

// The services every chats handler closes over, resolved once when the
// group is built (see ChatsHandler.ts).
export interface ChatsDeps {
  readonly db: DrizzleDb;
  readonly storage: AttachmentStorage["Service"];
  readonly limiter: RateLimiter["Service"];
  readonly connections: RealtimeConnections["Service"];
}

export type ChatsHandlers = GroupHandlers<"chats">;
