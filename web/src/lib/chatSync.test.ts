/// <reference types="bun" />
import { expect, test } from "bun:test";
import {
  type InfiniteData,
  InfiniteQueryObserver,
  QueryClient,
} from "@tanstack/react-query";
import type { components } from "./api-types";
import type { Chat, ChatMessage, ChatMessagesPage } from "./chats";
import {
  archivedChatsListQueryKey,
  chatDetailQueryKey,
  chatMessagesQueryKey,
  chatRequestsListQueryKey,
  chatsListQueryKey,
  chatsUnreadCountQueryKey,
  unreadChatsListQueryKey,
} from "./chatQueryKeys";
import { recordChatVersion } from "./chatVersions";
import {
  applyChatUpdated,
  applyMarkedRead,
  applyNewestMessage,
  beginOwnRead,
  holdChatInView,
  LIST_REFETCH_WINDOW_MS,
} from "./chatSync";

// Issue #749: what each `chat_updated` makes this client fetch. These pin
// down that a read receipt and a new message in an open conversation cost
// no refetch of the chat list or the chat, and that everything else still
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
    change: "read" as const,
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
      message: message(4, chatId, BOB),
    },
    ME,
  );
  expect(invalidated(client, chatId)).toEqual({
    list: false,
    detail: false,
    messages: true,
  });
  release();
});

test("an event without a change, or after a gap refetches everything", () => {
  for (const event of [
    { version: 2 },
    // A read, but version 3 after 1: something was missed.
    {
      version: 3,
      change: "read" as const,
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

test("reading a message request updates it in the requests list, never the main one", () => {
  const chatId = nextChatId++;
  const other = chatOf(nextChatId++, { updatedAt: 5000 });
  const client = seed(chatId, [other]);
  // A pending request isn't in the main list; it's in the requests list.
  client.setQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey, {
    pages: [{ chats: [other], limit: 20, nextCursor: null }],
    pageParams: [undefined],
  });
  const pending = { addedBy: BOB } as Chat["messageRequest"];
  client.setQueryData<InfiniteData<ChatsPage>>(chatRequestsListQueryKey, {
    pages: [
      {
        chats: [chatOf(chatId, { messageRequest: pending })],
        limit: 20,
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  const read = chatOf(chatId, {
    version: 5,
    messageRequest: pending,
    lastMessage: message(9, chatId, BOB),
    updatedAt: 9000,
  });

  applyMarkedRead(client, read);

  const main = client.getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)!;
  expect(main.pages[0]!.chats.map((c) => c.id)).toEqual([other.id]);
  const requests = client.getQueryData<InfiniteData<ChatsPage>>(
    chatRequestsListQueryKey,
  )!;
  expect(requests.pages[0]!.chats).toEqual([read]);
  expect(client.getQueryState(chatsListQueryKey)?.isInvalidated).toBe(false);
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

// Issue #834: a message in a chat that isn't open used to refetch the unread
// total and the list for every recipient.
const newMessage = (chatId: number, version: number, senderId = BOB) =>
  ({
    type: "chat_updated",
    chatId,
    version,
    change: "message_created",
    messageId: 10 + version,
    senderId,
    message: message(10 + version, chatId, senderId),
  }) as const;

const listedChat = (client: QueryClient, chatId: number) =>
  client
    .getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)
    ?.pages.flatMap((page) => page.chats)
    .find((chat) => chat.id === chatId);

test("someone else's message in a listed chat is counted into the badge, the list and the chat without refetching the total", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  applyChatUpdated(client, newMessage(chatId, 2), ME);

  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 5,
    chats: 3,
  });
  expect(client.getQueryState(chatsUnreadCountQueryKey)?.isInvalidated).toBe(
    false,
  );
  expect(listedChat(client, chatId)?.unreadCount).toBe(1);
  expect(
    client.getQueryData<Chat>(chatDetailQueryKey(chatId))?.unreadCount,
  ).toBe(1);
  // A second one counts again, but the chat was already unread.
  applyChatUpdated(client, newMessage(chatId, 3), ME);
  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 6,
    chats: 3,
  });
});

test("a message in a chat the list doesn't have refetches the total instead", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const elsewhere = nextChatId++;
  recordChatVersion(elsewhere, 1);
  applyChatUpdated(client, newMessage(elsewhere, 2), ME);
  expect(client.getQueryState(chatsUnreadCountQueryKey)?.isInvalidated).toBe(
    true,
  );
  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 4,
    chats: 2,
  });
});

test("our own message from another device leaves the unread counts alone", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  applyChatUpdated(client, newMessage(chatId, 2, ME), ME);
  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 4,
    chats: 2,
  });
  expect(client.getQueryState(chatsUnreadCountQueryKey)?.isInvalidated).toBe(
    false,
  );
  expect(listedChat(client, chatId)?.unreadCount).toBe(0);
});

test("a burst of messages refetches the lists once at once and once at the end of the window", async () => {
  // A chat the list doesn't hold, so it can't be patched.
  const chatId = nextChatId++;
  const client = seed(nextChatId++);
  recordChatVersion(chatId, 1);
  let listRefetches = 0;
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters, options) => {
    if (
      filters?.queryKey === chatsListQueryKey &&
      filters.predicate !== undefined
    ) {
      listRefetches++;
    }
    return invalidate(filters, options);
  }) as typeof client.invalidateQueries;

  for (const version of [2, 3, 4]) {
    applyChatUpdated(client, newMessage(chatId, version), ME);
  }
  expect(listRefetches).toBe(1);
  await new Promise((resolve) =>
    setTimeout(resolve, LIST_REFETCH_WINDOW_MS + 100),
  );
  expect(listRefetches).toBe(2);
});

// The event carries the message (issue #834), so the list is patched from it
// rather than refetched.
const listOf = (chats: Chat[]): InfiniteData<ChatsPage> => ({
  pages: [{ chats, limit: 20, nextCursor: null }],
  pageParams: [undefined],
});

test("a message the event carries becomes the listed chat's preview and moves it to the top, with no list refetch", () => {
  const chatId = nextChatId++;
  const other = chatOf(nextChatId++, { updatedAt: 5000 });
  const client = seed(chatId, [other]);
  client.setQueryData<InfiniteData<ChatsPage>>(unreadChatsListQueryKey, {
    pages: [{ chats: [other], limit: 20, nextCursor: null }],
    pageParams: [undefined],
  });
  const event = newMessage(chatId, 2);

  applyChatUpdated(client, event, ME);

  const list = client.getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)!;
  expect(list.pages[0]!.chats.map((c) => c.id)).toEqual([chatId, other.id]);
  const listed = list.pages[0]!.chats[0]!;
  expect(listed.lastMessage).toEqual(event.message);
  expect(listed.updatedAt).toBe(event.message.createdAt);
  expect(listed.unreadCount).toBe(1);
  expect(listed.version).toBe(2);
  const detail = client.getQueryData<Chat>(chatDetailQueryKey(chatId))!;
  expect(detail.lastMessage).toEqual(event.message);
  expect(detail.unreadCount).toBe(1);
  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 5,
    chats: 3,
  });
  expect(invalidated(client, chatId)).toEqual({
    list: false,
    detail: false,
    messages: true,
  });
  // The Unread filter's list can't place a chat it doesn't hold, so it's
  // still refetched (when on screen) — and never the unread total.
  expect(client.getQueryState(unreadChatsListQueryKey)?.isInvalidated).toBe(
    true,
  );
  expect(client.getQueryState(chatsUnreadCountQueryKey)?.isInvalidated).toBe(
    false,
  );
});

test("a carried message for a chat nothing here has cached refetches the lists", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const elsewhere = nextChatId++;
  recordChatVersion(elsewhere, 1);

  applyChatUpdated(client, newMessage(elsewhere, 2), ME);

  expect(client.getQueryState(chatsListQueryKey)?.isInvalidated).toBe(true);
});

test("a carried message older than the chat's preview leaves it alone", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const before = listedChat(client, chatId)!.lastMessage;
  const event = {
    ...newMessage(chatId, 2),
    messageId: 2,
    message: message(2, chatId, BOB),
  };

  applyChatUpdated(client, event, ME);

  expect(listedChat(client, chatId)?.lastMessage).toEqual(before);
  expect(client.getQueryState(chatsListQueryKey)?.isInvalidated).toBe(false);
});

test("a carried message that doesn't match the event is ignored, and the list refetched", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const event = { ...newMessage(chatId, 2), messageId: 99 };

  applyChatUpdated(client, event, ME);

  expect(listedChat(client, chatId)?.lastMessage?.id).toBe(3);
  expect(client.getQueryState(chatsListQueryKey)?.isInvalidated).toBe(true);
});

test("our own message from another device, carried, becomes the preview without counting as unread", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const event = newMessage(chatId, 2, ME);

  applyChatUpdated(client, event, ME);

  expect(listedChat(client, chatId)?.lastMessage).toEqual(event.message);
  expect(listedChat(client, chatId)?.unreadCount).toBe(0);
  expect(client.getQueryState(chatsListQueryKey)?.isInvalidated).toBe(false);
});

test("a carried message leaves the requests list alone, and an Unread list that already has the chat", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const unreadChat = chatOf(chatId, { unreadCount: 1 });
  client.setQueryData(unreadChatsListQueryKey, listOf([unreadChat]));
  client.setQueryData(chatRequestsListQueryKey, listOf([]));
  const event = newMessage(chatId, 2);

  applyChatUpdated(client, event, ME);

  expect(client.getQueryState(unreadChatsListQueryKey)?.isInvalidated).toBe(
    false,
  );
  expect(client.getQueryState(chatRequestsListQueryKey)?.isInvalidated).toBe(
    false,
  );
  // Patched in place instead.
  const unread = client.getQueryData<InfiniteData<ChatsPage>>(
    unreadChatsListQueryKey,
  )!;
  expect(unread.pages[0]!.chats[0]!.lastMessage).toEqual(event.message);
});

// Mute, archive and pin (issue #900).
function setChat(
  client: QueryClient,
  chatId: number,
  overrides: Partial<Chat>,
): void {
  const update = (chat: Chat): Chat => ({ ...chat, ...overrides });
  client.setQueryData<Chat>(chatDetailQueryKey(chatId), (c) => c && update(c));
  client.setQueryData<InfiniteData<ChatsPage>>(
    chatsListQueryKey,
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          chats: page.chats.map((c) => (c.id === chatId ? update(c) : c)),
        })),
      },
  );
}

test("a message in a muted chat counts in the chat but not the total", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  setChat(client, chatId, { mutedUntil: Date.now() + 60_000 });
  applyChatUpdated(client, newMessage(chatId, 2), ME);

  expect(listedChat(client, chatId)?.unreadCount).toBe(1);
  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 4,
    chats: 2,
  });
  expect(client.getQueryState(chatsUnreadCountQueryKey)?.isInvalidated).toBe(
    false,
  );

  // Reading it takes nothing off the total either.
  const detail = client.getQueryData<Chat>(chatDetailQueryKey(chatId))!;
  applyMarkedRead(client, { ...detail, unreadCount: 0, version: 3 });
  expect(client.getQueryData(chatsUnreadCountQueryKey)).toEqual({
    count: 4,
    chats: 2,
  });
});

test("once a mute has run out, the total is refetched rather than patched", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  setChat(client, chatId, { mutedUntil: Date.now() - 1 });
  applyChatUpdated(client, newMessage(chatId, 2), ME);
  expect(client.getQueryState(chatsUnreadCountQueryKey)?.isInvalidated).toBe(
    true,
  );
});

test("a message brings an archived chat back to the main list", () => {
  const chatId = nextChatId++;
  const archivedId = nextChatId++;
  const client = seed(chatId);
  recordChatVersion(archivedId, 1);
  client.setQueryData<InfiniteData<ChatsPage>>(
    archivedChatsListQueryKey,
    listOf([chatOf(archivedId, { archived: true, unreadCount: 2 })]),
  );
  applyChatUpdated(client, newMessage(archivedId, 2), ME);

  const inList = (key: readonly unknown[]) =>
    client
      .getQueryData<InfiniteData<ChatsPage>>(key)!
      .pages.flatMap((page) => page.chats)
      .find((c) => c.id === archivedId);
  expect(inList(archivedChatsListQueryKey)).toBeUndefined();
  expect(inList(chatsListQueryKey)?.archived).toBe(false);
  expect(client.getQueryState(chatsUnreadCountQueryKey)?.isInvalidated).toBe(
    true,
  );
});

test("a list fetch in flight when a message un-archives a chat is redone, not left to drop it again", async () => {
  const chatId = nextChatId++;
  const archivedId = nextChatId++;
  const client = seed(chatId);
  recordChatVersion(archivedId, 1);
  client.setQueryData<InfiniteData<ChatsPage>>(
    archivedChatsListQueryKey,
    listOf([chatOf(archivedId, { archived: true })]),
  );
  // The mounted list: each fetch waits to be answered.
  const answers: ((page: ChatsPage) => void)[] = [];
  const observer = new InfiniteQueryObserver(client, {
    queryKey: chatsListQueryKey,
    queryFn: () => new Promise<ChatsPage>((resolve) => answers.push(resolve)),
    initialPageParam: undefined,
    getNextPageParam: () => undefined,
    staleTime: Infinity,
  });
  const stop = observer.subscribe(() => {});
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  void observer.refetch();
  await settle();

  applyChatUpdated(client, newMessage(archivedId, 2), ME);
  await settle();
  // Answered from before the message, when the chat was still archived.
  answers[0]!({ chats: [], limit: 20, nextCursor: null });
  await settle();
  answers[1]?.({
    chats: [chatOf(archivedId)],
    limit: 20,
    nextCursor: null,
  });
  await settle();
  expect(listedChat(client, archivedId)).toBeDefined();
  stop();
});

test("reading an archived chat leaves it out of the main list", () => {
  const chatId = nextChatId++;
  const archivedId = nextChatId++;
  const client = seed(chatId);
  applyMarkedRead(
    client,
    chatOf(archivedId, { archived: true, updatedAt: 9_000_000 }),
  );
  expect(listedChat(client, archivedId)).toBeUndefined();
});

test("a new message doesn't move a chat above a pinned one", () => {
  const chatId = nextChatId++;
  const pinnedId = nextChatId++;
  const client = seed(chatId);
  client.setQueryData<InfiniteData<ChatsPage>>(
    chatsListQueryKey,
    listOf([
      chatOf(pinnedId, { pinned: true, updatedAt: 1 }),
      chatOf(nextChatId++, { updatedAt: 4000 }),
      chatOf(chatId, { updatedAt: 3000 }),
    ]),
  );
  applyChatUpdated(client, newMessage(chatId, 2), ME);
  const ids = client
    .getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)!
    .pages.flatMap((page) => page.chats)
    .map((c) => c.id);
  expect(ids.slice(0, 2)).toEqual([pinnedId, chatId]);
});

test("a message left to a conversation that closes before reading it refetches the lists", () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  const invalidated = () =>
    client.getQueryState(chatsListQueryKey)?.isInvalidated;

  const release = holdChatInView(chatId);
  applyChatUpdated(client, newMessage(chatId, 2), ME);
  expect(invalidated()).toBe(false);
  release();
  expect(invalidated()).toBe(true);
  expect(client.getQueryState(chatsUnreadCountQueryKey)?.isInvalidated).toBe(
    true,
  );

  // Read first, it closes without a request.
  const other = nextChatId++;
  const otherClient = seed(other);
  const releaseOther = holdChatInView(other);
  const event = newMessage(other, 2);
  applyChatUpdated(otherClient, event, ME);
  applyMarkedRead(
    otherClient,
    chatOf(other, {
      lastMessage: event.message,
      updatedAt: 12_000,
      version: 3,
    }),
  );
  releaseOther();
  expect(otherClient.getQueryState(chatsListQueryKey)?.isInvalidated).toBe(
    false,
  );
});

test("a message counts in its chat even while the total is being fetched", async () => {
  const chatId = nextChatId++;
  const client = seed(chatId);
  void client
    .fetchQuery({
      queryKey: chatsUnreadCountQueryKey,
      queryFn: () => new Promise<never>(() => {}),
    })
    .catch(() => {});
  applyChatUpdated(client, newMessage(chatId, 2), ME);
  expect(listedChat(client, chatId)?.unreadCount).toBe(1);
  await client.cancelQueries();
});
