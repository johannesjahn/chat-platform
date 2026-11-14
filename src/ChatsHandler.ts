import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { Db } from "./Db.ts";
import { RateLimiter } from "./RateLimiter.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { chatHandlers } from "./chats/chatHandlers.ts";
import { forwardHandlers } from "./chats/forwardHandlers.ts";
import { inviteHandlers } from "./chats/inviteHandlers.ts";
import { membershipHandlers } from "./chats/membershipHandlers.ts";
import { messageHandlers } from "./chats/messageHandlers.ts";
import { pinStarHandlers } from "./chats/pinStarHandlers.ts";
import { readHandlers } from "./chats/readHandlers.ts";

// The `chats` group, one module per area under src/chats/ (issue #811):
//
// - chatHandlers — list/get, direct chats, title and group avatar;
// - membershipHandlers — group creation, members, roles, requests, leave and
//   delete;
// - inviteHandlers — invite links and joining through one;
// - messageHandlers — list, send, edit, delete, typing, reactions;
// - readHandlers — read receipts and the unread total;
// - forwardHandlers — forwarding a message into other chats;
// - pinStarHandlers — pins (shared) and stars (private).
//
// Shared helpers sit next to them: the single send path (sendPath.ts —
// `insertMessage`, `directChatBlocked`, `publishNewMessage`, also used by
// forwarding), participation/permission checks (access.ts), chat rows,
// versions and the `Chat` view (chatState.ts), the `Message` view
// (messageViews.ts) and unread counts (unread.ts). `handleAll` fails to
// typecheck if an endpoint is left unhandled.
export const ChatsHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "chats",
  Effect.fn(function* (handlers) {
    const deps = {
      db: yield* Db,
      storage: yield* AttachmentStorage,
      limiter: yield* RateLimiter,
      connections: yield* RealtimeConnections,
    };
    return handlers.handleAll({
      ...chatHandlers(deps),
      ...membershipHandlers(deps),
      ...inviteHandlers(deps),
      ...messageHandlers(deps),
      ...readHandlers(deps),
      ...forwardHandlers(deps),
      ...pinStarHandlers(deps),
    });
  }),
);
