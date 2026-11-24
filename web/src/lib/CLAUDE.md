# Client library (`web/src/lib/`)

## Realtime cache updates

The client patches what it can from realtime events and refetches only what
it must. The pieces are pure and unit-tested, driven from
`realtimeSocket.ts`. The reconnect self-heal (invalidate every event-driven
query on each socket open, and on a server `resync`) underpins all of them;
keep it.

- **Chats: `chatSync.ts`** (issue #749). `chat_updated` may carry a
  `change`: a `read` is patched in with no request; a `message_created` in a
  chat on screen (`holdChatInView`) fetches only `after=`; off screen it is
  counted into the unread badge and its `message` becomes the listed chat's
  preview and moves it up, with no request (#834). A conversation that closes
  before it got to a message left to it refetches the lists. The conversation's
  mark-read response (`applyMarkedRead`) updates list, detail and unread
  total. No `change` or a version gap refetches all three.
  Query keys live in import-free `chatQueryKeys.ts` so this stays testable
  without the API client.
- **Own posts/comments** (issue #753). A create writes its response into the
  cache. A comment's realtime echo (published _before_ the response,
  with no actor) is dropped (`ownWrites.ts`): events in the create's scope
  (`ownCommentScope(postId)`) are held while it's in flight, the one
  naming the created id dropped, the rest applied; a failed create applies
  what it held. `comment_changed` invalidates only its post
  (`invalidatePostComments`); a comment's `reaction_changed` names its
  `postId` and is patched into that post's comments only
  (`patchCachedComment`, #810).
- **Posts: watchers, batches, `feed_head`** (#827, #828). Every rendered
  `PostCard` watches its post (`usePostRoom` in `postRooms.ts`), separately
  from a comment section's room, so cards get no comment traffic. Reactions
  arrive as batched `post_reactions` frames; new posts as `feed_head`, which
  shows a "New posts" pill that fetches only when used (`feedHead.ts`).
- **`staleTime`: `realtimeFreshness.ts`** (#752). `realtimeStaleTime(room?)`
  gives chat lists, unread counts and `useGameLobbies`
  `REALTIME_STALE_TIME_MS` only while the socket (and the room, for
  room-scoped data) has been live since the data arrived, else 0. Use it
  only for data some event invalidates. A room counts as joined once
  `subscribe_room` was sent (`games/rooms.ts`); `useGameHubRoom` keeps a
  hub room joined for that window after its last user. It composes with
  `refetchUnlessWarmed`.

Request counts are pinned by `web/e2e/chat-request-fanout.spec.ts`,
`own-writes.spec.ts` and `stale-time.spec.ts`.

## Optimistic message sends

A sent message shows in the thread at once and the composer clears
immediately: `onSend` is fire-and-forget into the outbox (`outbox.ts`, state
machine in `outboxStore.ts`), which shows a "sending"
`PendingMessageBubble` and sends in the background.

- **One request at a time per chat**: bubbles appear at once, sends go out
  in order, so two can't race and swap ids.
- **Matched by `clientId`, both ways**: `Message.clientId` (echoed only to
  the sender) is how the thread hides a pending bubble whose real message
  the realtime refetch already brought in (the server publishes
  `chat_updated` before answering the POST). A message shown as a bubble
  first (`wasShownBeforeConfirm`) skips its entrance animation.
- **Hands off to the offline queue**: the outbox is in-memory (outlives the
  conversation view, not a reload); a send that gets no response while
  offline moves to `offlineQueue.ts` under the same `clientId`. A server
  rejection, or no response while online, stays a "failed" bubble with
  Retry (same `clientId`) and Discard.

## Role checks

Role checks the UI mirrors from the server go through `chatRoles.ts`.
