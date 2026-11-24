import { type CSSProperties, Fragment } from "react";
import type { ReplyTarget } from "@/components/ChatComposer";
import { DateSeparator } from "@/components/DateSeparator";
import { MessageBubble } from "@/components/MessageBubble";
import { TypingDots } from "@/components/reactbits/TypingDots";
import {
  type Chat,
  type ChatMessage,
  localDayKey,
  wasShownBeforeConfirm,
} from "@/lib/chats";
import {
  buildTimeline,
  chatEventText,
  type ChatEvent,
  type TimelineItem,
} from "@/lib/chatTimeline";
import { useTypingUsers } from "@/lib/typing";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";

// Splits oldest-first timeline items into runs sharing a local calendar day.
// Keyed by the day, not by a run's first item: activity arriving, or older
// messages paged in, at the start of a day mustn't remount the rest of it
// (which would lose an edit in progress). A day can recur when timestamps are
// out of order, hence the count.
function groupByDay<T extends { createdAt: number }>(items: T[]) {
  const groups: { key: string; items: T[] }[] = [];
  const runs = new Map<string, number>();
  let lastDay: string | undefined;
  for (const item of items) {
    const day = localDayKey(item.createdAt);
    if (day !== lastDay) {
      const run = runs.get(day) ?? 0;
      runs.set(day, run + 1);
      groups.push({ key: `${day}#${run}`, items: [] });
    }
    groups[groups.length - 1]!.items.push(item);
    lastDay = day;
  }
  return groups;
}

const itemKey = (item: TimelineItem<ChatMessage>) =>
  item.kind === "message" ? `m${item.message.id}` : `e${item.events[0]!.id}`;

// One row of group activity (issue #900).
function ChatEventRow({ events, meId }: { events: ChatEvent[]; meId: number }) {
  return (
    <p
      data-testid="chat-event"
      className="px-6 py-0.5 text-center text-xs wrap-anywhere text-muted-foreground"
    >
      {chatEventText(events, meId)}
    </p>
  );
}

/**
 * The thread's confirmed messages, one MessageBubble each, and a group's
 * activity, with a date separator at the top of each day (split out of
 * ChatConversation in issue #811). The callbacks are per message; what to do
 * with them is the conversation's.
 */
export function ThreadMessages({
  chat,
  messages,
  events,
  hasEarlier,
  me,
  canManage,
  compact,
  jumpHighlight,
  editRequest,
  onEdit,
  onDelete,
  onReply,
  onForward,
  onJumpTo,
  onEditEnd,
}: {
  chat: Chat;
  messages: ChatMessage[];
  events: ChatEvent[];
  hasEarlier: boolean;
  me: { id: number; role: string };
  canManage: boolean;
  compact: boolean;
  jumpHighlight: { messageId: number; key: number } | null;
  editRequest: { messageId: number; key: number } | null;
  onEdit: (messageId: number, content: string) => Promise<void>;
  onDelete: (messageId: number) => Promise<void>;
  onReply: (target: ReplyTarget) => void;
  onForward: (message: ChatMessage) => void;
  onJumpTo: (messageId: number) => void;
  onEditEnd: () => void;
}) {
  const timeline = buildTimeline(messages, events, hasEarlier);
  return groupByDay(timeline).map((group) => (
    // One wrapper per calendar day: a sticky element only stays
    // pinned while its parent is on screen, so scoping each
    // separator to its own day makes it get pushed out by the
    // next day's separator instead of piling up behind it.
    <div key={group.key} className="flex flex-col gap-2">
      {group.items.map((item, position) => {
        const isFirstOfDay = position === 0;
        if (item.kind === "events")
          return (
            <Fragment key={itemKey(item)}>
              {isFirstOfDay && <DateSeparator ms={item.createdAt} />}
              <ChatEventRow events={item.events} meId={me.id} />
            </Fragment>
          );
        const { message, index: i } = item;
        const isOwn = message.senderId === me.id;
        const sender = chat.participants.find(
          (p) => p.userId === message.senderId,
        );
        // Null for a normal message, and also once the quoted
        // message has been deleted — nothing to jump to either way.
        const parentId = message.parentMessage?.id;
        return (
          <Fragment key={itemKey(item)}>
            {isFirstOfDay && <DateSeparator ms={message.createdAt} />}
            <MessageBubble
              message={message}
              isOwn={isOwn}
              isRead={message.readByUserIds.length > 0}
              canModify={isOwn || me.role === "admin"}
              canDeleteOthers={!isOwn && canManage}
              onEdit={(content) => onEdit(message.id, content)}
              onDelete={() => onDelete(message.id)}
              onReply={() =>
                onReply({
                  id: message.id,
                  senderName: sender ? userLabel(sender) : "Someone",
                  body: message.body,
                  hasAttachment: message.attachment !== null,
                })
              }
              onForward={() => onForward(message)}
              onJumpToParent={
                parentId == null ? undefined : () => onJumpTo(parentId)
              }
              highlightKey={
                jumpHighlight?.messageId === message.id
                  ? jumpHighlight.key
                  : undefined
              }
              editRequestKey={
                editRequest?.messageId === message.id
                  ? editRequest.key
                  : undefined
              }
              onEditEnd={onEditEnd}
              readOnly={chat.messageRequest != null}
              compact={compact}
              animateIn={!wasShownBeforeConfirm(message)}
              senderLabel={
                chat.type === "group" && sender ? userLabel(sender) : undefined
              }
              senderHandle={
                chat.type === "group" && sender ? userHandle(sender) : undefined
              }
              senderAvatar={
                chat.type === "group" && sender && !isOwn
                  ? {
                      name: userAvatarName(sender),
                      avatarUrl: sender.avatarUrl,
                      avatarVariants: sender.avatarVariants,
                    }
                  : undefined
              }
              style={
                {
                  "--stagger-index": Math.min(i, 6),
                } as CSSProperties
              }
            />
          </Fragment>
        );
      })}
    </div>
  ));
}

// "X is typing…" under the messages. Its own component, subscribed to the
// typing store on its own, so a typing ping re-renders just this bubble —
// not the whole chat view and every message in it.
export function TypingIndicator({
  chatId,
  meId,
  showNames,
}: {
  chatId: number;
  meId: number;
  showNames: boolean;
}) {
  const typingUsers = useTypingUsers(chatId).filter((t) => t.userId !== meId);
  if (typingUsers.length === 0) return null;
  return (
    <div className="flex w-full justify-start motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-2 motion-safe:duration-300">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-muted-foreground shadow-sm">
        <TypingDots />
        {showNames && (
          <span className="text-xs">
            {typingUsers.map((t) => userLabel(t)).join(", ")}{" "}
            {typingUsers.length === 1 ? "is" : "are"} typing…
          </span>
        )}
      </div>
    </div>
  );
}
