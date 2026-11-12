/// <reference types="bun" />
import { beforeEach, expect, test } from "bun:test";
import type { ChatMessage } from "./chats";
import { createOutbox, type OutboxMessage } from "./outboxStore";

// Tests the outbox's state machine (lib/outboxStore.ts) with its request and
// side effects stubbed — no module mocks, which Bun shares across every test
// file in a run.

const CHAT = 7;

function serverMessage(entry: OutboxMessage, id: number): ChatMessage {
  return {
    id,
    chatId: entry.chatId,
    senderId: 1,
    contentType: entry.contentType,
    content: entry.content,
    attachment: null,
    caption: null,
    parentMessage: null,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
    readByUserIds: [],
    reactions: [],
    pinned: false,
    starred: false,
    forwardedFrom: null,
    clientId: entry.clientId,
  };
}

// A request that stays open until the test settles it.
type Request = {
  entry: OutboxMessage;
  resolve: (id: number) => void;
  reject: (message: string) => void;
  fail: () => void;
};

let requests: Request[];
let confirmed: ChatMessage[];
let handedOff: OutboxMessage[];
let online: boolean;
let outbox: ReturnType<typeof createOutbox>;
let nextClientId: number;

beforeEach(() => {
  requests = [];
  confirmed = [];
  handedOff = [];
  online = true;
  nextClientId = 0;
  outbox = createOutbox({
    post: (entry) =>
      new Promise((resolve, reject) => {
        requests.push({
          entry,
          resolve: (id) => resolve({ message: serverMessage(entry, id) }),
          reject: (message) => resolve({ error: { message } }),
          fail: () => reject(new TypeError("Failed to fetch")),
        });
      }),
    confirmed: (_entry, message) => {
      confirmed.push(message);
    },
    handOff: (entry) => {
      if (online) return false;
      handedOff.push(entry);
      return true;
    },
  });
});

function send(content: string): string {
  const clientId = `client-${++nextClientId}`;
  outbox.add({
    clientId,
    chatId: CHAT,
    ownerId: 1,
    contentType: "text",
    content,
    createdAt: 0,
  });
  return clientId;
}

// Lets every promise callback already queued run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a send shows as 'sending' at once and becomes the real message", async () => {
  send("hi");
  expect(outbox.getEntries()).toMatchObject([
    { content: "hi", status: "sending" },
  ]);

  await flush();
  expect(requests).toHaveLength(1);
  // The entry stays until the server answers…
  expect(outbox.getEntries()).toHaveLength(1);
  requests[0]!.resolve(100);
  await flush();

  // …and is swapped for the real message in one step.
  expect(outbox.getEntries()).toEqual([]);
  expect(confirmed.map((m) => m.id)).toEqual([100]);
});

test("notifies subscribers on every change", async () => {
  let calls = 0;
  const unsubscribe = outbox.subscribe(() => calls++);
  send("hi");
  expect(calls).toBe(1);
  await flush();
  requests[0]!.resolve(1);
  await flush();
  expect(calls).toBe(2);
  unsubscribe();
  send("again");
  expect(calls).toBe(2);
});

test("sends to one chat go out one at a time, in order", async () => {
  send("first");
  send("second");
  // Both are on screen straight away.
  expect(outbox.getEntries().map((e) => e.content)).toEqual([
    "first",
    "second",
  ]);

  await flush();
  // Only the first request is out until it settles.
  expect(requests.map((r) => r.entry.content)).toEqual(["first"]);
  requests[0]!.resolve(1);
  await flush();
  expect(requests.map((r) => r.entry.content)).toEqual(["first", "second"]);
  requests[1]!.resolve(2);
  await flush();

  expect(confirmed.map((m) => m.content)).toEqual(["first", "second"]);
  expect(outbox.getEntries()).toEqual([]);
});

test("a send to another chat doesn't wait for this one's", async () => {
  send("here");
  outbox.add({
    clientId: "elsewhere",
    chatId: CHAT + 1,
    ownerId: 1,
    contentType: "text",
    content: "there",
    createdAt: 0,
  });
  await flush();
  expect(requests.map((r) => r.entry.content)).toEqual(["here", "there"]);
});

test("a rejected send is marked failed, and a retry reuses its clientId", async () => {
  const clientId = send("nope");
  await flush();
  requests[0]!.reject("blocked");
  await flush();

  expect(outbox.getEntries()).toMatchObject([
    { clientId, status: "failed", error: "blocked" },
  ]);
  // A rejection isn't retried on its own.
  await flush();
  expect(requests).toHaveLength(1);

  outbox.retry(clientId);
  expect(outbox.getEntries()[0]!.status).toBe("sending");
  expect(outbox.getEntries()[0]!.error).toBeUndefined();
  await flush();
  expect(requests[1]!.entry.clientId).toBe(clientId);
  requests[1]!.resolve(5);
  await flush();
  expect(outbox.getEntries()).toEqual([]);
  expect(confirmed.map((m) => m.id)).toEqual([5]);
});

test("a later send still goes out after an earlier one is rejected", async () => {
  send("bad");
  send("good");
  await flush();
  requests[0]!.reject("nope");
  await flush();
  expect(requests.map((r) => r.entry.content)).toEqual(["bad", "good"]);
});

test("a send with no response is handed off when the hand-off takes it", async () => {
  const clientId = send("later");
  await flush();
  online = false;
  requests[0]!.fail();
  await flush();

  expect(outbox.getEntries()).toEqual([]);
  expect(handedOff.map((e) => e.clientId)).toEqual([clientId]);
});

test("a send with no response stays as failed when the hand-off declines", async () => {
  send("hm");
  await flush();
  requests[0]!.fail();
  await flush();

  expect(outbox.getEntries()).toMatchObject([
    { status: "failed", error: "Failed to fetch" },
  ]);
  expect(handedOff).toEqual([]);
});

test("a message dismissed while waiting its turn is never sent", async () => {
  send("first");
  const second = send("second");
  outbox.dismiss(second);
  await flush();
  requests[0]!.resolve(1);
  await flush();

  expect(requests.map((r) => r.entry.content)).toEqual(["first"]);
  expect(outbox.getEntries()).toEqual([]);
});

test("retry ignores a message that isn't failed", async () => {
  const clientId = send("hi");
  outbox.retry(clientId);
  await flush();
  expect(requests).toHaveLength(1);
});
