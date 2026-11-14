import type {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/http-api";
import type { ChatApi } from "../Api.ts";
import type { AttachmentStorage } from "../AttachmentStorage.ts";
import type { DrizzleDb } from "../Db.ts";
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

type ChatsEndpoints =
  typeof ChatApi extends HttpApi.HttpApi<string, infer Groups>
    ? HttpApiBuilder.Handlers.FromGroup<
        HttpApiGroup.WithIdentifier<Groups, "chats">
      >["~EndpointsByIdentifier"]
    : never;

// What each area module returns: some of the `chats` group's handlers, keyed
// by endpoint name. Use it with `satisfies`, so the handlers' request
// parameters stay contextually typed and their requirements stay inferred
// for `handleAll` in ChatsHandler.ts, which checks every endpoint is handled.
export type ChatsHandlers = {
  readonly [Name in keyof ChatsEndpoints]?: HttpApiEndpoint.Handler<
    ChatsEndpoints[Name],
    HttpApiEndpoint.MiddlewareError<ChatsEndpoints[Name]>,
    unknown
  >;
};
