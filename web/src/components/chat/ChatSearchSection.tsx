import { useState } from "react";
import { Search } from "lucide-react";
import { DetailsSection } from "@/components/chat/DetailsSection";
import { SearchHighlight } from "@/components/SearchHighlight";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatChatTimestamp } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { MIN_SEARCH_QUERY_LENGTH, useSearchMessages } from "@/lib/search";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userLabel } from "@/lib/users";

/**
 * Search within one conversation (issue #900), in its details: picking a hit
 * scrolls the thread to it.
 */
export function ChatSearchSection({
  chatId,
  onJump,
}: {
  chatId: number;
  onJump: (messageId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 250);
  const searching = q.length >= MIN_SEARCH_QUERY_LENGTH;
  const { data, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useSearchMessages(q, searching, chatId);
  const results = data?.pages.flatMap((page) => page.results) ?? [];

  return (
    <DetailsSection
      index={0}
      icon={<Search className="size-4" />}
      title="Search in this chat"
    >
      <Input
        type="search"
        enterKeyHint="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        maxLength={100}
        placeholder="Search messages"
        aria-label="Search in this chat"
      />
      {!searching ? null : error ? (
        <p className="text-xs text-destructive">{errorMessage(error)}</p>
      ) : !data ? (
        <Skeleton className="h-10 w-full rounded-xl" />
      ) : results.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          No messages match.
        </p>
      ) : (
        <>
          <ul aria-label="Search results" className="flex flex-col gap-1">
            {results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => onJump(result.id)}
                  className="flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
                >
                  <span className="flex w-full items-center justify-between gap-2 text-xs">
                    <span className="truncate font-semibold text-primary">
                      {userLabel(result.sender)}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatChatTimestamp(result.createdAt)}
                    </span>
                  </span>
                  <SearchHighlight
                    snippet={result.snippet}
                    className="line-clamp-2 w-full break-words text-xs text-muted-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
          {hasNextPage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              Show more results
            </Button>
          )}
        </>
      )}
    </DetailsSection>
  );
}
