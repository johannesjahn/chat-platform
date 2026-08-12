import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { parseLinks } from "@/lib/linkify";
import { parseMentions, useMentionedUsers } from "@/lib/mentions";
import { cn } from "@/lib/utils";

// Renders body text with `@username` mentions linked to the mentioned
// user's profile (issue #318), and bare `http(s)` URLs turned into clickable
// links (issue #319).
//
// Every run — mention, link, or plain text — is placed as a React text
// child, so the browser escapes it: content containing markup renders as
// literal characters, never as HTML (same guarantee `SearchHighlight`
// documents). A mention's label is the literal `@username` from the source
// rather than the user's display name, so what's rendered still reads
// exactly like what was typed.
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
  // Applied to the mention and link anchors only — the surrounding text is
  // left to whatever element the caller renders this inside of.
  className?: string;
}) {
  const segments = useMemo(() => parseMentions(text), [text]);
  const mentionedUsers = useMentionedUsers(text);

  return (
    <>
      {segments.map((segment, i) => {
        if (segment.type === "mention") {
          const user = mentionedUsers.get(segment.username.toLowerCase());
          return user ? (
            <Link
              key={i}
              to="/users/$id"
              params={{ id: String(user.id) }}
              // A mention can sit inside an element with its own pointer
              // handling (a chat bubble carries the long-press gesture that
              // reveals its action group) — following the link shouldn't
              // also set that off.
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
        }

        // Plain-text runs are scanned for bare URLs so a shared link like
        // "https://example.com" is clickable wherever this component is
        // used (PostCard, CommentsSection, MessageBubble).
        return (
          <span key={i}>
            {parseLinks(segment.text).map((linkSegment, j) =>
              linkSegment.type === "link" ? (
                <a
                  key={j}
                  href={linkSegment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className={cn("text-primary hover:underline", className)}
                >
                  {linkSegment.text}
                </a>
              ) : (
                <span key={j}>{linkSegment.text}</span>
              ),
            )}
          </span>
        );
      })}
    </>
  );
}
