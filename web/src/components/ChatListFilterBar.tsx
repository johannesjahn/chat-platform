import type { Dispatch, SetStateAction } from "react";
import { Search } from "lucide-react";
import type { ChatListFilter } from "@/components/ChatList";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SHOW_OPTIONS: ReadonlyArray<{
  value: ChatListFilter["show"];
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "groups", label: "Groups" },
];

/**
 * The chat list's quick filters — a name box and All / Unread / Groups —
 * above `ChatList`'s `filter`. Shared by the desktop list pane (issue #554)
 * and the phone `/chats` page (issue #763), so both filter the same way.
 */
export function ChatListFilterBar({
  filter,
  onChange,
  className,
}: {
  filter: ChatListFilter;
  onChange: Dispatch<SetStateAction<ChatListFilter>>;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          enterKeyHint="search"
          value={filter.query}
          onChange={(e) => {
            const query = e.target.value;
            onChange((prev) => ({ ...prev, query }));
          }}
          // There's nothing to submit — the list filters as you type — so
          // Enter (the on-screen keyboard's search key) just puts the
          // keyboard away to show the results.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.currentTarget.blur();
            }
          }}
          placeholder="Filter chats"
          aria-label="Filter chats"
          className="h-9 pl-8"
        />
      </div>
      <div
        role="radiogroup"
        aria-label="Show"
        className="flex gap-1 rounded-lg bg-background/50 p-0.5"
      >
        {SHOW_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={filter.show === option.value}
            onClick={() =>
              onChange((prev) => ({ ...prev, show: option.value }))
            }
            className={cn(
              // A little taller below `lg`, where it's tapped, not clicked.
              "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors lg:py-1",
              filter.show === option.value
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
