/// <reference types="bun" />
import { expect, test } from "bun:test";
import { buildTimeline, chatEventText, type ChatEvent } from "./chatTimeline";

const ME = 1;
const bob = { userId: 2, name: "Bob" };
const carol = { userId: 3, name: "Carol" };
const me = { userId: ME, name: "Me" };

let nextId = 1;
const event = (overrides: Partial<ChatEvent>): ChatEvent => ({
  id: nextId++,
  type: "member_left",
  afterMessageId: 0,
  actor: bob,
  target: null,
  detail: null,
  createdAt: nextId,
  ...overrides,
});
const message = (id: number) => ({ id, createdAt: id });
const shape = (items: ReturnType<typeof buildTimeline>) =>
  items.map((item) =>
    item.kind === "message" ? item.message.id : item.events.map((e) => e.type),
  );

test("events follow the message they came after, deleted or not", () => {
  const items = buildTimeline(
    [message(10), message(20)],
    [
      event({ afterMessageId: 0 }),
      // Message 15 has been deleted.
      event({ afterMessageId: 15, type: "renamed" }),
      event({ afterMessageId: 20, type: "avatar_changed" }),
    ],
    false,
  );
  expect(shape(items)).toEqual([
    ["member_left"],
    10,
    ["renamed"],
    20,
    ["avatar_changed"],
  ]);
});

test("events from before the loaded window wait for it", () => {
  const events = [
    event({ afterMessageId: 5 }),
    event({ afterMessageId: 10, type: "renamed" }),
  ];
  expect(shape(buildTimeline([message(10)], events, true))).toEqual([
    10,
    ["renamed"],
  ]);
});

test("a chat with no messages still shows its events", () => {
  expect(shape(buildTimeline([], [event({})], false))).toEqual([
    ["member_left"],
  ]);
});

test("people added together share a row", () => {
  const added = (target: ChatEvent["target"], createdAt: number) =>
    event({ type: "member_added", target, createdAt });
  const items = buildTimeline(
    [],
    [added(carol, 5), added(me, 5), added(null, 9)],
    false,
  );
  expect(
    items.map((i) => i.kind === "events" && chatEventText(i.events, ME)),
  ).toEqual(["Bob added Carol and you", "Bob added a deleted account"]);
});

test("rows name you, and who is gone", () => {
  const text = (overrides: Partial<ChatEvent>) =>
    chatEventText([event(overrides)], ME);
  expect(text({ type: "member_removed", actor: me, target: bob })).toBe(
    "You removed Bob",
  );
  expect(text({ actor: null })).toBe("A deleted account left");
  expect(text({ type: "renamed", detail: "Trip" })).toBe(
    "Bob renamed the group to “Trip”",
  );
  expect(text({ type: "owner_changed", target: carol })).toBe(
    "Bob made Carol the owner",
  );
  expect(text({ type: "owner_changed", actor: null, target: carol })).toBe(
    "Carol is now the owner",
  );
  expect(text({ type: "owner_changed", actor: null, target: me })).toBe(
    "You are now the owner",
  );
  expect(text({ type: "admin_granted", target: me })).toBe(
    "Bob made you an admin",
  );
});
