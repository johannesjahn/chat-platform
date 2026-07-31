import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { parseMentions, useMentionedUsers } from "@/lib/mentions";
import { cn } from "@/lib/utils";

// Renders body text with `@username` mentions linked to the mentioned
// user's profile (issue #318).
//
// Every run — mention or not — is placed as a React text child, so the
// browser escapes it: content containing markup renders as literal
// characters, never as HTML (same guarantee `SearchHighlight` documents).
// The link's label is the literal `@username` from the source rather than
// the user's display name, so what's rendered still reads exactly like
// what was typed.
//
// A mention that doesn't resolve to an account renders as the plain text it
// already was, which also means the (asynchronous) lookup causes no layout
// pop: the same characters occupy the same place before and after it lands,
// they just gain a link.
export function MentionText({
  text,
  className,
}: {
  text: string;
  // Applied to the mention links only — the surrounding text is left to
  // whatever element the caller renders this inside of.
  className?: string;
}) {
  const segments = useMemo(() => parseMentions(text), [text]);
  const mentionedUsers = useMentionedUsers(text);

  return (
    <>
      {segments.map((segment, i) => {
        const user =
          segment.type === "mention"
            ? mentionedUsers.get(segment.username.toLowerCase())
            : undefined;
        return user ? (
          <Link
            key={i}
            to="/users/$id"
            params={{ id: String(user.id) }}
            // A mention can sit inside an element with its own pointer
            // handling (a chat bubble carries the long-press gesture that
            // reveals its action group) — following the link shouldn't also
            // set that off.
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "font-medium text-primary hover:underline",
              className,
            )}
          >
            {segment.text}
          </Link>
        ) : (
          <span key={i}>{segment.text}</span>
        );
      })}
    </>
  );
}
