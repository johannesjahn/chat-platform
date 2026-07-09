import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { WsTicket } from "./WsTicket.ts";

export const RealtimeHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "realtime",
  (handlers) =>
    handlers.handle("createWsTicket", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const wsTicket = yield* WsTicket;
        const ticket = yield* wsTicket.issue(user.id);
        return { ticket };
      }),
    ),
);
