import type { AttachmentStorage } from "../AttachmentStorage.ts";
import type { TokenVersionCache } from "../Auth.ts";
import type { DrizzleDb } from "../Db.ts";
import type { GroupHandlers } from "../handlerKit.ts";
import type { Jwt } from "../Jwt.ts";
import type { PubSub } from "../PubSub.ts";
import type { RateLimiter } from "../RateLimiter.ts";
import type { RealtimeConnections } from "../Realtime.ts";

// The services every users handler closes over, resolved once when the
// group is built (see UsersHandler.ts).
export interface UsersDeps {
  readonly db: DrizzleDb;
  readonly storage: AttachmentStorage["Service"];
  readonly limiter: RateLimiter["Service"];
  readonly connections: RealtimeConnections["Service"];
  readonly pubsub: PubSub["Service"];
  readonly jwt: Jwt["Service"];
  readonly tokenVersionCache: TokenVersionCache["Service"];
}

export type UsersHandlers = GroupHandlers<"users">;
