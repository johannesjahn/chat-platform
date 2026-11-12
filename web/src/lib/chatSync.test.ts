/// <reference types="bun" />
import { expect, test } from "bun:test";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import type { components } from "./api-types";
import type { Chat, ChatMessage, ChatMessagesPage } from "./chats";
import {
  chatDetailQueryKey,
  chatMessagesQueryKey,
  chatsListQueryKey,
  chatsUnreadCountQueryKey,
} from "./chatQueryKeys";
import { recordChatVersion } from "./chatVersions";
import {
  applyChatUpdated,
  applyMarkedRead,
  applyNewestMessage,
  beginOwnRead,
  holdChatInView,
} from "./chatSync";

// Issue #749: what each `chat_updated` makes this client fetch. These pin
// down that a read receipt and a new message in an open conversation cost
// no refetch of the chat list or the chat, and that everything else —
// including an event from a server that predates `change` — still
// refetches all three.

type ChatsPage = components["schemas"]["ChatsPage"];

const ME = 1;
const BOB = 2;
// The version tracker is module-wide, so every test uses its own chat.
let nextChatId = 100;

const message = (
  id: number,
  chatId: number,
  senderId: number,
  readByUserIds: number[] = [],
): ChatMessage =>
  ({
    id,
    chatId,
    senderId,
    readByUserIds,
    createdAt: id * 1000,
    updatedAt: id * 1000,
  }) as ChatMessage;

const chatOf = (id: number, overrides: Partial<Chat> = {}): Chat =>
  ({
    id,
    version: 1,
    updatedAt: 1000,
    unreadCount: 0,
    lastMessage: null,
    participants: [],
    ...overrides,
  }) as Chat;

function seed(chatId: number, others: Chat[] = []) {
  const client = new QueryClient();
  const messages = [
    message(1, chatId, ME),
    message(2, chatId, ME),
    message(3, chatId, BOB),
  ];
  client.setQueryData<ChatMessagesPage>(chatMessagesQueryKey(chatId), {
    messages,
    hasEarlier: false,
  });
  const chat = chatOf(chatId, { lastMessage: messages[2]!, updatedAt: 3000 });
  client.setQueryData<Chat>(chatDetailQueryKey(chatId), chat);
  client.setQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey, {
    pages: [{ chats: [...others, chat], limit: 20, nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(chatsUnreadCountQueryKey, { count: 4, chats: 2 });
  recordChatVersion(chatId, 1);
  return client;
}

function invalidated(client: QueryClient, chatId: number) {
  const state = (queryKey: readonly unknown[]) =>
    client.getQueryState(queryKey)?.isInvalidated ?? false;
  return {
    list: state(chatsListQueryKey),
    detail: state(chatDetailQueryKey(chatId)),
    messages: state(chatMessagesQueryKey(chatId)),
  };
}

const nothing = { list: false, detail: false, messages: false };
const everything = { list: true, detail: true, messages: true };

test("someone else's read receipt is patched in, with nothing refetched", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  applyChatUpdated(
    client,
    {
      type: "chat_updated",
      chatId,
      version: 2,
      change: "read",
      userId: BOB,
      fromMessageId: 1,
      lastReadMessageId: 3,
    },
    ME,
  );
  expect(invalidated(client, chatId)).toEqual(nothing);
  const window = client.getQueryData<ChatMessagesPage>(
    chatMessagesQueryKey(chatId),
  )!;
  // Only (1, 3], and never the reader's own message.
  expect(window.messages.map((m) => m.readByUserIds)).toEqual([[], [BOB], []]);
});

test("our own read is left to its response here, and refetches the counts elsewhere", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const ownRead = {
    type: "chat_updated" as const,
    chatId,
    change: "read",
    userId: ME,
    fromMessageId: 0,
    lastReadMessageId: 3,
  };

  const end = beginOwnRead(chatId);
  applyChatUpdated(client, { ...ownRead, version: 2 }, ME);
  end();
  expect(invalidated(client, chatId)).toEqual(nothing);

  // From another tab: the unread counts moved, the messages didn't.
  applyChatUpdated(client, { ...ownRead, version: 3 }, ME);
  expect(invalidated(client, chatId)).toEqual({
    list: true,
    detail: true,
    messages: false,
  });
});

test("a new message in an open conversation fetches only the messages", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const release = holdChatInView(chatId);
  applyChatUpdated(
    client,
    {
      type: "chat_updated",
      chatId,
      version: 2,
      change: "message_created",
      messageId: 4,
      senderId: BOB,
    },
    ME,
  );
  release();
  expect(invalidated(client, chatId)).toEqual({
    list: false,
    detail: false,
    messages: true,
  });
});

test("a new message in a chat that isn't open refetches the list and the chat", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  applyChatUpdated(
    client,
    {
      type: "chat_updated",
      chatId,
      version: 2,
      change: "message_created",
      messageId: 4,
      senderId: BOB,
    },
    ME,
  );
  expect(invalidated(client, chatId)).toEqual(everything);
});

test("an event without a change, one this client doesn't know, or after a gap refetches everything", () => {
  for (const event of [
    // From a server that predates `change`.
    { version: 2 },
    { version: 2, change: "something_new" },
    // A read, but version 3 after 1: something was missed.
    {
      version: 3,
      change: "read",
      userId: BOB,
      fromMessageId: 0,
      lastReadMessageId: 3,
    },
  ]) {
    const chatId = nextChatId++;
    const client = seed(chatId);
    const warn = console.warn;
    console.warn = () => {};
    applyChatUpdated(client, { type: "chat_updated", chatId, ...event }, ME);
    console.warn = warn;
    expect(invalidated(client, chatId)).toEqual(everything);
  }
});

test("a redelivered event does nothing", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  applyChatUpdated(client, { type: "chat_updated", chatId, version: 1 }, ME);
  expect(invalidated(client, chatId)).toEqual(nothing);
});

test("a mark-read response is written into the chat, the list and the unread total", () => {
  const chatId = nextChatId++;
  const other = chatOf(nextChatId++, { updatedAt: 5000 });
  const client = seed(chatId, [other]);
  client.setQueryData<Chat>(chatDetailQueryKey(chatId), (chat) => ({
    ...chat!,
    unreadCount: 3,
  }));
  const newest = message(9, chatId, BOB);
  const read = chatOf(chatId, {
    version: 5,
    unreadCount: 0,
    lastMessage: newest,
    updatedAt: 9000,
  });

  applyMarkedRead(client, read);

  expect(client.getQueryData(chatDetailQueryKey(chatId))).toEqual(read);
  // Newest activity first: it moves above the other chat.
  const list = client.getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)!;
  expect(list.pages[0]!.chats.map((c) => c.id)).toEqual([chatId, other.id]);
  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 1,
    chats: 1,
  });
  expect(invalidated(client, chatId)).toEqual(nothing);
  // And its echo, carrying the same version, is recognised as applied.
  applyChatUpdated(
    client,
    {
      type: "chat_updated",
      chatId,
      version: 5,
      change: "read",
      userId: ME,
      fromMessageId: 0,
      lastReadMessageId: 9,
    },
    ME,
  );
  expect(invalidated(client, chatId)).toEqual(nothing);
});

test("our own newest message becomes the preview without a refetch", () => {
  const chatId = nextChatId++;
  const other = chatOf(nextChatId++, { updatedAt: 5000 });
  const client = seed(chatId, [other]);
  const sent = message(7, chatId, ME);

  applyNewestMessage(client, chatId, sent);

  expect(
    client.getQueryData<Chat>(chatDetailQueryKey(chatId))?.lastMessage,
  ).toEqual(sent);
  const list = client.getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)!;
  expect(list.pages[0]!.chats.map((c) => c.id)).toEqual([chatId, other.id]);
  expect(list.pages[0]!.chats[0]!.lastMessage).toEqual(sent);
  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 4,
    chats: 2,
  });
  expect(invalidated(client, chatId)).toEqual(nothing);
});
