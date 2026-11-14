import type { DrizzleDb } from "../Db.ts";
import type { GroupHandlers } from "../handlerKit.ts";
import type { RateLimiter } from "../RateLimiter.ts";
import type { RealtimeConnections } from "../Realtime.ts";

// The services every games handler closes over, resolved once when the
// group is built (see GamesHandler.ts).
export interface GamesDeps {
  readonly db: DrizzleDb;
  readonly limiter: RateLimiter["Service"];
  readonly connections: RealtimeConnections["Service"];
}

export type GamesHandlers = GroupHandlers<"games">;
