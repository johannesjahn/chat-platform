import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { WsTicket } from "./WsTicket.ts";

export const RealtimeHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "realtime",
  Effect.fn(function* (handlers) {
    const wsTicket = yield* WsTicket;
    return handlers.handle("createWsTicket", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const ticket = yield* wsTicket.issue(user.id);
        return { ticket };
      }),
    );
  }),
);
