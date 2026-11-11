/// <reference types="bun" />
import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  chatsListQueryKey,
  chatsListQueryOptions,
  chatsUnreadCountQueryKey,
  chatsUnreadCountQueryOptions,
  loadedUnreadCount,
  unreadChatsListQueryKey,
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
  expect([...unreadChatsListQueryKey]).not.toEqual([...chatsListQueryKey]);
});

test("invalidating the chat list also invalidates the unread total and the Unread list", async () => {
  const client = new QueryClient();
  client.setQueryData(chatsListQueryKey, { pages: [], pageParams: [] });
  client.setQueryData(unreadChatsListQueryKey, { pages: [], pageParams: [] });
  client.setQueryData(chatsUnreadCountQueryKey, { count: 3, chats: 1 });

  await client.invalidateQueries({ queryKey: chatsListQueryKey });

  for (const queryKey of [
    chatsListQueryKey,
    unreadChatsListQueryKey,
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
