# Conversation view (`web/src/components/chat/`)

`ChatConversation` is the one chat view, shared by the `/chats/$id` page,
the docked windows (`ChatDock`) and the search preview
(`variant="docked"`); extend it rather than building a second one.

- **Pieces live beside it** (issue #811): `useThreadScroll` (scroll
  ownership, paging older history, jump-to-message,
  `renameForScrollRestoration`), `useMarkReadWhileVisible`,
  `pendingMessages.ts` + `PendingMessageList` (outbox wiring, see
  `web/src/lib/CLAUDE.md`), `ConversationHeader`, `ThreadMessages`. A
  bubble's hooks, action group and `MessageActionSheet` are in `bubble/`;
  group settings sections in `group/`.
- **The thread owns its scroll position** (issue #614): it opts out of the
  router's scroll restoration with a `data-scroll-restoration-id` that's
  unique per mount and renamed on every scroll, so no remembered offset
  matches it. Any new code that scrolls the thread calls
  `renameForScrollRestoration`.
- `useImmersiveShell` is reference-counted because the chats layout and the
  conversation both hold it; it clamps the root's
  `data-app-frame`/`data-app-column` boxes.
- **Chat details** (issues #563, #907): at `xl`+ the chats layout grows a
  third pane, `ChatDetailsPanel`, toggled from the header and remembered
  per device (`web/src/lib/chatDetails.ts`). Below `xl`, "Chat details"
  opens the same contents as a full-screen `ChatDetailsSheet` (the only
  place a phone reaches starred messages, shared media and a direct chat's
  details), and a group's "Manage" opens the group settings modal. Panel,
  sheet and modal all render `GroupSettingsSections`
  (`GroupManagementDialog.tsx`), and panel and sheet `ChatDetailsContent`;
  extend those. The panel sits outside the conversation, so its "show this
  message" rows go through `requestJumpToMessage`.
- A message request renders read-only with `MessageRequestBar` in place of
  the composer (see `src/chats/CLAUDE.md`).
