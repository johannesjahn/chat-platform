import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { TokenVersionCache } from "./Auth.ts";
import { Db } from "./Db.ts";
import { Jwt } from "./Jwt.ts";
import { PubSub } from "./PubSub.ts";
import { RateLimiter } from "./RateLimiter.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { accountHandlers } from "./users/accountHandlers.ts";
import { authHandlers } from "./users/authHandlers.ts";
import { blockHandlers } from "./users/blockHandlers.ts";
import { directoryHandlers } from "./users/directoryHandlers.ts";
import { profileHandlers } from "./users/profileHandlers.ts";

// The `users` group, one module per area under src/users/ (issue #811):
//
// - directoryHandlers — search, contacts, lookup, profiles, a user's posts;
// - authHandlers — register, login, refresh, logout, change password;
// - profileHandlers — profile, avatar and status of the caller;
// - accountHandlers — deleting an account (own or, as admin, anyone's) and
//   site roles;
// - blockHandlers — blocks and mutes.
//
// Shared helpers: userViews.ts (the `User`/`UserProfile` views, also used by
// other groups) and credentials.ts (password hashing). `handleAll` fails to
// typecheck if an endpoint is left unhandled.
export const UsersHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "users",
  Effect.fn(function* (handlers) {
    const deps = {
      db: yield* Db,
      storage: yield* AttachmentStorage,
      limiter: yield* RateLimiter,
      connections: yield* RealtimeConnections,
      pubsub: yield* PubSub,
      jwt: yield* Jwt,
      tokenVersionCache: yield* TokenVersionCache,
    };
    return handlers.handleAll({
      ...directoryHandlers(deps),
      ...authHandlers(deps),
      ...profileHandlers(deps),
      ...accountHandlers(deps),
      ...blockHandlers(deps),
    });
  }),
);
