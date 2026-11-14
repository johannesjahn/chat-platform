import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";

export const VersionResponse = Schema.Struct({
  version: Schema.String,
}).annotate({ identifier: "VersionResponse" });

export type VersionResponse = typeof VersionResponse.Type;

export const MetaGroup = HttpApiGroup.make("meta").add(
  // Unauthenticated on purpose — the frontend displays this in its footer
  // before (and regardless of) login.
  HttpApiEndpoint.get("getVersion", "/version", {
    success: VersionResponse,
  }),
);

export const WsTicketResponse = Schema.Struct({
  ticket: Schema.String,
}).annotate({ identifier: "WsTicketResponse" });

export type WsTicketResponse = typeof WsTicketResponse.Type;

export const RealtimeGroup = HttpApiGroup.make("realtime").add(
  // Mints a short-lived, single-use ticket (see WsTicket.ts) for the raw
  // `/ws` route to redeem on upgrade — the browser `WebSocket` handshake
  // can't carry the normal `Authorization: Bearer` header, so this lets it
  // authenticate without putting the long-lived access token itself in a URL
  // (see issue #26).
  HttpApiEndpoint.post("createWsTicket", "/realtime/ws-ticket", {
    success: WsTicketResponse.pipe(HttpApiSchema.status(201)),
  }).middleware(Authentication),
);
