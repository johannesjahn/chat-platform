/// <reference types="bun" />
import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  chatsListQueryKey,
  chatsListQueryOptions,
  chatsUnreadCountQueryKey,
  chatsUnreadCountQueryOptions,
  lastMessagePreview,
  lastMessageSender,
  lastMessageText,
  loadedUnreadCount,
  parentPreviewText,
  unreadChatsListQueryKey,
  chatRequestsListQueryKey,
  type Chat,
} from "./chats";

// Issue #756: the unread total and the Unread filter's list are their own
// queries, refreshed by every invalidation of the chat list — the realtime
// `chat_updated`/`chat_deleted` events, markRead, sends — only because their
// keys extend `chatsListQueryKey`. These pin that down.

test("the unread total and the Unread list are their own cache entries", () => {
  // Spread: the options' keys are data-tagged, the constants aren't.
  expect([...chatsUnreadCountQueryOptions().queryKey]).toEqual([
    ...chatsUnreadCountQueryKey,
  ]);
  expect([...chatsListQueryOptions().queryKey]).toEqual([...chatsListQueryKey]);
  expect([...chatsListQueryOptions({ unreadOnly: true }).queryKey]).toEqual([
    ...unreadChatsListQueryKey,
  ]);
  expect([...chatsListQueryOptions({ requestsOnly: true }).queryKey]).toEqual([
    ...chatRequestsListQueryKey,
  ]);
  expect([...unreadChatsListQueryKey]).not.toEqual([...chatsListQueryKey]);
});

test("invalidating the chat list also invalidates the unread total and the Unread list", async () => {
  const client = new QueryClient();
  client.setQueryData(chatsListQueryKey, { pages: [], pageParams: [] });
  client.setQueryData(unreadChatsListQueryKey, { pages: [], pageParams: [] });
  client.setQueryData(chatRequestsListQueryKey, { pages: [], pageParams: [] });
  client.setQueryData(chatsUnreadCountQueryKey, { count: 3, chats: 1 });

  await client.invalidateQueries({ queryKey: chatsListQueryKey });

  for (const queryKey of [
    chatsListQueryKey,
    unreadChatsListQueryKey,
    chatRequestsListQueryKey,
    chatsUnreadCountQueryKey,
  ]) {
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true);
  }
});

test("loadedUnreadCount sums the unread counts of the loaded pages", () => {
  const chat = (unreadCount: number) => ({ unreadCount }) as Chat;
  expect(loadedUnreadCount([])).toBe(0);
  expect(
    loadedUnreadCount([{ chats: [chat(2), chat(0)] }, { chats: [chat(1)] }]),
  ).toBe(3);
});

// Issue #768: every chat list previews the last message with its sender —
// "You" for your own, the sender's name in a group, none in a direct chat.
const participant = (userId: number, username: string, displayName = null) =>
  ({ userId, username, displayName }) as Chat["participants"][number];
const withLast = (
  type: Chat["type"],
  last: Partial<NonNullable<Chat["lastMessage"]>> | null,
) =>
  ({
    type,
    participants: [
      participant(1, "me"),
      participant(2, "bob"),
      { ...participant(3, "carol"), displayName: "Carol" },
    ],
    lastMessage: last && { contentType: "text", content: "hi", ...last },
  }) as Chat;

test("the preview names your own last message as yours", () => {
  expect(lastMessagePreview(withLast("direct", { senderId: 1 }), 1)).toBe(
    "You: hi",
  );
  expect(lastMessagePreview(withLast("group", { senderId: 1 }), 1)).toBe(
    "You: hi",
  );
});

test("a group preview names its sender; a direct one doesn't", () => {
  expect(lastMessagePreview(withLast("direct", { senderId: 2 }), 1)).toBe("hi");
  expect(lastMessagePreview(withLast("group", { senderId: 2 }), 1)).toBe(
    "@bob: hi",
  );
  expect(lastMessagePreview(withLast("group", { senderId: 3 }), 1)).toBe(
    "Carol: hi",
  );
  // A sender who has since left the group isn't a participant any more.
  expect(lastMessagePreview(withLast("group", { senderId: 9 }), 1)).toBe("hi");
});

test("non-text and missing last messages preview as a stand-in", () => {
  expect(lastMessagePreview(withLast("direct", null), 1)).toBe(
    "No messages yet",
  );
  expect(lastMessageSender(withLast("direct", null), 1)).toBeUndefined();
  expect(
    lastMessagePreview(
      withLast("group", { senderId: 2, contentType: "image_url" }),
      1,
    ),
  ).toBe("@bob: Photo");
  expect(
    lastMessageText(withLast("direct", { contentType: "attachment" })),
  ).toBe("Attachment");
});

test("a captioned attachment previews as its caption (issue #765)", () => {
  expect(
    lastMessagePreview(
      withLast("group", {
        senderId: 2,
        contentType: "attachment",
        content: "bread.png",
        caption: "Look what I baked",
      }),
      1,
    ),
  ).toBe("@bob: Look what I baked");
  expect(
    parentPreviewText({
      contentType: "attachment",
      content: "bread.png",
      caption: "Look what I baked",
    }),
  ).toBe("📎 Look what I baked");
  expect(
    parentPreviewText({ contentType: "attachment", content: "bread.png" }),
  ).toBe("📎 Attachment");
});
