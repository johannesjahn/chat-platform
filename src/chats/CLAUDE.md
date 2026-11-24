# Chats (`src/chats/`)

## Shared modules

Reuse these rather than re-deriving them in a handler:

- `sendPath.ts`: the one send path: `insertMessage`, `directChatClosed`,
  `publishNewMessage`.
- `access.ts`: 404 lookups and participation/role checks. Chat handlers
  start with `loadChatAs(db, id, currentUser, access)` (or
  `loadGroupChatAs`), whose required `access` (`"participant"`,
  `"accepted"`, `"manager"`, `"owner"`) makes the choice explicit.
- `chatState.ts`: participants, `version`, `buildChat`, and
  `publishChatChange` (bump + publish with no `change`), the tail of every
  mutation but a send or a read receipt.
- `messageViews.ts` (the `Message` view), `unread.ts`.
- `departure.ts`: what leaving does to a chat (`departParticipant`: owner
  hand-off, delete once empty, version bump). Account deletion runs it for
  every chat first (`departAllChats`, issue #895), so a deleted account
  never leaves an ownerless group, and the rest get `chat_updated`. A
  direct chat left with one participant is read-only: `directChatClosed`
  rejects sends, the client shows `DeletedAccountBar`. The account's
  messages still cascade away with it.

## Message requests

Being put in a group by someone you share no chat with makes it a _message
request_ for you (issue #785): `chat_participants.request_pending` and
`added_by` (`0038`), decided by `strangersTo` (membershipHandlers.ts),
accepted with `POST /chats/:id/accept`, declined with `/leave`.

- **Per participant, not per chat.** Direct chats and invite-link joins
  never create one.
- **A stranger is judged on accepted chats only**: `strangersTo` counts a
  shared chat only where the added user's row isn't pending, so one request
  can't vouch for the next.
- **Pending means invisible**: out of `GET /chats` (it's under
  `?requests=true`), `unreadCount` 0 and absent from
  `/chats/unread-count`, no presence either way (`PresenceAudience`), not a
  contact (`contactsOf`), and filtered inside each arm of message search's
  `matchingIds` (#808). Any new query over `chat_participants` that
  introduces people or counts unread filters `request_pending = false`.
- **Read-only until accepted** (#808): every write others would see (send,
  edit, typing, reactions, pins, claiming an ownerless group) goes through
  `requireAcceptedParticipant` (`"accepted"` access, 403); a forward into a request is that target's
  `unavailable`; `markRead` is a silent no-op, so viewing sends no receipt.
  Reading, private stars, forwarding _out_, leave and accept stay open.
- **Owner hand-off prefers accepted members**, ahead of seniority.
- Client: `MessageRequestBar` replaces the composer; "Decline and block"
  blocks `messageRequest.addedBy`.

## Mute, archive, pin

`PATCH /chats/:id/preferences` (issue #900, `preferenceHandlers.ts`) sets the
caller's own `muted_until`/`archived_at`/`pinned_at` on `chat_participants`
(`0044`); every rule about them is in `preferences.ts`.

- **Archived is derived**: `archived_at > chats.updated_at`, so a new message
  un-archives without the send path writing participant rows. Only a message
  may move `chats.updated_at`.
- **Muted and archived chats leave `/chats/unread-count`** but keep their own
  `unreadCount`; the client mirrors that with `countsTowardUnread`
  (`web/src/lib/chatMute.ts`) wherever it patches the total.
- **Pinned sorts first**, so it's part of the `listChats` cursor and of
  `upsertListedChat`'s order in `chatSync.ts`.
- Told only to the caller, as `chat_preferences_changed`; never a version bump.

## Group activity

Membership, title, picture, owner and role changes write a `chat_events` row
(issue #900, `0046`) through `recordChatEvents` (`chatEvents.ts`), in the
transaction that makes the change; a new handler that changes a group does
the same.

- **Not messages**: they have no unread, search, forward or archive
  behaviour, and a replica predating them ignores the table. `after_message_id`
  places them in the thread.
- **References, not copies**: names are joined in at read time, so deleting
  an account takes its name out of every group's history.
- Live through the change's own `chat_updated` (no `change`), on which the
  client refetches `GET /chats/:id/events`. Placed and worded by
  `web/src/lib/chatTimeline.ts`.

## Forwarding

`POST /chats/:id/messages/:messageId/forward` (issue #601, `forwardMessage`
in forwardHandlers.ts) copies a message into up to `MAX_FORWARD_TARGETS`
chats.

- **A forward is a new message owned by the forwarder**, built through the
  send path above. It copies none of `parentMessageId`, reactions, reads,
  pins or stars.
- **Attribution is a snapshot**: `messages.forwarded_from_*` (`0034`) store
  the original sender's name at forward time with `set null` FKs. A forward
  of a forward copies them through, so the label always credits the
  original author and never nests.
- **Attachments are copied**: the forward gets its own `attachments` row
  and storage object (`AttachmentStorage.copy`), owned by and counted
  against the forwarder, inserted in one transaction with the message; a
  failed step deletes the object it made. This keeps "one message per
  attachment", which delete, quota and `AttachmentCleanup` rely on.
- **Per-target results**: the source must be in a chat the caller is in
  (404, never 403); each target fails on its own
  (`unavailable`/`blocked`/`quota_exceeded`/`invalid_content`). A
  `clientId` keys each copy as `${clientId}:${targetChatId}`, so a replay
  fills in only the missing targets, and the request is charged N units of
  the per-IP budget (`chargeGlobalRequests`).
