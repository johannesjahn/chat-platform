import type { components } from "./api-types";

// A group's activity (issue #900) placed between its messages, and worded.
// No imports but types, so it's unit-testable on its own.

export type ChatEvent = components["schemas"]["ChatEvent"];

type TimelineMessage = { id: number; createdAt: number };

export type TimelineItem<M extends TimelineMessage> =
  | { kind: "message"; message: M; index: number; createdAt: number }
  | { kind: "events"; events: ChatEvent[]; createdAt: number };

// People added in one go (one insert, so one timestamp) share a row.
function sharesRow(a: ChatEvent, b: ChatEvent): boolean {
  return (
    a.type === "member_added" &&
    b.type === "member_added" &&
    a.createdAt === b.createdAt &&
    a.actor?.userId === b.actor?.userId
  );
}

/**
 * Messages and events in display order, both given oldest first. An event
 * follows the newest loaded message at or before its `afterMessageId` (which
 * may have been deleted since). One from before the loaded window waits
 * until those messages are loaded.
 */
export function buildTimeline<M extends TimelineMessage>(
  messages: readonly M[],
  events: readonly ChatEvent[],
  hasEarlier: boolean,
): TimelineItem<M>[] {
  const items: TimelineItem<M>[] = [];
  const first = messages[0];
  let next = 0;
  const takeBefore = (messageId: number) => {
    for (; next < events.length; next++) {
      const event = events[next]!;
      if (event.afterMessageId >= messageId) return;
      if (hasEarlier && first && event.afterMessageId < first.id) continue;
      const last = items.at(-1);
      if (last?.kind === "events" && sharesRow(last.events[0]!, event))
        last.events.push(event);
      else
        items.push({
          kind: "events",
          events: [event],
          createdAt: event.createdAt,
        });
    }
  };
  messages.forEach((message, index) => {
    takeBefore(message.id);
    items.push({
      kind: "message",
      message,
      index,
      createdAt: message.createdAt,
    });
  });
  takeBefore(Infinity);
  return items;
}

function list(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** One row's sentence, for the events sharing it. */
export function chatEventText(events: ChatEvent[], meId: number): string {
  const event = events[0]!;
  const subject = (person: ChatEvent["actor"]) =>
    !person
      ? "A deleted account"
      : person.userId === meId
        ? "You"
        : person.name;
  const object = (person: ChatEvent["target"]) =>
    !person
      ? "a deleted account"
      : person.userId === meId
        ? "you"
        : person.name;
  const actor = subject(event.actor);
  const target = object(event.target);
  switch (event.type) {
    case "member_added":
      return `${actor} added ${list(events.map((e) => object(e.target)))}`;
    case "member_joined":
      return `${actor} joined with an invite link`;
    case "member_left":
      return `${actor} left`;
    case "member_removed":
      return `${actor} removed ${target}`;
    case "renamed":
      return `${actor} renamed the group to “${event.detail ?? ""}”`;
    case "avatar_changed":
      return `${actor} changed the group picture`;
    case "avatar_removed":
      return `${actor} removed the group picture`;
    case "owner_changed":
      // Nobody's doing when the owner left and the group passed on.
      return event.actor
        ? `${actor} made ${target} the owner`
        : event.target?.userId === meId
          ? "You are now the owner"
          : `${subject(event.target)} is now the owner`;
    case "admin_granted":
      return `${actor} made ${target} an admin`;
    case "admin_revoked":
      return `${actor} removed ${target} as admin`;
  }
}
