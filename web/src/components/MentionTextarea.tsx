import {
  type ComponentProps,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Avatar } from "@/components/Avatar";
import { Textarea } from "@/components/ui/textarea";
import { $api, MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import {
  type ActiveMention,
  activeMentionAt,
  applyMention,
  isMentionable,
} from "@/lib/mentions";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userAvatarName } from "@/lib/users";
import { cn } from "@/lib/utils";

// Keeps the popup to a glanceable size — `GET /users/search` already caps
// its own response, this just trims it further for the composer.
const MAX_SUGGESTIONS = 6;

type MentionTextareaProps = Omit<
  ComponentProps<typeof Textarea>,
  "value" | "onChange"
> & {
  value: string;
  onValueChange: (value: string) => void;
  // The popup is positioned against a wrapper element, which sits where the
  // bare `<textarea>` used to — so a caller that had layout classes on the
  // textarea (`flex-1`, a width) puts them here instead.
  containerClassName?: string;
};

// A `Textarea` that offers `@mention` autocomplete as you type (issue #318).
//
// The suggestion list reuses `GET /users/search`, which is why nothing is
// offered until the typed name reaches `MIN_USER_SEARCH_QUERY_LENGTH`
// characters (that floor is enforced server-side for non-admins — see issue
// #48); the popup says so rather than just sitting empty.
//
// While the list is open it consumes Enter/Tab/arrows/Escape, and only
// forwards other keys to the caller's `onKeyDown`. That matters because
// every composer using this binds Enter to "send" — picking a suggestion
// with Enter must complete the mention, not fire off a half-written
// message.
export function MentionTextarea({
  value,
  onValueChange,
  containerClassName,
  className,
  ref,
  onKeyDown,
  onSelect,
  onBlur,
  ...props
}: MentionTextareaProps) {
  const listId = useId();
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  // Where to put the caret once a picked suggestion has been rendered —
  // the value is controlled by the caller, so the selection can only be set
  // after the new text is actually in the DOM (see the effect below).
  const pendingCaret = useRef<number | null>(null);

  // Kept stable so React doesn't detach and reattach the DOM node's ref on
  // every keystroke — callers hold on to it (ChatComposer measures the
  // textarea to auto-grow it, and focuses it when a reply starts).
  const attachRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const [active, setActive] = useState<ActiveMention | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  // Escape closes the popup without closing over the mention itself, so it
  // has to stay closed until the token being typed changes.
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);

  const query = active?.query ?? "";
  const debouncedQuery = useDebouncedValue(query, 200);
  const searchable = debouncedQuery.length >= MIN_USER_SEARCH_QUERY_LENGTH;
  const { data, isFetching } = $api.useQuery(
    "get",
    "/users/search",
    { params: { query: { q: debouncedQuery } } },
    { enabled: active !== null && searchable },
  );

  // Only offer names that survive a round trip through the mention parser —
  // a username with, say, a space in it can't be written as `@name`, so
  // suggesting it would insert something that renders as plain text.
  const suggestions = (data ?? [])
    .filter((user) => isMentionable(user.username))
    .slice(0, MAX_SUGGESTIONS);

  // Suggestions lag the caret by the debounce interval; treat them as
  // stale (and don't act on Enter) until they match what's typed now.
  const current = active !== null && debouncedQuery === query;
  const hasSuggestions = current && searchable && suggestions.length > 0;
  const open = active !== null && dismissedQuery !== query;

  useEffect(() => {
    if (pendingCaret.current === null) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    const textarea = innerRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  });

  // Track the caret on every change *and* every selection move (arrow keys,
  // clicks) so the popup follows the mention the user is actually in.
  function syncActive(textarea: HTMLTextAreaElement) {
    const next = activeMentionAt(textarea.value, textarea.selectionStart ?? 0);
    setActive(next);
    if (next?.query !== query) setHighlighted(0);
  }

  function choose(username: string) {
    if (!active) return;
    const applied = applyMention(value, active, username);
    onValueChange(applied.text);
    pendingCaret.current = applied.caret;
    setActive(null);
    setHighlighted(0);
  }

  return (
    <div className={cn("relative", containerClassName)}>
      <Textarea
        {...props}
        ref={attachRef}
        value={value}
        className={className}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          hasSuggestions ? `${listId}-${highlighted}` : undefined
        }
        onChange={(e) => {
          onValueChange(e.target.value);
          syncActive(e.currentTarget);
        }}
        onSelect={(e) => {
          syncActive(e.currentTarget);
          onSelect?.(e);
        }}
        onBlur={(e) => {
          setActive(null);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (open && e.key === "Escape") {
            e.preventDefault();
            setDismissedQuery(query);
            return;
          }
          if (open && hasSuggestions) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlighted((i) => (i + 1) % suggestions.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlighted(
                (i) => (i - 1 + suggestions.length) % suggestions.length,
              );
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              const picked = suggestions[highlighted];
              if (picked) {
                e.preventDefault();
                choose(picked.username);
                return;
              }
            }
          }
          onKeyDown?.(e);
        }}
      />

      {open && (
        <div
          className="absolute bottom-full left-0 z-30 mb-1 w-64 max-w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150"
          // Keeping focus in the textarea means picking a suggestion with
          // the mouse doesn't blur it (which would close this first).
          onMouseDown={(e) => e.preventDefault()}
        >
          {!searchable ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Type at least {MIN_USER_SEARCH_QUERY_LENGTH} characters to find
              someone to mention.
            </p>
          ) : !current || isFetching ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Searching…
            </p>
          ) : suggestions.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No matching users.
            </p>
          ) : (
            <ul role="listbox" id={listId} aria-label="Mention a user">
              {suggestions.map((user, i) => (
                <li key={user.id}>
                  <button
                    type="button"
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === highlighted}
                    onMouseEnter={() => setHighlighted(i)}
                    onClick={() => choose(user.username)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                      i === highlighted && "bg-accent text-accent-foreground",
                    )}
                  >
                    <Avatar
                      name={userAvatarName(user)}
                      avatarUrl={user.avatarUrl}
                      avatarVariants={user.avatarVariants}
                      size="sm"
                    />
                    <span className="truncate font-medium">
                      @{user.username}
                    </span>
                    {user.displayName && (
                      <span className="truncate text-xs text-muted-foreground">
                        {user.displayName}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
