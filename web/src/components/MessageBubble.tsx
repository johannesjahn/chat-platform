import { type CSSProperties, useState } from "react";
import { Check, CheckCheck, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MESSAGE_COLLAPSE_THRESHOLD, type ChatMessage } from "@/lib/chats";

type MessageBubbleProps = {
  message: ChatMessage;
  isOwn: boolean;
  senderUsername?: string;
  isRead: boolean;
  style?: CSSProperties;
};

export function MessageBubble({
  message,
  isOwn,
  senderUsername,
  isRead,
  style,
}: MessageBubbleProps) {
  const isLongText =
    message.contentType === "text" &&
    message.content.length > MESSAGE_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLongText);

  return (
    <div
      data-message-id={message.id}
      style={style}
      className={cn(
        "flex w-full motion-safe:fill-mode-both motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300",
        isOwn
          ? "justify-end motion-safe:slide-in-from-right-2"
          : "justify-start motion-safe:slide-in-from-left-2",
      )}
    >
      <div
        className={cn(
          "flex max-w-[75%] flex-col gap-1 rounded-2xl px-3.5 py-2.5 shadow-sm transition-transform duration-200",
          isOwn
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm border border-border bg-card text-card-foreground",
        )}
      >
        {senderUsername && !isOwn && (
          <span className="text-xs font-semibold text-primary">
            @{senderUsername}
          </span>
        )}

        {message.contentType === "image_url" ? (
          <img
            src={message.content}
            alt=""
            loading="lazy"
            className="max-h-72 w-full rounded-lg bg-muted object-cover"
          />
        ) : (
          <>
            <p
              className={cn(
                "whitespace-pre-wrap break-words text-sm leading-relaxed",
                !expanded && "line-clamp-4",
              )}
            >
              {message.content}
            </p>
            {isLongText && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setExpanded((prev) => !prev)}
                className={cn(
                  "h-auto self-start p-0 text-xs",
                  isOwn && "text-primary-foreground underline",
                )}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="size-3.5" />
                    Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="size-3.5" />
                    Show more
                  </>
                )}
              </Button>
            )}
          </>
        )}

        <div
          className={cn(
            "flex items-center justify-end gap-1 text-[11px]",
            isOwn ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
          {isOwn &&
            (isRead ? (
              <CheckCheck className="size-3.5" />
            ) : (
              <Check className="size-3.5" />
            ))}
        </div>
      </div>
    </div>
  );
}
